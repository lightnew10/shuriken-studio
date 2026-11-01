import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { HealthCheckResult } from '@shared/domain';
import { McpStdioConnection } from '../mcp/mcp-client';
import type { CapabilityRegistry } from '../capabilities/capability-registry';
import { errorOutput, jsonOutput, type ToolRegistry } from '../capabilities/tool-registry';
import type { SkillService } from '../skills/skill-service';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import { seedKnowledge } from '../knowledge/seed';
import type { ScopedLogger } from '../log';
import type { EventBus } from '../events';

/**
 * A plugin is a folder with plugin.json. It can contribute:
 *  - mcpServers: external MCP servers (Blender, CAD tools, asset pipelines…) that become capabilities
 *  - skills: a folder of SKILL.md skills
 *  - knowledge: a folder of seed knowledge JSON
 * Plugins live in %APPDATA%/Shuriken Studio/plugins/<id>/. Nothing in core changes to add one.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; description?: string }>;
  skills?: string;
  knowledge?: string;
  /** 'allow': agents may call this plugin's tools freely (audited). 'ask': every call needs approval. */
  trust?: 'allow' | 'ask';
}

export interface PluginInfo {
  manifest: PluginManifest;
  dir: string;
  enabled: boolean;
  servers: Array<{ id: string; state: string; tools: number; error: string | null }>;
  error: string | null;
}

export class PluginService {
  private readonly plugins = new Map<string, PluginInfo>();
  private readonly connections = new Map<string, McpStdioConnection>();

  constructor(
    private readonly dir: string,
    private readonly deps: { tools: ToolRegistry; capabilities: CapabilityRegistry; skills: SkillService; knowledge: KnowledgeService; log: ScopedLogger; bus: EventBus; appVersion: string },
  ) {
    mkdirSync(dir, { recursive: true });
    this.registerTools();
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => ({
      ...p,
      servers: Object.keys(p.manifest.mcpServers ?? {}).map((sid) => {
        const c = this.connections.get(`${p.manifest.id}/${sid}`);
        return { id: sid, state: c?.state ?? 'disconnected', tools: c?.listTools().length ?? 0, error: c?.lastError ?? null };
      }),
    }));
  }

  /** Discover and load every plugin folder. Broken plugins are reported, never fatal. */
  async loadAll(): Promise<void> {
    for (const name of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      const dir = join(this.dir, name);
      const file = join(dir, 'plugin.json');
      if (!existsSync(file)) continue;
      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(readFileSync(file, 'utf8')) as PluginManifest;
        if (!manifest.id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(manifest.id)) throw new Error('plugin.json needs an "id" of lowercase letters, digits and hyphens');
      } catch (e) {
        this.plugins.set(name, { manifest: { id: name, name, version: '?' }, dir, enabled: false, servers: [], error: (e as Error).message });
        continue;
      }
      const info: PluginInfo = { manifest, dir, enabled: manifest.enabled !== false, servers: [], error: null };
      this.plugins.set(manifest.id, info);
      if (!info.enabled) continue;
      try {
        if (manifest.skills) this.deps.skills.addExtraDir(join(dir, manifest.skills));
        if (manifest.knowledge) seedKnowledge(this.deps.knowledge, dir, manifest.knowledge);
        for (const [sid, spec] of Object.entries(manifest.mcpServers ?? {})) this.connect(manifest, sid, spec);
      } catch (e) {
        info.error = (e as Error).message;
      }
    }
    this.deps.skills.reindex();
  }

  setEnabled(id: string, enabled: boolean): void {
    const p = this.plugins.get(id);
    if (!p) throw new Error(`Unknown plugin ${id}`);
    const file = join(p.dir, 'plugin.json');
    const manifest = { ...p.manifest, enabled };
    writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
    p.manifest = manifest;
    p.enabled = enabled;
    if (!enabled) {
      for (const sid of Object.keys(manifest.mcpServers ?? {})) {
        const key = `${id}/${sid}`;
        void this.connections.get(key)?.disconnect();
        this.connections.delete(key);
        this.deps.capabilities.setIntegrationStatus(`plugin:${key}`, 'unavailable', 'Plugin disabled');
      }
    } else {
      for (const [sid, spec] of Object.entries(manifest.mcpServers ?? {})) this.connect(manifest, sid, spec);
    }
  }

  private connect(manifest: PluginManifest, sid: string, spec: NonNullable<PluginManifest['mcpServers']>[string]): void {
    const key = `${manifest.id}/${sid}`;
    if (this.connections.has(key)) return;
    const integration = `plugin:${key}`;
    const conn = new McpStdioConnection(
      integration,
      async () => ({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd }),
      this.deps.log,
      (c) => {
        if (c.state === 'connected') {
          for (const t of c.listTools()) {
            this.deps.capabilities.upsert({
              id: `${integration}.${t.name}`,
              integration,
              name: t.title ?? t.name,
              status: 'healthy',
              description: t.description.split('\n')[0]!.slice(0, 300),
              version: c.serverInfo?.version ?? manifest.version,
              schema: t.inputSchema,
            });
          }
        } else if (c.state === 'failed') {
          this.deps.capabilities.setIntegrationStatus(integration, 'unavailable', c.lastError);
        }
      },
      { clientName: 'shuriken', clientVersion: this.deps.appVersion, autoReconnect: true },
    );
    this.connections.set(key, conn);
    void conn.connect();
  }

  async healthChecks(): Promise<HealthCheckResult[]> {
    const out: HealthCheckResult[] = [];
    for (const p of this.list()) {
      if (p.error) out.push({ id: `plugin.${p.manifest.id}`, name: p.manifest.name, status: 'unavailable', message: p.error, durationMs: 0 });
      else if (!p.enabled) out.push({ id: `plugin.${p.manifest.id}`, name: p.manifest.name, status: 'unknown', message: 'Disabled', durationMs: 0 });
      else
        for (const s of p.servers) {
          out.push({ id: `plugin.${p.manifest.id}.${s.id}`, name: `${p.manifest.name} · ${s.id}`, status: s.state === 'connected' ? 'healthy' : s.state === 'connecting' ? 'degraded' : 'unavailable', message: s.state === 'connected' ? `${s.tools} tools` : (s.error ?? s.state), durationMs: 0 });
        }
    }
    if (out.length === 0) out.push({ id: 'plugins.none', name: 'Plugins', status: 'healthy', message: `No plugins installed (folder: ${this.dir})`, durationMs: 0 });
    return out;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.disconnect().catch(() => {})));
  }

  /** Generic, audited access to plugin tools. Curated tools can be added per integration later. */
  private registerTools(): void {
    this.deps.tools.register({
      name: 'external_tools',
      title: 'List external tools',
      description: 'List tools provided by installed plugins (Blender, CAD, asset pipelines, other MCP servers) with their input schemas.',
      capability: 'app.plugins',
      permission: 'read',
      input: { server: z.string().optional().describe('plugin-id/server-id') },
      annotations: { readOnlyHint: true },
      handler: async ({ args }) => {
        const out: Array<{ server: string; state: string; tools: Array<{ name: string; description: string; inputSchema: unknown }> }> = [];
        for (const [key, c] of this.connections) {
          if (args.server && args.server !== key) continue;
          out.push({ server: key, state: c.state, tools: c.listTools().map((t) => ({ name: t.name, description: t.description.slice(0, 500), inputSchema: t.inputSchema })) });
        }
        return jsonOutput(out.length ? out : 'No external tool servers are installed or enabled.');
      },
    });
    this.deps.tools.register({
      name: 'external_call',
      title: 'Call external tool',
      description: 'Call a tool on a plugin-provided MCP server. Use external_tools first to see available tools and schemas.',
      capability: 'app.plugins',
      permission: 'write_project',
      input: { server: z.string().describe('plugin-id/server-id'), tool: z.string(), args: z.record(z.string(), z.unknown()).optional(), timeout_sec: z.number().optional() },
      handler: async ({ args, signal }) => {
        const c = this.connections.get(args.server);
        if (!c) return errorOutput(`Unknown external server ${args.server}`);
        const plugin = this.plugins.get(args.server.split('/')[0]!);
        if (plugin?.manifest.trust === 'ask') return errorOutput(`Plugin ${plugin.manifest.id} requires approval for every call; ask the user to change its trust setting.`);
        const r = await c.call(args.tool, args.args ?? {}, (args.timeout_sec ?? 120) * 1000, signal);
        this.deps.capabilities.record(`plugin:${args.server}.${args.tool}`, r.ok, r.error ?? null);
        if (!r.ok) return errorOutput(r.error ?? 'External tool failed');
        return {
          content: r.content.map((x) => (x.type === 'image' && typeof x.data === 'string' ? { type: 'image' as const, data: x.data, mimeType: String(x.mimeType ?? 'image/png') } : { type: 'text' as const, text: typeof x.text === 'string' ? x.text : JSON.stringify(x) })),
          data: r.structured,
        };
      },
    });
  }
}
