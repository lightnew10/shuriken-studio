import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Logger } from '../src/core/log';
import { ShurikenMcpServer, type McpContentProvider } from '../src/core/mcp/mcp-server';
import { textOutput, ToolRegistry, type CallerContext } from '../src/core/capabilities/tool-registry';
import { BurstReporter, isClosedStreamWrite } from '../src/core/util/rejections';

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const caller: CallerContext = { kind: 'agent', runId: 'run_a', taskId: null, role: 'critic', providerId: 'test', allowedTools: null };

/** What the process says about errors nobody handled while a test runs. */
function watchProcess() {
  const rejections: unknown[] = [];
  const exceptions: unknown[] = [];
  const rej = (e: unknown) => rejections.push(e);
  const exc = (e: unknown) => exceptions.push(e);
  process.on('unhandledRejection', rej);
  process.on('uncaughtException', exc);
  return {
    rejections,
    exceptions,
    stop: () => {
      process.off('unhandledRejection', rej);
      process.off('uncaughtException', exc);
    },
  };
}

describe('the MCP server when an agent goes away', () => {
  const logger = new Logger(null, null, 'warn');
  let mcp: ShurikenMcpServer;
  let started = 0;
  let stopped = 0;
  let release: () => void = () => {};
  let watch: ReturnType<typeof watchProcess>;

  beforeEach(async () => {
    started = 0;
    stopped = 0;
    watch = watchProcess();
    const tools = new ToolRegistry({ rules: () => ({}) as never, requestApproval: async () => true, notify: () => undefined }, { record: () => undefined }, logger.scope('tools'));
    tools.register({
      name: 'work_for_a_while',
      title: 'Work for a while',
      description: 'A tool call that is still running when its agent is stopped.',
      capability: 'test.work',
      permission: 'read',
      input: {},
      handler: async ({ signal }) => {
        started++;
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => {
            stopped++;
            resolve();
          });
        });
        return textOutput('finished');
      },
    });
    const content: McpContentProvider = { resources: () => [], templates: () => [], prompts: () => [], instructions: () => 'test' };
    mcp = new ShurikenMcpServer(tools, content, logger.scope('mcp'), { name: 'shuriken', version: 'test' });
    await mcp.start(0);
  });
  afterEach(async () => {
    watch.stop();
    await mcp.stop();
  });

  async function agent() {
    const token = mcp.issueToken(caller);
    const transport = new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(transport);
    return { token, client, transport };
  }
  const health = async () => (await fetch(mcp.url.replace('/mcp', '/health'))).json() as Promise<{ ok: boolean; sessions: number }>;

  it('ends a run\'s session when its token is revoked: its running call is stopped, and nothing is written to the dead connection', async () => {
    const { token, client, transport } = await agent();
    // (The agent's own call is left pending: a real agent is gone by now; its client would wait out its timeout.)
    const call = client.callTool({ name: 'work_for_a_while', arguments: {} }).then(
      () => 'answered',
      () => 'closed',
    );
    while (started === 0) await settle(20);
    expect(mcp.sessionCount()).toBe(1);
    mcp.revokeToken(token);
    // The call's handler is told to stop and the session is gone.
    while (stopped === 0) await settle(20);
    expect(mcp.sessionCount()).toBe(0);
    await settle();
    expect(watch.rejections).toEqual([]);
    expect(watch.exceptions).toEqual([]);
    expect(await health()).toMatchObject({ ok: true, sessions: 0 });
    // The token is dead: the same agent can't come back in.
    const again = new Client({ name: 'agent', version: '1' });
    await expect(again.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))).rejects.toThrow();
    await transport.close();
    await call;
  });

  it('survives an agent that vanishes mid-call and a tool that finishes afterwards', async () => {
    const { client, transport, token } = await agent();
    const call = client.callTool({ name: 'work_for_a_while', arguments: {} }).catch(() => 'gone');
    while (started === 0) await settle(20);
    // The agent's process dies: its connections are cut with the call still running.
    await transport.close();
    await call;
    // The tool finishes only now and wants to answer.
    release();
    await settle(500);
    mcp.revokeToken(token);
    await settle();
    expect(watch.rejections).toEqual([]);
    expect(watch.exceptions).toEqual([]);
    expect(await health()).toMatchObject({ ok: true });
    expect(mcp.sessionCount()).toBe(0);
  });

  it('survives a client that drops the socket in the middle of a request body', async () => {
    const { port, hostname } = new URL(mcp.url);
    const token = mcp.issueToken(caller);
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const socket = connect({ host: hostname, port: Number(port) }, () => {
          socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"jsonrpc":"2.0","method":"init`);
          setTimeout(() => socket.destroy(), 20);
        });
        socket.on('error', () => {});
        socket.on('close', () => resolve());
      });
    }
    await settle();
    expect(watch.rejections).toEqual([]);
    expect(watch.exceptions).toEqual([]);
    expect(await health()).toMatchObject({ ok: true });
  });
});

describe('closed-stream rejections', () => {
  it("recognizes Node's own error for a write to a stream that closed a moment before, and nothing else", () => {
    let bytes!: ReadableByteStreamController;
    new ReadableStream({ type: 'bytes', start: (c) => void (bytes = c) });
    bytes.close();
    let fromBytes: unknown;
    try {
      bytes.enqueue(new Uint8Array(1));
    } catch (e) {
      fromBytes = e;
    }
    let plain!: ReadableStreamDefaultController<number>;
    new ReadableStream<number>({ start: (c) => void (plain = c) });
    plain.close();
    let fromDefault: unknown;
    try {
      plain.enqueue(1);
    } catch (e) {
      fromDefault = e;
    }
    expect(isClosedStreamWrite(fromBytes)).toBe(true);
    expect(isClosedStreamWrite(fromDefault)).toBe(true);
    expect(isClosedStreamWrite(new TypeError('Invalid state: ReadableStream is already closed'))).toBe(false); // no code: not Node's
    expect(isClosedStreamWrite(Object.assign(new TypeError('Invalid state: reader released'), { code: 'ERR_INVALID_STATE' }))).toBe(false);
    expect(isClosedStreamWrite(new Error('boom'))).toBe(false);
    expect(isClosedStreamWrite(null)).toBe(false);
  });

  it('reports a burst once, then a summary per interval', () => {
    let now = 1000;
    const r = new BurstReporter(10_000, () => now);
    expect(r.hit()).toBe(1); // the first at once
    now += 20;
    expect([r.hit(), r.hit(), r.hit()]).toEqual([0, 0, 0]); // the storm stays quiet
    now += 10_000;
    expect(r.hit()).toBe(4); // the summary: three quiet ones and this one
    expect(r.hit()).toBe(0);
  });
});
