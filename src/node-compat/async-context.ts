/**
 * The async context AsyncLocalStorage reads: which store each instance has
 * in the code running now, carried across `await`, timers, nextTick,
 * queueMicrotask and promise callbacks, as node does with async hooks.
 *
 * The page has no async hooks (and no AsyncContext), so:
 *  - a frame (instance → store) is current while code runs; run(),
 *    enterWith() and snapshot() replace it (frames are never mutated once
 *    made, so a captured one stays as it was);
 *  - `await X` in the code a process loads becomes
 *    `__shiroAls.r(__shiroAls.c(), await X)`: the frame before the await is
 *    the frame after it (an async function resumes from the microtask queue,
 *    where any frame may be current);
 *  - callbacks queued from code (timers, nextTick, queueMicrotask, then())
 *    run in the frame they were queued from.
 * Nothing changes until a process makes an AsyncLocalStorage (`active`).
 * Next.js keeps its request and work stores this way across its awaits.
 */
import { codeMask } from '../commands/jseval/module-transform';

type Frame = Map<object, unknown> | undefined;
let current: Frame;
let active = false;

export const asyncContext = {
  get active(): boolean { return active; },
  /** A process made an AsyncLocalStorage: from now on code it loads carries frames */
  activate(): void {
    if (active) return;
    active = true;
    patchThen();
  },
  get(key: object): unknown { return current?.get(key); },
  /** Run fn with key's store set to `store` (or removed: `remove`) */
  with<T>(key: object, store: unknown, fn: () => T, remove = false): T {
    const prev = current;
    const next = new Map(prev);
    if (remove) next.delete(key); else next.set(key, store);
    current = next;
    try { return fn(); } finally { current = prev; }
  },
  /** key's store for the rest of this synchronous run and what it queues */
  enter(key: object, store: unknown): void {
    const next = new Map(current);
    next.set(key, store);
    current = next;
  },
  capture(): Frame { return current; },
  /** Run fn in a captured frame */
  inFrame<T>(frame: Frame, fn: () => T): T {
    const prev = current;
    current = frame;
    try { return fn(); } finally { current = prev; }
  },
  /** cb, to run later in the frame current now (unchanged when nothing uses async context) */
  bind<F extends (...a: any[]) => any>(cb: F): F {
    if (!active || typeof cb !== 'function') return cb;
    const frame = current;
    return function (this: unknown, ...a: any[]) {
      const prev = current;
      current = frame;
      try { return cb.apply(this, a); } finally { current = prev; }
    } as F;
  },
};

// What rewritten code calls: c() before an await, r(frame, value) after it, and e(code)
// on what it evals (webpack's dev builds wrap every module in eval("…"))
(globalThis as any).__shiroAls = {
  c: (): Frame => current,
  r: <T>(frame: Frame, value: T): T => { current = frame; return value; },
  e: (code: unknown): unknown => typeof code === 'string' ? carryAsyncContext(code) : code,
};

let thenPatched = false;
/** then() callbacks (catch and finally call then) and queueMicrotask (React's scheduler) run in the frame they were queued from */
function patchThen(): void {
  if (thenPatched) return;
  thenPatched = true;
  const then = Promise.prototype.then;
  Promise.prototype.then = function (this: Promise<unknown>, a?: any, b?: any) {
    return then.call(this, asyncContext.bind(a), asyncContext.bind(b));
  } as typeof then;
  const qm = globalThis.queueMicrotask;
  if (typeof qm === 'function') globalThis.queueMicrotask = (cb: VoidFunction) => qm(asyncContext.bind(cb));
}

const ID = /[A-Za-z0-9_$\u0080-￿]/;

/** Whether code from `src` gets carryAsyncContext: once a process uses AsyncLocalStorage, or when `src` does */
export function carriesAsyncContext(src: string): boolean {
  return active || src.includes('AsyncLocalStorage');
}

/**
 * `await X` → `__shiroAls.r(__shiroAls.c(), await X)`, in code only. An await
 * whose operand isn't a plain unary/member/call expression (one starting
 * with a string, template or regex literal, a function or class) is left
 * as it is. A direct `eval(X)` becomes `eval(__shiroAls.e(X))` (still direct:
 * the code it runs is rewritten the same way when it runs).
 */
export function carryAsyncContext(src: string, codeMaskOfSrc?: Uint8Array): string {
  if (!src.includes('await') && !src.includes('eval')) return src;
  const mask = codeMaskOfSrc ?? codeMask(src);
  const n = src.length;
  const isCode = (i: number) => mask[i] === 1;
  // Whitespace and comments (a comment is a run of non-code from `//` or `/*`)
  const skipWs = (i: number) => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (i < n && !isCode(i) && (src.startsWith('//', i) || src.startsWith('/*', i))) { while (i < n && !isCode(i)) i++; continue; }
      return i;
    }
  };
  const close: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const matchBracket = (i: number): number => {
    let depth = 0;
    for (let j = i; j < n; j++) {
      if (!isCode(j)) continue;
      const c = src[j];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return j + 1; }
    }
    return -1;
  };
  const word = (i: number) => { let j = i; while (j < n && ID.test(src[j])) j++; return src.slice(i, j); };

  /** End of the unary expression at i, or -1 */
  const unary = (i: number, guard = 0): number => {
    if (guard > 50) return -1;
    i = skipWs(i);
    if (i >= n || !isCode(i)) return -1;
    const c = src[i];
    if (c === '!' || c === '~' || ((c === '+' || c === '-') && src[i + 1] !== c)) return unary(i + 1, guard + 1);
    const w = word(i);
    if (w === 'await' || w === 'typeof' || w === 'void' || w === 'delete' || w === 'new') return unary(i + w.length, guard + 1);
    if (w === 'function' || w === 'class' || w === 'async' || w === 'yield') return -1;
    let j: number;
    if (c === '(' || c === '[' || c === '{') j = matchBracket(i);
    else if (w) j = i + w.length;
    else return -1;
    if (j < 0) return -1;
    // Member accesses, calls and indexes after it (across whitespace and newlines, as JS reads them)
    for (;;) {
      const k = skipWs(j);
      if (k >= n || !isCode(k)) return j;
      if (src[k] === '.' && src[k + 1] !== '.' ) {
        const m = skipWs(k + 1);
        const pw = src[m] === '#' ? '#' + word(m + 1) : word(m);
        if (!pw || /^[0-9]/.test(pw)) return j;
        j = m + pw.length;
      } else if (src[k] === '?' && src[k + 1] === '.' && !/[0-9]/.test(src[k + 2] ?? '')) {
        const m = skipWs(k + 2);
        if (src[m] === '(' || src[m] === '[') { j = matchBracket(m); if (j < 0) return -1; }
        else { const pw = word(m); if (!pw) return j; j = m + pw.length; }
      } else if (src[k] === '(' || src[k] === '[') {
        j = matchBracket(k);
        if (j < 0) return -1;
      } else if (src[k] === '`') {
        return -1;
      } else return j;
    }
  };

  /** The word before position p (across whitespace) */
  const wordBefore = (p: number) => {
    let b = p - 1;
    while (b >= 0 && /\s/.test(src[b])) b--;
    let a = b;
    while (a >= 0 && ID.test(src[a])) a--;
    return src.slice(a + 1, b + 1);
  };
  /** `NAME(…) {` or `get NAME()`: a method, accessor or function named NAME, not a call (rollup's `get await()`) */
  const definesName = (p: number, open: number) => {
    if (/^(get|set|static|async|function)$/.test(wordBefore(p))) return true;
    if (src[open] !== '(') return false;
    const end = matchBracket(open);
    return end > 0 && src[skipWs(end)] === '{';
  };

  const inserts: [number, string][] = [];
  const re = /\bawait\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const p = m.index;
    if (!isCode(p) || src[p - 1] === '.' || ID.test(src[p - 1] ?? '') || ID.test(src[p + 5] ?? '')) continue;
    // `for await (`, and `await` as a name in sloppy code
    let b = p - 1;
    while (b >= 0 && /\s/.test(src[b])) b--;
    if (src.slice(Math.max(0, b - 2), b + 1) === 'for' && !ID.test(src[b - 3] ?? '')) continue;
    const a = skipWs(p + 5);
    if (a >= n || /[=,;)\]}:?]/.test(src[a]) && !(src[a] === '?' && src[a + 1] === '.')) continue;
    if (definesName(p, a)) continue;
    const e = unary(p + 5);
    if (e < 0) continue;
    inserts.push([p, '__shiroAls.r(__shiroAls.c(), '], [e, ')']);
  }
  const ev = /\beval\s*\(/g;
  for (let m = ev.exec(src); m; m = ev.exec(src)) {
    const p = m.index;
    if (!isCode(p) || src[p - 1] === '.' || ID.test(src[p - 1] ?? '')) continue;
    const open = p + m[0].length - 1;
    const end = matchBracket(open);
    if (end < 0 || skipWs(open + 1) === end - 1 || definesName(p, open)) continue;
    inserts.push([open + 1, '__shiroAls.e('], [end - 1, ')']);
  }
  if (!inserts.length) return src;
  // Ends before starts at one position: `await await x` closes the inner one first
  inserts.sort((x, y) => x[0] - y[0] || (x[1] === ')' ? -1 : 1) - (y[1] === ')' ? -1 : 1));
  let out = '';
  let last = 0;
  for (const [pos, text] of inserts) { out += src.slice(last, pos) + text; last = pos; }
  return out + src.slice(last);
}
