import { z } from 'zod';
import type { McpContentProvider } from './mcp-server';
import type { ProjectContext } from '../projects/project-service';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import type { SkillService } from '../skills/skill-service';
import type { CapabilityRegistry } from '../capabilities/capability-registry';
import type { ContextCompiler } from '../context/context-compiler';
import { roleFor } from '../agents/roles';

export interface McpContentDeps {
  project: () => ProjectContext | null;
  knowledge: KnowledgeService;
  skills: SkillService;
  capabilities: CapabilityRegistry;
  compiler: ContextCompiler;
}

/**
 * Resources and prompts exposed by the Shuriken MCP server. Any MCP client (Claude Code, a future
 * Codex adapter, the user's own tools) gets the same stable view of project state.
 */
export function createMcpContent(d: McpContentDeps): McpContentProvider {
  const need = () => {
    const p = d.project();
    if (!p) throw new Error('No project open');
    return p;
  };
  return {
    instructions: (caller) =>
      [
        'Shuriken MCP server: the capability boundary between AI agents and the Shuriken Roblox development environment.',
        'Project state (tasks, knowledge, research, decisions, tests) is authoritative here — record results through these tools.',
        'Code lives on disk; use roblox_sync_push to load it into Studio. Use capabilities_query before relying on a Studio capability.',
        caller.taskId ? `Your current task id: ${caller.taskId}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    resources: () => [
      {
        name: 'project-overview',
        uri: 'shuriken://project/overview',
        title: 'Project overview',
        description: 'Open project, objectives and task status.',
        mimeType: 'text/markdown',
        read: async () => {
          const p = d.project();
          if (!p) return 'No project open.';
          const tasks = p.tasks.list();
          const objectives = tasks.filter((t) => t.kind === 'objective');
          return `# ${p.summary.name}\n\nRoot: ${p.root}\n\n## Objectives\n${objectives.map((o) => `- [${o.status}] ${o.title}`).join('\n') || '(none)'}\n\n## Tasks\n${tasks
            .filter((t) => t.kind !== 'objective')
            .map((t) => `- [${t.status}] ${t.title} (${t.role})`)
            .join('\n') || '(none)'}`;
        },
      },
      {
        name: 'project-spec',
        uri: 'shuriken://project/spec',
        title: 'Project specification',
        description: 'Living project specification.',
        mimeType: 'text/markdown',
        read: async () =>
          need()
            .governance.spec()
            .map((s) => `## ${s.title} (${s.status}, v${s.version})\n\n${s.body || '_empty_'}`)
            .join('\n\n'),
      },
      {
        name: 'project-decisions',
        uri: 'shuriken://project/decisions',
        title: 'Architectural decisions',
        description: 'Decision records (ADRs).',
        mimeType: 'text/markdown',
        read: async () =>
          need()
            .governance.decisions()
            .map((x) => `## ${x.title} [${x.status}]\n\n${x.decision}\n\n_Consequences:_ ${x.consequences}`)
            .join('\n\n') || 'No decisions recorded.',
      },
      {
        name: 'capabilities',
        uri: 'shuriken://capabilities',
        title: 'Capability registry',
        description: 'Every capability with status, version, limitations and reliability.',
        mimeType: 'application/json',
        read: async () => JSON.stringify(d.capabilities.list().map((c) => ({ id: c.id, status: c.status, version: c.version, limitations: c.limitations, ok: c.successCount, failed: c.failureCount })), null, 2),
      },
    ],
    templates: () => [
      {
        name: 'task',
        template: 'shuriken://tasks/{id}',
        title: 'Task',
        description: 'A task with evidence and failures.',
        mimeType: 'application/json',
        read: async ({ id }) => {
          const p = need();
          const t = p.tasks.get(id!);
          return JSON.stringify(t ? { ...t, evidence: p.tasks.evidence(t.id), failures: p.tasks.failures(t.id) } : { error: 'not found' }, null, 2);
        },
      },
      {
        name: 'knowledge',
        template: 'shuriken://knowledge/{id}',
        title: 'Knowledge entry',
        description: 'Knowledge entry with provenance.',
        mimeType: 'application/json',
        read: async ({ id }) => JSON.stringify(d.knowledge.get(id!) ?? { error: 'not found' }, null, 2),
      },
      {
        name: 'skill',
        template: 'shuriken://skills/{name}',
        title: 'Skill',
        description: 'Procedural knowledge for specialized work.',
        mimeType: 'text/markdown',
        list: async () => d.skills.list().map((s) => ({ uri: `shuriken://skills/${s.name}`, name: s.name })),
        read: async ({ name }) => {
          const s = d.skills.get(name!);
          return s ? `# ${s.name}\n\n${s.description}\n\n${s.body}` : 'Skill not found';
        },
      },
    ],
    prompts: () => [
      {
        name: 'task_context',
        title: 'Compiled task context',
        description: 'The context package Shuriken would give a specialist for a task.',
        args: { task_id: z.string(), role: z.string().optional() },
        build: async (args) => {
          const p = need();
          const task = p.tasks.get(args.task_id!);
          if (!task) return `Unknown task ${args.task_id}`;
          const pkg = d.compiler.compile(p, { runId: `prompt-${Date.now()}`, role: roleFor(args.role ?? task.role), task, directive: 'Work on this task using the Shuriken tools.' });
          return pkg.text;
        },
      },
    ],
  };
}
