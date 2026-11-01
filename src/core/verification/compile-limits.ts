import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LuauProblem } from '../roblox/luau-toolchain';

/**
 * What Studio's Luau compiler refuses and the project's analyzers (selene, luau-lsp) let through: more than 200 local
 * variables alive at once in one function. Studio then won't run the script at all ("Out of local registers when
 * trying to allocate …: exceeded limit 200"). In the Pit build a worker reported that Combat.client.luau no longer
 * compiled, and the tasks that touched combat kept passing their checks; the user heard "Combat is currently broken"
 * forty minutes later. A script's top level is a function too, and a long client script that declares everything
 * there (177 top-level locals in that one) is where this happens.
 *
 * This is a small tokenizer, not a parser: it follows blocks (function, do, then, repeat … end/until), counts the
 * names each `local`, `for` and function signature declares, and keeps the most alive at once per function.
 */

/** The most locals Luau allows alive at once in one function (Compiler.cpp, kMaxLocalCount). */
export const MAX_LOCALS = 200;

type Tok = { k: 'id' | 'sym' | 'str' | 'num'; v: string; line: number };

/** Luau's tokens without comments and string contents (enough to follow blocks and declarations). */
export function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  // The end of a long bracket "[==[" … "]==]" starting at `at` (the index after it), or -1.
  const longEnd = (at: number): number => {
    const m = /^\[(=*)\[/.exec(src.slice(at, at + 64));
    if (!m) return -1;
    const close = `]${m[1]}]`;
    const end = src.indexOf(close, at + m[0].length);
    return end < 0 ? n : end + close.length;
  };
  const advance = (to: number) => {
    for (let j = i; j < to && j < n; j++) if (src.charCodeAt(j) === 10) line++;
    i = to;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      const end = src[i + 2] === '[' ? longEnd(i + 2) : -1;
      if (end > 0) advance(end);
      else {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? n : nl;
      }
      continue;
    }
    if (c === '[' && (src[i + 1] === '[' || src[i + 1] === '=')) {
      const end = longEnd(i);
      if (end > 0) {
        out.push({ k: 'str', v: '', line });
        advance(end);
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      out.push({ k: 'str', v: '', line });
      advance(Math.min(n, j + 1));
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      out.push({ k: 'num', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      out.push({ k: 'sym', v: '...', line });
      i += 3;
      continue;
    }
    if (src.startsWith('::', i) || src.startsWith('->', i) || src.startsWith('==', i) || src.startsWith('~=', i) || src.startsWith('<=', i) || src.startsWith('>=', i)) {
      out.push({ k: 'sym', v: src.slice(i, i + 2), line });
      i += 2;
      continue;
    }
    out.push({ k: 'sym', v: c, line });
    i++;
  }
  return out;
}

const OPEN: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };

/**
 * Where a type annotation that starts at `i` ends (the index of the first token after it): a name with dots and
 * generics, a table or function type, `?`, unions and intersections. Good enough for declarations.
 */
function skipType(t: Tok[], i: number): number {
  const one = (j: number): number => {
    const tok = t[j];
    if (!tok) return j;
    if (tok.v === 'typeof' && t[j + 1]?.v === '(') return skipGroup(t, j + 1);
    if (tok.v === '(' ) {
      let k = skipGroup(t, j);
      if (t[k]?.v === '->') k = one(k + 1);
      return k;
    }
    if (tok.v === '{') return skipGroup(t, j);
    if (tok.k === 'str' || tok.v === 'nil' || tok.v === 'true' || tok.v === 'false' || tok.v === '...') return j + 1;
    if (tok.k === 'id') {
      let k = j + 1;
      while (t[k]?.v === '.' && t[k + 1]?.k === 'id') k += 2;
      if (t[k]?.v === '<') k = skipGroup(t, k);
      return k;
    }
    return j;
  };
  let k = one(i);
  for (;;) {
    while (t[k]?.v === '?') k++;
    if (t[k]?.v === '|' || t[k]?.v === '&') k = one(k + 1);
    else return k;
  }
}

/** The index after the bracket group that opens at `i`. */
function skipGroup(t: Tok[], i: number): number {
  const open = t[i]!.v;
  const close = OPEN[open]!;
  let depth = 0;
  for (let k = i; k < t.length; k++) {
    if (t[k]!.v === open) depth++;
    else if (t[k]!.v === close || (open === '<' && t[k]!.v === '>=')) {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return t.length;
}

interface Fn {
  live: number;
  max: number;
  /** The line of the local that went over the limit (null: it never did). */
  over: number | null;
  name: string;
}
interface Block {
  locals: number;
  fn: Fn | null;
  /** The block of an if statement's branch: its `end` closes the if too. */
  ifBranch?: boolean;
}

/**
 * Tokens after which `if` starts an expression (`x = if a then b else c`, Luau's if-expression: no `end`, and its
 * `then`/`else` open no block). After anything else it starts a statement.
 */
const EXPRESSION_BEFORE = new Set(['=', '(', ',', '{', '[', 'return', 'and', 'or', 'not', '..', '+', '-', '*', '/', '%', '^', '#', '==', '~=', '<', '>', '<=', '>=', 'in', 'until', 'while', 'elseif', 'if']);

/** The functions of a script that have more than MAX_LOCALS locals alive at once: where the first one too many is. */
export function localLimitOverruns(src: string): Array<{ line: number; function: string; locals: number }> {
  const t = tokens(src);
  const top: Fn = { live: 0, max: 0, over: null, name: 'the top level of the script' };
  const fns: Fn[] = [top];
  const blocks: Block[] = [{ locals: 0, fn: top }];
  const fnOf = (): Fn => {
    for (let b = blocks.length - 1; b >= 0; b--) if (blocks[b]!.fn) return blocks[b]!.fn!;
    return top;
  };
  const declare = (count: number, line: number) => {
    if (count <= 0) return;
    const f = fnOf();
    blocks[blocks.length - 1]!.locals += count;
    f.live += count;
    if (f.live > MAX_LOCALS && f.over === null) f.over = line;
    f.max = Math.max(f.max, f.live);
  };
  const pop = () => {
    if (blocks.length <= 1) return;
    const b = blocks.pop()!;
    const f = b.fn ?? fnOf();
    f.live -= b.locals;
  };
  /** Locals of a `for` waiting for its `do`. */
  let forVars = 0;
  /** The ifs not finished yet, innermost last: statements (closed by end) and expressions (done at their else). */
  const ifs: Array<'stmt' | 'expr'> = [];
  /** The token index of the last else that ended an if-expression. */
  let exprElse = -1;

  // A function's parameters, from the "(" at `i`: returns the index after ")" and the count.
  const params = (i: number): [number, number] => {
    let count = 0;
    let k = i + 1;
    let expectName = true;
    while (k < t.length && t[k]!.v !== ')') {
      const tok = t[k]!;
      if (expectName && tok.k === 'id') {
        count++;
        expectName = false;
        k++;
        if (t[k]?.v === ':') k = skipType(t, k + 1);
        continue;
      }
      if (tok.v === '...') {
        k++;
        if (t[k]?.v === ':') k = skipType(t, k + 1);
        continue;
      }
      if (tok.v === ',') expectName = true;
      if (OPEN[tok.v] && tok.v !== '<') {
        k = skipGroup(t, k);
        continue;
      }
      k++;
    }
    return [k + 1, count];
  };

  const startFunction = (i: number): number => {
    // function a.b.c:d<T>(params) / function(params)
    let k = i + 1;
    let name = 'a function';
    let method = false;
    if (t[k]?.k === 'id') {
      const parts = [t[k]!.v];
      k++;
      while ((t[k]?.v === '.' || t[k]?.v === ':') && t[k + 1]?.k === 'id') {
        if (t[k]!.v === ':') method = true;
        parts.push(t[k + 1]!.v);
        k += 2;
      }
      name = `function ${parts.join('.')}`;
    }
    if (t[k]?.v === '<') k = skipGroup(t, k);
    if (t[k]?.v !== '(') return i + 1;
    const fn: Fn = { live: 0, max: 0, over: null, name };
    fns.push(fn);
    blocks.push({ locals: 0, fn });
    const [after, count] = params(k);
    declare(count + (method ? 1 : 0), t[k]!.line);
    // A return type annotation.
    if (t[after]?.v === ':') return skipType(t, after + 1);
    return after;
  };

  let i = 0;
  while (i < t.length) {
    const tok = t[i]!;
    if (tok.k !== 'id') {
      i++;
      continue;
    }
    switch (tok.v) {
      case 'local': {
        if (t[i + 1]?.v === 'function') {
          declare(1, tok.line);
          i = startFunction(i + 1);
          break;
        }
        // local a: T, b, c = …
        let k = i + 1;
        let count = 0;
        while (t[k]?.k === 'id') {
          count++;
          k++;
          if (t[k]?.v === '<' && t[k + 1]?.k === 'id' && t[k + 2]?.v === '>') k += 3; // attributes
          if (t[k]?.v === ':') k = skipType(t, k + 1);
          if (t[k]?.v !== ',') break;
          k++;
        }
        declare(count, tok.line);
        i = k;
        break;
      }
      case 'function':
        i = startFunction(i);
        break;
      case 'for': {
        let k = i + 1;
        let count = 0;
        while (t[k]?.k === 'id') {
          count++;
          k++;
          if (t[k]?.v === ':') k = skipType(t, k + 1);
          if (t[k]?.v !== ',') break;
          k++;
        }
        forVars = count;
        i = k;
        break;
      }
      case 'do': {
        blocks.push({ locals: 0, fn: null });
        const vars = forVars;
        forVars = 0;
        declare(vars, tok.line);
        i++;
        break;
      }
      case 'if': {
        // An if after `=`, `(`, `return`… is an expression (no end); after `then`/`else` it is one when the if those
        // belong to is.
        const before = t[i - 1]?.v ?? '';
        const expr = EXPRESSION_BEFORE.has(before) || (before === 'then' && ifs.at(-1) === 'expr') || (before === 'else' && exprElse === i - 1);
        ifs.push(expr ? 'expr' : 'stmt');
        i++;
        break;
      }
      case 'then':
        if (ifs.at(-1) !== 'expr') blocks.push({ locals: 0, fn: null, ifBranch: true });
        i++;
        break;
      case 'repeat':
        blocks.push({ locals: 0, fn: null });
        i++;
        break;
      case 'elseif':
        if (ifs.at(-1) !== 'expr') pop();
        i++;
        break;
      case 'else':
        // An if-expression has said all it has once it reaches its else: what follows is its last value (which may be
        // another if-expression: "else if b then 1 else 2").
        if (ifs.at(-1) === 'expr') {
          ifs.pop();
          exprElse = i;
        } else {
          pop();
          blocks.push({ locals: 0, fn: null, ifBranch: true });
        }
        i++;
        break;
      case 'end':
      case 'until':
        if (blocks.at(-1)?.ifBranch) ifs.pop();
        pop();
        i++;
        break;
      default:
        i++;
    }
  }
  return fns.filter((f) => f.over !== null).map((f) => ({ line: f.over!, function: f.name, locals: f.max }));
}

/**
 * The compile errors of these project files (project-relative paths) that the analyzers don't report, as problems of
 * the static analysis. Files that are gone or aren't Luau are skipped.
 */
export function compileProblems(root: string, files: Iterable<string>): LuauProblem[] {
  const out: LuauProblem[] = [];
  for (const f of new Set(files)) {
    if (!/\.(?:luau|lua)$/i.test(f)) continue;
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    let src: string;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const o of localLimitOverruns(src)) {
      out.push({
        tool: 'compile',
        file: f.replace(/\\/g, '/'),
        line: o.line,
        column: 1,
        severity: 'error',
        code: 'LocalLimit',
        message: `Out of local registers: ${o.function} has ${o.locals} locals alive at once (Luau allows ${MAX_LOCALS}); Studio won't compile this script. Move groups of locals into tables or do-blocks, or split the script.`,
      });
    }
  }
  return out;
}
