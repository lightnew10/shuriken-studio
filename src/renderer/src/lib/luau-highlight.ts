// Luau tokens for the read-only script view (comments and long strings can span lines).

export type TokKind = 'kw' | 'lit' | 'str' | 'com' | 'num' | 'glob' | 'call' | 'prop' | 'txt';
export interface Tok {
  k: TokKind;
  s: string;
}

const KEYWORDS = new Set(['and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'export', 'for', 'function', 'if', 'in', 'local', 'not', 'or', 'repeat', 'return', 'then', 'type', 'typeof', 'until', 'while', 'self']);
const LITERALS = new Set(['true', 'false', 'nil']);
const GLOBALS = new Set([
  'game', 'workspace', 'script', 'shared', '_G', 'plugin',
  'task', 'math', 'string', 'table', 'os', 'coroutine', 'buffer', 'utf8', 'bit32', 'debug',
  'print', 'warn', 'error', 'assert', 'require', 'pairs', 'ipairs', 'next', 'select', 'unpack', 'tostring', 'tonumber', 'pcall', 'xpcall', 'setmetatable', 'getmetatable', 'rawget', 'rawset', 'rawequal', 'rawlen', 'newproxy', 'gcinfo', 'tick', 'time', 'wait', 'delay', 'spawn',
  'Instance', 'Vector3', 'Vector2', 'CFrame', 'Color3', 'BrickColor', 'UDim', 'UDim2', 'Enum', 'Ray', 'Rect', 'Region3', 'TweenInfo', 'NumberSequence', 'NumberSequenceKeypoint', 'ColorSequence', 'ColorSequenceKeypoint', 'NumberRange', 'RaycastParams', 'OverlapParams', 'PhysicalProperties', 'Random', 'DateTime', 'Font', 'Axes', 'Faces', 'PathWaypoint', 'Content',
]);

/** Tokens of a whole Luau source (comments and long strings can span lines). */
export function tokenizeLuau(src: string): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  const push = (k: TokKind, s: string) => {
    const last = out[out.length - 1];
    if (last && last.k === k && k === 'txt') last.s += s;
    else out.push({ k, s });
  };
  /** `[[`, `[=[`, …: the level and where the body starts, or null. */
  const longOpen = (at: number): { level: number; body: number } | null => {
    let j = at + 1;
    while (src[j] === '=') j++;
    return src[j] === '[' ? { level: j - at - 1, body: j + 1 } : null;
  };
  const longEnd = (o: { level: number; body: number }) => {
    const close = `]${'='.repeat(o.level)}]`;
    const e = src.indexOf(close, o.body);
    return e < 0 ? n : e + close.length;
  };
  const NUM = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/y;
  const ID = /[A-Za-z_][A-Za-z0-9_]*/y;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === '-' && src[i + 1] === '-') {
      const o = src[i + 2] === '[' ? longOpen(i + 2) : null;
      let j = o ? longEnd(o) : src.indexOf('\n', i);
      if (j < 0) j = n;
      push('com', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '[') {
      const o = longOpen(i);
      if (o) {
        const j = longEnd(o);
        push('str', src.slice(i, j));
        i = j;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (j < n && src[j] === c) j++;
      push('str', src.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1]! >= '0' && src[i + 1]! <= '9')) {
      NUM.lastIndex = i;
      const m = NUM.exec(src);
      if (m && m[0]) {
        push('num', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      ID.lastIndex = i;
      const w = ID.exec(src)![0];
      let before = i - 1;
      while (before >= 0 && (src[before] === ' ' || src[before] === '\t')) before--;
      const member = before >= 0 && (src[before] === '.' || src[before] === ':') && src[before - 1] !== '.';
      let after = i + w.length;
      while (after < n && (src[after] === ' ' || src[after] === '\t')) after++;
      const called = src[after] === '(' || (member && (src[after] === '"' || src[after] === '{'));
      const k: TokKind = KEYWORDS.has(w) ? 'kw' : LITERALS.has(w) ? 'lit' : member ? (called ? 'call' : 'prop') : GLOBALS.has(w) ? 'glob' : called ? 'call' : 'txt';
      push(k, w);
      i += w.length;
      continue;
    }
    push('txt', c);
    i++;
  }
  return out;
}

/** Tokens split into lines. */
export function luauLines(src: string): Tok[][] {
  const lines: Tok[][] = [[]];
  for (const t of tokenizeLuau(src.replace(/\r/g, ''))) {
    const parts = t.s.split('\n');
    parts.forEach((p, idx) => {
      if (idx > 0) lines.push([]);
      if (p) lines[lines.length - 1]!.push({ k: t.k, s: p });
    });
  }
  return lines;
}
