/**
 * Line-level three-way merge (diff3 -m): a script changed both in its file and in Studio since the last
 * sync keeps both changes when they touch different lines; overlapping changes become a conflict block
 * (git's diff3 markers) for an agent to resolve.
 */

export interface Merge3Result {
  text: string;
  conflicts: number;
}

export const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

/** Above this many compared lines (after trimming what's shared) the middle counts as rewritten. */
const MAX_CELLS = 16_000_000;

export function merge3(base: string, ours: string, theirs: string, labels = { ours: 'yours (the file)', base: 'last sync', theirs: 'Studio (edited there since the last sync)' }): Merge3Result {
  const o = lines(base);
  const a = lines(ours);
  const b = lines(theirs);
  const ids = new Map<string, number>();
  const id = (xs: string[]) => Int32Array.from(xs, (x) => {
    let v = ids.get(x);
    if (v === undefined) ids.set(x, (v = ids.size));
    return v;
  });
  const io = id(o);
  const ma = matchLines(io, id(a));
  const mb = matchLines(io, id(b));
  const out: string[] = [];
  let conflicts = 0;
  let lo = 0;
  let la = 0;
  let lb = 0;
  while (lo < o.length || la < a.length || lb < b.length) {
    // The next base line both sides kept: everything before it is one changed region.
    let i = lo;
    while (i < o.length && (ma[i]! < 0 || mb[i]! < 0)) i++;
    const ea = i < o.length ? ma[i]! : a.length;
    const eb = i < o.length ? mb[i]! : b.length;
    if (i === lo && ea === la && eb === lb) {
      out.push(o[lo]!);
      lo++;
      la++;
      lb++;
      continue;
    }
    const oc = o.slice(lo, i);
    const ac = a.slice(la, ea);
    const bc = b.slice(lb, eb);
    if (same(ac, oc)) out.push(...bc);
    else if (same(bc, oc) || same(ac, bc)) out.push(...ac);
    else {
      conflicts++;
      out.push(`<<<<<<< ${labels.ours}`, ...ac, `||||||| ${labels.base}`, ...oc, '=======', ...bc, `>>>>>>> ${labels.theirs}`);
    }
    lo = i;
    la = ea;
    lb = eb;
  }
  return { text: out.join('\n'), conflicts };
}

function lines(s: string): string[] {
  return s.replace(/\r\n/g, '\n').split('\n');
}

function same(x: string[], y: string[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** For each line of `o`, the line of `x` it matches in a longest common subsequence (or -1). */
function matchLines(o: Int32Array, x: Int32Array): Int32Array {
  const m = new Int32Array(o.length).fill(-1);
  let pre = 0;
  while (pre < o.length && pre < x.length && o[pre] === x[pre]) {
    m[pre] = pre;
    pre++;
  }
  let suf = 0;
  while (suf < o.length - pre && suf < x.length - pre && o[o.length - 1 - suf] === x[x.length - 1 - suf]) {
    m[o.length - 1 - suf] = x.length - 1 - suf;
    suf++;
  }
  const n = o.length - pre - suf;
  const k = x.length - pre - suf;
  if (n === 0 || k === 0 || (n + 1) * (k + 1) > MAX_CELLS) return m;
  // Suffix LCS lengths, then a forward walk that takes matches greedily.
  const w = k + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i * w + j] = o[pre + i] === x[pre + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < k) {
    if (o[pre + i] === x[pre + j] && dp[i * w + j] === dp[(i + 1) * w + j + 1]! + 1) {
      m[pre + i] = pre + j;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return m;
}
