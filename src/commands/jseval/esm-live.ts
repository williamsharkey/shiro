/**
 * Live ES module bindings for esbuild code-split chunks.
 *
 * transformESModules turns `import { a } from './x.js'` into a destructuring
 * of require()'s result, which copies `a` once. esbuild's split chunks rely on
 * ESM bindings being live: a chunk exports `var ValueType;` that only its
 * lazily run `__esm` initializer assigns, and other chunks read it at top
 * level after calling that initializer (Gemini CLI's
 * `valueType: ValueType.INT`). Copies made at import time are undefined.
 *
 * For a chunk (it imports esbuild's runtime helpers from a sibling), this
 * pass:
 * - exports `export { a, b as c }` as getters on module.exports, hoisted to
 *   the top of the module, instead of copying the values at its end;
 * - reads named imports through the imported module's exports object
 *   (`a` → `__shiro_liveN.a`, calls as `(0, __shiro_liveN.a)(…)`).
 * esbuild gives every top-level symbol a chunk-unique name and renames
 * nested bindings that would shadow one (`exports2`, `ValueType2`), so an
 * identifier with an imported name is the import. Positions this pass can't
 * classify keep the old copied binding, which the import transform still
 * declares.
 */
import { codeMask } from './module-transform';

const HELPER_IMPORT = /\bimport\s*\{[^}]*\b(?:__esm|__export|__commonJS|__toESM|__toCommonJS)\b[^}]*\}\s*from\s*['"]\.\.?\//;
const NAMED_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g;
const LOCAL_EXPORT = /\bexport\s*\{([^}]*)\}\s*;?/g;
const OBJECT_AFTER_WORD = new Set(['const', 'let', 'var', 'return', 'typeof', 'in', 'of', 'yield', 'await', 'new', 'delete', 'void', 'throw', 'case']);
const MEMBER_PREFIX = new Set(['get', 'set', 'static', 'async']);

export function isEsbuildChunk(src: string): boolean {
  return HELPER_IMPORT.test(src);
}

const isIdentStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
const isIdent = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57);

export function liveEsbuildChunk(src: string): string {
  if (!isEsbuildChunk(src)) return src;
  const mask = codeMask(src);
  const inCode = (i: number) => mask[i] === 1;

  // Named imports: local name -> [module index, imported name]; their text ranges are left alone
  const modules: string[] = [];
  const locals = new Map<string, [number, string]>();
  const skip: [number, number][] = [];
  for (const m of src.matchAll(NAMED_IMPORT)) {
    if (!inCode(m.index!)) continue;
    const idx = modules.push(m[3]) - 1;
    for (const item of m[1].split(',')) {
      const t = item.trim();
      if (!t) continue;
      const as = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(t);
      if (as) locals.set(as[2], [idx, as[1]]);
      else if (/^[\w$]+$/.test(t)) locals.set(t, [idx, t]);
    }
    skip.push([m.index!, m.index! + m[0].length]);
  }

  // Local export lists become getters; the statements are removed
  const getters: string[] = [];
  const removals: [number, number][] = [];
  for (const m of src.matchAll(LOCAL_EXPORT)) {
    if (!inCode(m.index!)) continue;
    // `export { x } from 'y'` is a re-export, handled by the regular transform
    if (/^\s*from\b/.test(src.slice(m.index! + m[0].length))) continue;
    if (/\bfrom\s*['"]$/.test(m[0])) continue;
    for (const item of m[1].split(',')) {
      const t = item.trim();
      if (!t) continue;
      const as = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(t);
      const [local, name] = as ? [as[1], as[2]] : [t, t];
      if (!/^[\w$]+$/.test(local)) continue;
      // re-exporting an import stays live too
      const imp = locals.get(local);
      const value = imp ? `__shiro_live${imp[0]}.${imp[1]}` : local;
      getters.push(`${JSON.stringify(name)}: { get: () => ${value}, set(v) { Object.defineProperty(this, ${JSON.stringify(name)}, { value: v, writable: true, enumerable: true, configurable: true }); }, enumerable: true, configurable: true }`);
    }
    removals.push([m.index!, m.index! + m[0].length]);
  }
  if (!locals.size && !getters.length) return src;

  const out: string[] = [];
  let last = 0;
  const emit = (from: number, to: number, text: string) => { out.push(src.slice(last, from), text); last = to; };
  // At the top of the module: the getters first (a dependency loaded below
  // may call back into this module), then each imported module's exports
  // object, which is its live namespace even while its body is still
  // running. `(__shiro_require)(…)` is not rewritten to wait for that body
  // (compileAsyncModule); the import statements themselves still wait.
  const header = (getters.length ? `Object.defineProperties(__shiro_module.exports, {${getters.join(', ')}}); ` : '')
    + (modules.length ? 'var ' + modules.map((m, k) => `__shiro_live${k} = (__shiro_require)(${JSON.stringify(m)})`).join(', ') + ';' : '');
  out.push(header);

  // Bracket stack: '(' '[' or '{' tagged object (o), block (b) or class body (c)
  const stack: string[] = [];
  let prev = '';        // last significant code character ('w' after a word, 'a' after a literal)
  let prevWord = '';
  let classDepth = -1;  // stack depth where a `class` keyword's body `{` will open
  let skipI = 0, remI = 0;
  const len = src.length;
  let i = 0;
  while (i < len) {
    if (skipI < skip.length && i === skip[skipI][0]) {
      i = skip[skipI++][1]; prev = ';'; prevWord = '';
      continue;
    }
    if (remI < removals.length && i === removals[remI][0]) { emit(i, removals[remI][1], ''); i = removals[remI][1]; remI++; prev = ';'; continue; }
    if (!inCode(i)) {
      // a comment keeps `prev`; a string, template or regex literal is a value
      const c0 = src[i];
      const comment = c0 === '/' && (src[i + 1] === '/' || src[i + 1] === '*');
      while (i < len && !inCode(i)) i++;
      if (!comment) { prev = 'a'; prevWord = ''; }
      continue;
    }
    const c = src.charCodeAt(i);
    const ch = src[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') { i++; continue; }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdent(src.charCodeAt(j))) j++;
      const word = src.slice(i, j);
      const hit = locals.get(word);
      if (hit && src[i - 1] !== '#' && (prev !== '.' || src.slice(i - 3, i) === '...')) {
        const rep = replacement(word, hit, i, j);
        if (rep !== null) emit(i, j, rep);
      }
      if (word === 'class') classDepth = stack.length;
      prev = 'w';
      prevWord = word;
      i = j;
      continue;
    }
    if (c >= 48 && c <= 57) {
      // number literal (keeps `1e5`, `0x1f` together)
      let j = i + 1;
      while (j < len && (isIdent(src.charCodeAt(j)) || src[j] === '.')) j++;
      prev = 'a'; prevWord = ''; i = j;
      continue;
    }
    if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch === '{') {
      if (classDepth === stack.length) { stack.push('c'); classDepth = -1; }
      else stack.push(isObjectBrace() ? 'o' : 'b');
    } else if (ch === ')' || ch === ']' || ch === '}') stack.pop();
    prev = ch === '>' && src[i - 1] === '=' ? '=>' : ch;
    prevWord = '';
    i++;
  }
  out.push(src.slice(last));

  function isObjectBrace(): boolean {
    if (prev === 'w') return OBJECT_AFTER_WORD.has(prevWord);
    if (prev === '=>') return false;
    return '([,=:?!&|+-*%<>~^'.includes(prev) && prev !== '';
  }

  function nextChar(j: number): string {
    while (j < len && (src[j] === ' ' || src[j] === '\n' || src[j] === '\t' || src[j] === '\r')) j++;
    return src[j] ?? '';
  }

  /** The text for an imported identifier at [i, j), or null to keep the copied binding. */
  function replacement(word: string, [idx, name]: [number, string], _i: number, j: number): string | null {
    const ref = `__shiro_live${idx}.${name}`;
    const next = nextChar(j);
    const top = stack[stack.length - 1];
    const memberPos = prev === '{' || prev === ',' || prev === ';' || prev === '}';
    // `get name() {}`, `static x`, `async *gen()`: the keyword, when an import is named like it
    if (MEMBER_PREFIX.has(word) && ((top === 'o' && (prev === '{' || prev === ',')) || (top === 'c' && memberPos))
      && (/[A-Za-z_$\[*'"#]/.test(next) || next.charCodeAt(0) > 127)) return null;
    if (top === 'o' && (prev === '{' || prev === ',')) {
      if (next === ':' || next === '(') return null;      // key or method
      if (next === ',' || next === '}') return `${word}: ${ref}`; // shorthand property
    }
    if (top === 'o' && prev === 'w' && MEMBER_PREFIX.has(prevWord)) return null;
    if (top === 'c' && (memberPos || (prev === 'w' && MEMBER_PREFIX.has(prevWord)) || prev === '*')) return null;
    if (prev === 'w' && /^(?:function|class|var|let|const|import|export)$/.test(prevWord)) return null;
    if (next === ':' && (prev === '{' || prev === ';' || prev === '}' || prev === '')) return null; // label
    if (next === '(' || next === '`') return `(0, ${ref})`;
    return ref;
  }

  return out.join('');
}
