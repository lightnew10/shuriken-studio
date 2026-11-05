/**
 * End-to-end local smoke: two independent WebSocket clients talk through a real
 * Cloudflare Worker + Durable Object (no Cloudflare account and no AI calls).
 * Usage: npm run smoke in collaboration/relay.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const port = 19373;
const httpUrl = 'http://127.0.0.1:' + port;
const key = randomBytes(32).toString('hex');
const guestKey = randomBytes(32).toString('hex');
const room = createHash('sha256').update(key).digest('hex').slice(0, 32);
const wsUrl = 'ws://127.0.0.1:' + port + '/room/' + room;
const worker = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
worker.stdout.on('data', (b) => { logs = (logs + b.toString()).slice(-2000); });
worker.stderr.on('data', (b) => { logs = (logs + b.toString()).slice(-2000); });
const sockets = [];
async function ready() {
  for (let i = 0; i < 50; i++) {
    if (worker.exitCode !== null) throw new Error('Wrangler terminated early: ' + logs);
    try {
      const res = await fetch(httpUrl + '/health', { signal: AbortSignal.timeout(800) });
      if (res.ok && (await res.json()).service === 'shuriken-collaboration') return;
    } catch { /* booting */ }
    await delay(300);
  }
  throw new Error('Timed out waiting for relay: ' + logs);
}
function waitFor(socket, match, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for frame: ' + logs)); }, timeout);
    const handler = (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        if (!match(data)) return;
        cleanup();
        resolve(data);
      } catch { /* another frame */ }
    };
    const closed = (ev) => { cleanup(); reject(new Error('Socket closed: ' + ev.code + ' ' + ev.reason)); };
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener('message', handler);
      socket.removeEventListener('close', closed);
    }
    socket.addEventListener('message', handler);
    socket.addEventListener('close', closed);
  });
}
async function open(name, role, secret, joinSecret) {
  const socket = new WebSocket(wsUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not open ' + role + ' socket')), { once: true });
  });
  const welcomed = waitFor(socket, (f) => f.type === 'welcome');
  socket.send(JSON.stringify({ v: 1, type: 'hello', role, secret, name, ...(joinSecret ? { joinSecret } : {}) }));
  return { socket, welcome: await welcomed };
}
try {
  await ready();
  const { socket: host, welcome: owner } = await open('Host', 'host', key, guestKey);
  if (owner.self.role !== 'host') throw new Error('Host authentication rejected');
  const hostMessage = waitFor(host, (f) => f.type === 'payload' && f.data?.kind === 'chat');
  const { socket: guest, welcome: member } = await open('Guest', 'guest', guestKey);
  if (member.self.role !== 'guest') throw new Error('Guest authentication rejected');
  guest.send(JSON.stringify({ v: 1, type: 'payload', data: {
    kind: 'chat', message: { id: 'collab-test-001', from: 'spoofed', sender: 'Hacker', text: 'Hello', at: new Date().toISOString() },
  } }));
  const received = await hostMessage;
  if (received.data.message.sender !== 'Guest' || received.data.message.from !== member.self.id)
    throw new Error('Relay did not authenticate the chat author');
  const denial = waitFor(guest, (f) => f.type === 'error');
  guest.send(JSON.stringify({ v: 1, type: 'payload', data: { kind: 'history', messages: [] } }));
  await denial;
  const project = waitFor(guest, (f) => f.type === 'payload' && f.data?.kind === 'project-status');
  host.send(JSON.stringify({ v: 1, type: 'payload', data: { kind: 'project-status', name: 'Impulse Simulator', projectId: 'game01', taskCount: 42 } }));
  if ((await project).data.taskCount !== 42) throw new Error('Project metadata not synchronized');
  console.log('PASS: authenticated host/guest, attested chat, role guard and project status');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) try { socket.close(); } catch { /* closed */ }
  worker.kill('SIGTERM');
  await delay(500);
}
