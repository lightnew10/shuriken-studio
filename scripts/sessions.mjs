#!/usr/bin/env node
/**
 * Review Shuriken Studio session journals.
 *
 *   npm run sessions                 list sessions (newest first) with their counters
 *   npm run sessions -- --last       the latest session: summary, flags, errors, chat
 *   npm run sessions -- <id>         one session by id (or a prefix)
 *   npm run sessions -- <id> --timeline   its agent runs in order: start, length, turns, cost, and
 *                                    time per role (where a slow build spent its time)
 *   npm run sessions -- --errors     every error across sessions
 *   npm run sessions -- --flags      everything flagged as sub-par across sessions
 *
 * Journals live in <data dir>/sessions (default %APPDATA%/Shuriken Studio/sessions; override with
 * SHURIKEN_DATA_DIR). See docs/SESSIONS.md for what is recorded.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.env.SHURIKEN_DATA_DIR ?? join(process.env.APPDATA ?? join(process.env.HOME ?? '.', '.config'), 'Shuriken Studio');
const root = join(dataDir, 'sessions');
if (!existsSync(root)) {
  console.log(`No sessions yet (${root}).`);
  process.exit(0);
}
const ids = readdirSync(root).filter((d) => existsSync(join(root, d, 'session.json'))).sort().reverse();
const read = (id, f) => {
  const p = join(root, id, f);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};
const meta = (id) => {
  try {
    return JSON.parse(read(id, 'session.json'));
  } catch {
    return null;
  }
};
const args = process.argv.slice(2);

if (args.includes('--errors')) {
  for (const id of ids) {
    const e = read(id, 'errors.log').trim();
    if (e) console.log(`\n=== ${id} ===\n${e}`);
  }
  process.exit(0);
}
if (args.includes('--flags')) {
  for (const id of ids) {
    const s = read(id, 'summary.md');
    const flags = s.split('## Needs attention')[1]?.split('Files:')[0]?.trim();
    if (flags && !flags.includes('Nothing flagged')) console.log(`\n=== ${id} ===\n${flags}`);
  }
  process.exit(0);
}
const pick = args.includes('--last') ? ids[0] : args.find((a) => !a.startsWith('--'));
if (pick) {
  const id = ids.find((x) => x === pick || x.startsWith(pick));
  if (!id) {
    console.log(`No session matching ${pick}`);
    process.exit(1);
  }
  if (args.includes('--timeline')) {
    timeline(id);
    process.exit(0);
  }
  console.log(read(id, 'summary.md'));
  const errors = read(id, 'errors.log').trim();
  if (errors) console.log(`\n## Errors\n\n${errors.slice(-8000)}`);
  const chat = read(id, 'chat.md').trim();
  if (chat) console.log(`\n## Chat\n\n${chat.slice(-12000)}`);
  const shots = existsSync(join(root, id, 'screens')) ? readdirSync(join(root, id, 'screens')) : [];
  if (shots.length) console.log(`\n## Screens (${join(root, id, 'screens')})\n\n${shots.join('\n')}`);
  console.log(`\nAll events: ${join(root, id, 'events.jsonl')}`);
  process.exit(0);
}
console.log(`Sessions in ${root}\n`);
for (const id of ids) {
  const m = meta(id);
  const c = m?.counters ?? {};
  const abandoned = read(id, 'events.jsonl').includes('"session.abandoned"');
  console.log(
    `${id}  ${(m?.projects ?? []).join(', ') || '—'}  · chat ${c.userMessages ?? 0}/${c.directorMessages ?? 0} · runs ${c.runsOk ?? 0} ok ${c.runsFailed ?? 0} failed · tasks ${c.tasksDone ?? 0} done ${c.tasksFailed ?? 0} failed · errors ${c.errors ?? 0}${abandoned ? ' · ENDED UNCLEANLY' : ''}`,
  );
}

/** Agent runs of one session in start order, and the time per role. */
function timeline(id) {
  const events = read(id, 'events.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!events.length) return console.log('No events recorded.');
  const t0 = Date.parse(events[0].ts);
  const started = new Map();
  const rows = [];
  for (const e of events) {
    if (e.kind === 'run.started') started.set(e.data.id, e);
    if (e.kind !== 'run.finished') continue;
    const s = started.get(e.data.id);
    rows.push({ at: s ? (Date.parse(s.ts) - t0) / 1000 : NaN, s: Math.round((e.data.ms ?? 0) / 1000), turns: e.data.turns ?? 0, cost: e.data.costUsd ?? 0, role: e.data.role, status: e.data.status, task: `${s?.data?.continues ? '(continued) ' : ''}${e.data.task ?? ''}`.slice(0, 60) });
  }
  rows.sort((a, b) => a.at - b.at);
  const pad = (v, n) => String(v).padStart(n);
  const clock = (sec) => (Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '?');
  console.log(`Runs in ${id} (m:ss from the session start)\n`);
  console.log(' start   length turns    cost  role             status       task');
  for (const r of rows) console.log(`${pad(clock(r.at), 6)} ${pad(clock(r.s), 8)} ${pad(r.turns, 5)} ${pad('$' + r.cost.toFixed(2), 7)}  ${r.role.padEnd(16)} ${r.status.padEnd(12)} ${r.task}`);
  const by = new Map();
  for (const r of rows) {
    const b = by.get(r.role) ?? { n: 0, s: 0, turns: 0, cost: 0 };
    by.set(r.role, { n: b.n + 1, s: b.s + r.s, turns: b.turns + r.turns, cost: b.cost + r.cost });
  }
  console.log('\nBy role:');
  for (const [role, b] of [...by].sort((x, y) => y[1].s - x[1].s)) console.log(`  ${role.padEnd(16)} ${pad(b.n, 3)} runs  ${pad(clock(b.s), 7)} total  ${pad(Math.round(b.s / b.n), 5)} s avg  ${pad((b.turns / b.n).toFixed(1), 5)} turns/run  $${b.cost.toFixed(2)}`);
}
