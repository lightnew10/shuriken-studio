import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** The official Codex app-server model/list catalog. It is not proof of account entitlement. */
export interface CodexModelOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export const isAllowedCodexModel = (id: string, name = id): boolean =>
  /^[a-zA-Z0-9._:-]{1,128}$/.test(id) && !/astra/i.test(id) && !/astra/i.test(name);

type ModelListResponse = {
  data?: Array<{ id?: string; model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean }>;
  nextCursor?: string | null;
};

/** Preserve the official catalog ordering, exclude hidden and Astra model entries. */
export function codexModelOptions(response: ModelListResponse): CodexModelOption[] {
  const seen = new Set<string>();
  return (response.data ?? []).flatMap((entry) => {
    const id = entry.model || entry.id || '';
    const name = entry.displayName || id;
    if (entry.hidden || !isAllowedCodexModel(id, name) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, isDefault: entry.isDefault === true }];
  });
}

/**
 * Reads only model metadata; this never invokes inference or spends model quota.
 * App-server is a JSONL RPC service. Initialize before model/list, then close.
 */
export async function loadCodexModels(): Promise<CodexModelOption[]> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        windowsHide: true,
        shell: process.platform === 'win32',
        stdio: 'pipe',
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let output = '';
    let diagnostic = '';
    const listed: CodexModelOption[] = [];
    const seen = new Set<string>();
    let pages = 0;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(listed);
    };
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    const nextPage = (cursor?: string | null) => {
      if (pages >= 5) return finish();
      pages++;
      send({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    };
    const processMessage = (line: string) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line) as typeof msg; } catch { return; }
      if (msg.id === 1) {
        if (msg.error) return finish(new Error(msg.error.message || 'Codex app-server initialization failed'));
        send({ method: 'initialized', params: {} });
        nextPage();
      } else if (msg.id === 2) {
        if (msg.error) return finish(new Error(msg.error.message || 'Codex model/list failed'));
        const result = (msg.result ?? {}) as ModelListResponse;
        for (const item of codexModelOptions(result)) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          listed.push(item);
        }
        if (result.nextCursor) nextPage(result.nextCursor);
        else finish();
      }
    };
    const timeout = setTimeout(() => finish(new Error('Codex model catalog timed out after 20 seconds')), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      // A catalog response should never exceed this bound.
      if (output.length > 2_000_000) return finish(new Error('Codex model catalog exceeded size limit'));
      let end: number;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end).trim();
        output = output.slice(end + 1);
        if (line) processMessage(line);
        if (settled) return;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-1000); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (!settled) finish(new Error('Codex app-server exited before model/list completed (' + code + '): ' + diagnostic));
    });
    child.stdin.on('error', () => undefined);
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'shuriken_studio', title: 'Shuriken Studio', version: '1.0.0' } },
    });
  });
}
