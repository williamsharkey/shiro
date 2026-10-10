import { isEsbuildChunk, liveEsbuildChunk } from './esm-live';
// ES module ↔ CommonJS transform utilities (pure string transforms, no side effects)

// ── TypeScript type stripping ──────────────────────────────────────────────

/** Strip balanced braces starting at pos (which must be '{'), returns index after closing '}' */
function skipBalancedBraces(src: string, pos: number): number {
  let depth = 0;
  const len = src.length;
  while (pos < len) {
    const ch = src[pos];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return pos + 1; }
    else if (ch === "'" || ch === '"' || ch === '`') { pos = skipString(src, pos); continue; }
    else if (ch === '/' && pos + 1 < len) {
      if (src[pos + 1] === '/') { pos = src.indexOf('\n', pos); if (pos < 0) return len; continue; }
      if (src[pos + 1] === '*') { pos = src.indexOf('*/', pos + 2); if (pos < 0) return len; pos += 2; continue; }
    }
    pos++;
  }
  return len;
}

/** Skip a string literal (single, double, or template) starting at pos */
function skipString(src: string, pos: number): number {
  const q = src[pos];
  pos++;
  const len = src.length;
  if (q === '`') {
    let depth = 0;
    while (pos < len) {
      if (src[pos] === '\\') { pos += 2; continue; }
      if (src[pos] === '$' && pos + 1 < len && src[pos + 1] === '{') { depth++; pos += 2; continue; }
      if (src[pos] === '}' && depth > 0) { depth--; pos++; continue; }
      if (src[pos] === '`' && depth === 0) return pos + 1;
      pos++;
    }
    return len;
  }
  while (pos < len) {
    if (src[pos] === '\\') { pos += 2; continue; }
    if (src[pos] === q) return pos + 1;
    pos++;
  }
  return len;
}

/** Preserve strings and comments, replacing with placeholders. Returns [modified src, restore fn] */
function preserveStringsAndComments(src: string): [string, (s: string) => string] {
  const saved: string[] = [];
  let out = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(src, i);
      saved.push(src.substring(i, end));
      out += `___PRESERVE_${saved.length - 1}___`;
      i = end;
    } else if (ch === '/' && i + 1 < len && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl >= 0 ? nl : len;
      saved.push(src.substring(i, end));
      out += `___PRESERVE_${saved.length - 1}___`;
      i = end;
    } else if (ch === '/' && i + 1 < len && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const commentEnd = end >= 0 ? end + 2 : len;
      saved.push(src.substring(i, commentEnd));
      out += `___PRESERVE_${saved.length - 1}___`;
      i = commentEnd;
    } else {
      out += ch;
      i++;
    }
  }
  const restore = (s: string) => s.replace(/___PRESERVE_(\d+)___/g, (_, idx) => saved[parseInt(idx)]);
  return [out, restore];
}

/**
 * Strip TypeScript type syntax from source code (synchronous string transform).
 * Handles: interfaces, type aliases, enums, declare blocks, type annotations,
 * as-casts, non-null assertions, generics, type-only imports.
 */
export function transformTS(src: string): string {
  const [safe, restore] = preserveStringsAndComments(src);
  let s = safe;

  // Strip interface/type/enum/declare blocks
  s = s.replace(/\b(export\s+)?interface\s+[\w$<>,\s]+\{/g, (match) => {
    return '___STRIP_BLOCK___' + '{';
  });
  s = s.replace(/\b(export\s+)?type\s+([\w$]+)\s*(<[^>]*>)?\s*=\s*/g, (match) => {
    return '___STRIP_STATEMENT___';
  });
  s = s.replace(/\b(export\s+)?(const\s+)?enum\s+[\w$]+\s*\{/g, () => {
    return '___STRIP_BLOCK___' + '{';
  });
  s = s.replace(/\bdeclare\s+(module|const|function|class|var|let|type|interface|enum|namespace|global)\b[^{;]*/g, (match) => {
    return '___STRIP_DECL___';
  });

  // Process stripped blocks (balanced brace removal)
  let iterations = 0;
  while (s.includes('___STRIP_BLOCK___') && iterations++ < 50) {
    const idx = s.indexOf('___STRIP_BLOCK___');
    const braceStart = s.indexOf('{', idx);
    if (braceStart < 0) { s = s.replace('___STRIP_BLOCK___', ''); continue; }
    const after = skipBalancedBraces(s, braceStart);
    s = s.substring(0, idx) + s.substring(after);
  }

  // Process stripped statements (remove to next semicolon or newline)
  while (s.includes('___STRIP_STATEMENT___')) {
    const idx = s.indexOf('___STRIP_STATEMENT___');
    let end = idx + '___STRIP_STATEMENT___'.length;
    // Find the end of the type alias (handle balanced braces in object types)
    let depth = 0;
    while (end < s.length) {
      const ch = s[end];
      if (ch === '{' || ch === '(' || ch === '<') depth++;
      else if (ch === '}' || ch === ')' || ch === '>') depth--;
      else if (ch === ';' && depth <= 0) { end++; break; }
      else if (ch === '\n' && depth <= 0) { break; }
      end++;
    }
    s = s.substring(0, idx) + s.substring(end);
  }

  // Process stripped declarations (to semicolon or brace block)
  while (s.includes('___STRIP_DECL___')) {
    const idx = s.indexOf('___STRIP_DECL___');
    let end = idx + '___STRIP_DECL___'.length;
    // Skip whitespace
    while (end < s.length && /\s/.test(s[end])) end++;
    if (end < s.length && s[end] === '{') {
      end = skipBalancedBraces(s, end);
    } else {
      // Find semicolon or newline
      while (end < s.length && s[end] !== ';' && s[end] !== '\n') end++;
      if (end < s.length && s[end] === ';') end++;
    }
    s = s.substring(0, idx) + s.substring(end);
  }

  // Strip inline `type` keyword from imports: import { type Foo, Bar } → import { Bar }
  s = s.replace(/\{\s*type\s+[\w$]+\s*,/g, (m) => '{');
  s = s.replace(/,\s*type\s+[\w$]+\s*([,}])/g, '$1');
  s = s.replace(/\{\s*type\s+[\w$]+\s*\}/g, '{}');

  // Strip generic type parameters before '(' in function calls/declarations
  // e.g., function f<T>( → function f(
  //        foo<string>( → foo(
  s = s.replace(/<[\w$\s,\[\]|&?:=.]+>(?=\s*\()/g, '');

  // Strip parameter type annotations: (x: number, y: string) → (x, y)
  // Also handles destructured params: ({ a, b }: Props) → ({ a, b })
  // Must not strip ternary colons or object literal colons
  s = s.replace(/(\((?:[^()]*|\([^()]*\))*\))\s*:\s*[\w$<>\[\]|&?.\s]+(?=\s*[{=>,)])/g, (match, params) => {
    // Strip annotations from inside the param list
    return stripParamAnnotations(params);
  });

  // Strip return type annotations: ): ReturnType { → ) {
  // Match closing paren followed by colon and type, ending at { or =>
  s = s.replace(/\)\s*:\s*[\w$<>\[\]|&?.\s]+(?=\s*\{)/g, ')');
  s = s.replace(/\)\s*:\s*[\w$<>\[\]|&?.\s]+(?=\s*=>)/g, ')');

  // Strip variable type annotations: const x: number = → const x =
  s = s.replace(/((?:const|let|var)\s+[\w$]+)\s*:\s*[\w$<>\[\]|&?.]+\s*(?==)/g, '$1 ');

  // Strip `as Type` casts (but not `as` in import renaming)
  s = s.replace(/\bas\s+(?:const|[\w$<>\[\]|&?.]+)(?=\s*[;,)\]\}=])/g, '');

  // Strip non-null assertions: expr!. → expr. and expr!) → expr)
  s = s.replace(/!(?=\.\w)/g, '');
  s = s.replace(/!(?=\s*[;,)\]])/g, '');

  // Strip import type statements entirely
  s = s.replace(/\bimport\s+type\s+[^;]+;?/g, '');

  return restore(s);
}

/** Strip type annotations from parameter list */
function stripParamAnnotations(params: string): string {
  // Simple approach: remove `: type` patterns after param names
  // Handle (x: number, y: string) and ({ a, b }: Props)
  let result = '';
  let depth = 0;
  let i = 0;
  while (i < params.length) {
    const ch = params[i];
    if (ch === '(' || ch === '{' || ch === '[') { depth++; result += ch; i++; }
    else if (ch === ')' || ch === '}' || ch === ']') { depth--; result += ch; i++; }
    else if (ch === ':' && depth === 1) {
      // Skip the type annotation — find the next ',' or ')' at the same depth
      i++;
      let typeDepth = 0;
      while (i < params.length) {
        const tc = params[i];
        if (tc === '<' || tc === '(' || tc === '{' || tc === '[') typeDepth++;
        else if (tc === '>' || tc === ')' || tc === '}' || tc === ']') {
          // '=>' is an arrow function type, not a closing bracket
          if (tc === '>' && i > 0 && params[i - 1] === '=') { i++; continue; }
          if (typeDepth > 0) typeDepth--;
          else break;
        }
        else if (tc === ',' && typeDepth === 0) break;
        else if (tc === '=' && typeDepth === 0 && (i + 1 >= params.length || params[i + 1] !== '>')) break;
        i++;
      }
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

// ── JSX Transform ──────────────────────────────────────────────────────────

/** Quick check if source likely contains JSX */
export function hasJSX(src: string): boolean {
  return /<[A-Z]/.test(src) || /<[a-z]+[\s/>]/.test(src) || /<>/.test(src);
}

interface JSXResult { output: string; pos: number; }

/**
 * Transform JSX syntax to __jsx() calls (synchronous string transform).
 * <div className="foo">Hello</div> → __jsx("div", {className: "foo"}, "Hello")
 */
export function transformJSX(src: string): string {
  if (!hasJSX(src)) return src;

  // Preserve strings and comments
  const saved: string[] = [];
  let safe = '';
  let idx = 0;
  const len = src.length;
  while (idx < len) {
    const ch = src[idx];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(src, idx);
      saved.push(src.substring(idx, end));
      safe += `___JSX_SAVE_${saved.length - 1}___`;
      idx = end;
    } else if (ch === '/' && idx + 1 < len && src[idx + 1] === '/') {
      const nl = src.indexOf('\n', idx);
      const end = nl >= 0 ? nl : len;
      saved.push(src.substring(idx, end));
      safe += `___JSX_SAVE_${saved.length - 1}___`;
      idx = end;
    } else if (ch === '/' && idx + 1 < len && src[idx + 1] === '*') {
      const end = src.indexOf('*/', idx + 2);
      const commentEnd = end >= 0 ? end + 2 : len;
      saved.push(src.substring(idx, commentEnd));
      safe += `___JSX_SAVE_${saved.length - 1}___`;
      idx = commentEnd;
    } else {
      safe += ch;
      idx++;
    }
  }

  let hadJSX = false;
  let out = '';
  let i = 0;
  const slen = safe.length;

  while (i < slen) {
    if (safe[i] === '<' && isJSXStart(safe, i)) {
      const result = parseJSXElement(safe, i);
      if (result) {
        hadJSX = true;
        out += result.output;
        i = result.pos;
        continue;
      }
    }
    out += safe[i];
    i++;
  }

  // Restore saved strings/comments
  out = out.replace(/___JSX_SAVE_(\d+)___/g, (_, id) => saved[parseInt(id)]);

  if (hadJSX) {
    out = 'var __jsx = require("react").createElement, __jsxFrag = require("react").Fragment;\n' + out;
  }

  return out;
}

/** Determine if '<' at position i is a JSX open tag (not a comparison) */
function isJSXStart(src: string, i: number): boolean {
  // Check what follows '<' — must be a letter, _, $, or '>' (fragment)
  if (i + 1 >= src.length) return false;
  const next = src[i + 1];
  if (next === '>') return true; // fragment <>
  if (next === '/') return false; // closing tag won't appear standalone
  if (!/[a-zA-Z_$]/.test(next)) return false;

  // Check what precedes — comparison operators come after identifiers/numbers/close-parens
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true; // start of file
  const prev = src[j];
  // After identifier char, number, or ')' — it's likely comparison
  if (/[\w$)]/.test(prev)) {
    // But check for keywords that precede JSX
    const before = src.substring(0, j + 1).trimEnd();
    if (/\b(return|case|in|of|typeof|instanceof|void|delete|throw|new|yield|await|default|export)$/.test(before)) return true;
    if (before.endsWith('=>')) return true;
    return false;
  }
  // After these chars, it's JSX context
  if ('=({[,;:?&|!+-*/%^~'.includes(prev)) return true;
  if (prev === '>') {
    // Could be end of generic or end of JSX — check for preceding JSX
    return true;
  }
  return true;
}

function parseJSXElement(src: string, pos: number): JSXResult | null {
  if (pos >= src.length || src[pos] !== '<') return null;

  // Fragment: <>...</>
  if (src[pos + 1] === '>') {
    return parseJSXFragment(src, pos);
  }

  // Opening tag
  const tagResult = parseJSXOpenTag(src, pos);
  if (!tagResult) return null;

  if (tagResult.selfClosing) {
    const propsStr = tagResult.props || 'null';
    return { output: `__jsx(${tagResult.tag}, ${propsStr})`, pos: tagResult.pos };
  }

  // Parse children
  const children = parseJSXChildren(src, tagResult.pos, tagResult.rawTag);
  if (!children) return null;

  const propsStr = tagResult.props || 'null';
  if (children.items.length === 0) {
    return { output: `__jsx(${tagResult.tag}, ${propsStr})`, pos: children.pos };
  }
  return { output: `__jsx(${tagResult.tag}, ${propsStr}, ${children.items.join(', ')})`, pos: children.pos };
}

function parseJSXFragment(src: string, pos: number): JSXResult | null {
  // Skip '<>'
  pos += 2;
  const children = parseJSXChildren(src, pos, '');
  if (!children) return null;
  if (children.items.length === 0) {
    return { output: `__jsx(__jsxFrag, null)`, pos: children.pos };
  }
  return { output: `__jsx(__jsxFrag, null, ${children.items.join(', ')})`, pos: children.pos };
}

interface TagResult { tag: string; rawTag: string; props: string; selfClosing: boolean; pos: number; }

function parseJSXOpenTag(src: string, pos: number): TagResult | null {
  if (src[pos] !== '<') return null;
  pos++; // skip '<'

  // Parse tag name (may include dots: Foo.Bar)
  let rawTag = '';
  while (pos < src.length && /[\w$.]/.test(src[pos])) {
    rawTag += src[pos];
    pos++;
  }
  if (!rawTag) return null;

  // Determine tag string
  const tag = /^[a-z]/.test(rawTag) ? `"${rawTag}"` : rawTag;

  // Parse props
  const propsResult = parseJSXProps(src, pos);
  pos = propsResult.pos;

  // Self-closing or open
  let selfClosing = false;
  if (src[pos] === '/' && pos + 1 < src.length && src[pos + 1] === '>') {
    selfClosing = true;
    pos += 2;
  } else if (src[pos] === '>') {
    pos++;
  } else {
    return null; // malformed
  }

  return { tag, rawTag, props: propsResult.output, selfClosing, pos };
}

interface PropsResult { output: string; pos: number; }

function parseJSXProps(src: string, pos: number): PropsResult {
  const props: string[] = [];
  let hasSpread = false;

  while (pos < src.length) {
    // Skip whitespace
    while (pos < src.length && /\s/.test(src[pos])) pos++;
    if (pos >= src.length) break;

    // End of tag
    if (src[pos] === '>' || (src[pos] === '/' && pos + 1 < src.length && src[pos + 1] === '>')) break;

    // Spread: {...expr}
    if (src[pos] === '{' && pos + 3 < src.length && src[pos + 1] === '.' && src[pos + 2] === '.' && src[pos + 3] === '.') {
      pos += 4; // skip '{...'
      const exprResult = collectBracedContent(src, pos, '}');
      hasSpread = true;
      props.push(`___SPREAD___${exprResult.content}`);
      pos = exprResult.pos + 1; // skip '}'
      continue;
    }

    // Attribute name
    let name = '';
    while (pos < src.length && /[\w$-]/.test(src[pos])) {
      name += src[pos];
      pos++;
    }
    if (!name) break;

    // Skip whitespace
    while (pos < src.length && /\s/.test(src[pos])) pos++;

    // Check for '='
    if (pos < src.length && src[pos] === '=') {
      pos++; // skip '='
      while (pos < src.length && /\s/.test(src[pos])) pos++;

      if (pos < src.length && src[pos] === '{') {
        // Expression prop: key={expr}
        pos++; // skip '{'
        const exprResult = collectBracedContent(src, pos, '}');
        props.push(`${camelProp(name)}: ${exprResult.content}`);
        pos = exprResult.pos + 1; // skip '}'
      } else if (pos < src.length && (src[pos] === '"' || src[pos] === "'")) {
        // String prop: key="value"
        const q = src[pos];
        pos++; // skip quote
        let val = '';
        while (pos < src.length && src[pos] !== q) {
          val += src[pos];
          pos++;
        }
        if (pos < src.length) pos++; // skip closing quote
        props.push(`${camelProp(name)}: "${val}"`);
      } else {
        // Bare value (unlikely but handle)
        let val = '';
        while (pos < src.length && !/[\s/>]/.test(src[pos])) { val += src[pos]; pos++; }
        props.push(`${camelProp(name)}: ${val}`);
      }
    } else {
      // Boolean prop: <input disabled /> → disabled: true
      props.push(`${camelProp(name)}: true`);
    }
  }

  if (props.length === 0) return { output: 'null', pos };

  // Build props object, handling spreads
  if (hasSpread) {
    const parts: string[] = [];
    let currentObj: string[] = [];
    for (const p of props) {
      if (p.startsWith('___SPREAD___')) {
        if (currentObj.length > 0) { parts.push(`{${currentObj.join(', ')}}`); currentObj = []; }
        parts.push(p.replace('___SPREAD___', ''));
      } else {
        currentObj.push(p);
      }
    }
    if (currentObj.length > 0) parts.push(`{${currentObj.join(', ')}}`);
    return { output: `Object.assign({}, ${parts.join(', ')})`, pos };
  }

  return { output: `{${props.join(', ')}}`, pos };
}

/** Convert hyphenated prop names to camelCase (data-* and aria-* stay as strings) */
function camelProp(name: string): string {
  if (name.includes('-')) {
    if (name.startsWith('data-') || name.startsWith('aria-')) return `"${name}"`;
    return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  return name;
}

/** Collect content inside braces/brackets, tracking depth. pos should be right after opening brace. */
function collectBracedContent(src: string, pos: number, closer: string): { content: string; pos: number } {
  let depth = 0;
  let content = '';
  while (pos < src.length) {
    const ch = src[pos];
    if (ch === '{' || ch === '(' || ch === '[') { depth++; content += ch; }
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (ch === closer && depth === 0) return { content, pos };
      depth--;
      content += ch;
    }
    else if (ch === '<' && isJSXStart(src, pos)) {
      // Nested JSX inside expression
      const jsxResult = parseJSXElement(src, pos);
      if (jsxResult) { content += jsxResult.output; pos = jsxResult.pos; continue; }
      else { content += ch; }
    }
    else { content += ch; }
    pos++;
  }
  return { content, pos };
}

interface ChildrenResult { items: string[]; pos: number; }

function parseJSXChildren(src: string, pos: number, closingTag: string): ChildrenResult | null {
  const items: string[] = [];

  while (pos < src.length) {
    // Check for closing tag
    if (src[pos] === '<' && pos + 1 < src.length && src[pos + 1] === '/') {
      // Closing tag
      pos += 2; // skip '</'
      if (closingTag === '') {
        // Fragment closing: </>
        if (src[pos] === '>') { pos++; return { items, pos }; }
      }
      let tag = '';
      while (pos < src.length && /[\w$.]/.test(src[pos])) { tag += src[pos]; pos++; }
      while (pos < src.length && /\s/.test(src[pos])) pos++;
      if (pos < src.length && src[pos] === '>') pos++;
      if (tag === closingTag) return { items, pos };
      return null; // mismatched tag
    }

    // JSX expression child: {expr}
    if (src[pos] === '{') {
      pos++; // skip '{'
      const exprResult = collectBracedContent(src, pos, '}');
      const expr = exprResult.content.trim();
      if (expr) items.push(expr);
      pos = exprResult.pos + 1; // skip '}'
      continue;
    }

    // Nested JSX element
    if (src[pos] === '<' && src[pos + 1] !== '/') {
      const child = parseJSXElement(src, pos);
      if (child) {
        items.push(child.output);
        pos = child.pos;
        continue;
      }
    }

    // Text content
    let text = '';
    while (pos < src.length && src[pos] !== '<' && src[pos] !== '{') {
      text += src[pos];
      pos++;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) items.push(`"${text.replace(/"/g, '\\"')}"`);
  }

  return null; // unclosed
}

// ── Original functions ─────────────────────────────────────────────────────

export function stripShebang(src: string): string {
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n');
    return nl >= 0 ? src.substring(nl + 1) : '';
  }
  return src;
}

/**
 * Mark which characters of src are code (1) rather than inside a string, template
 * text, comment, or regex literal (0). Used so keyword rewrites never touch
 * literals: TypeScript's bundle is full of messages like "'export import' ...".
 * Regex literals are told from division by the previous token; one that would
 * run past the end of its line is taken to be division instead.
 */
export function codeMask(src: string, blockComments?: [number, number][]): Uint8Array {
  // (char codes throughout: one-character strings per character cost ~40% of a load of
  // Claude Code's 13 MB cli.js, which is scanned on every launch)
  const len = src.length;
  const mask = new Uint8Array(len);
  const braceStack: number[] = []; // template nesting: brace depth at each `${`
  let depth = 0;
  let prev = 0; // last significant code character (A: a literal, W: a word, 0: none)
  const A = -1, W = -2;
  let i = 0;
  const regexAfterWord = /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
  const isIdent = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c > 127;
  // after which a `/` starts a regex: ( , = : [ ! & | ? { } ; + - * % < > ~ ^
  const beforeRegex = new Uint8Array(128);
  for (const ch of '(,=:[!&|?{};+-*%<>~^') beforeRegex[ch.charCodeAt(0)] = 1;
  const scanTemplate = (): void => {
    // at template text; stops after the closing ` or after `${`
    while (i < len) {
      const c = src.charCodeAt(i);
      if (c === 92) { i += 2; continue; } // backslash
      if (c === 96) { i++; return; } // `
      if (c === 36 && src.charCodeAt(i + 1) === 123) { // ${
        i += 2;
        braceStack.push(depth);
        depth++;
        prev = 123;
        return;
      }
      i++;
    }
  };
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13) { mask[i] = 1; i++; continue; }
    if (isIdent(c)) {
      mask[i] = 1;
      let j = i + 1;
      while (j < len && isIdent(src.charCodeAt(j))) { mask[j] = 1; j++; }
      i = j;
      prev = W; // a word: `return /re/` vs `x / y` is decided from its text
      continue;
    }
    if (c === 47) { // /
      const n = src.charCodeAt(i + 1);
      if (n === 47) {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? len : nl;
        continue;
      }
      if (n === 42) {
        const end = src.indexOf('*/', i + 2);
        const start = i;
        i = end < 0 ? len : end + 2;
        blockComments?.push([start, i]);
        continue;
      }
      const wordBefore = prev === W ? src.slice(Math.max(0, i - 12), i).trimEnd() : '';
      const isRegex = prev === 0 || (prev > 0 && prev < 128 && beforeRegex[prev] === 1) || (prev === W && regexAfterWord.test(wordBefore));
      if (isRegex) {
        let j = i + 1, inClass = false, ok = false;
        while (j < len) {
          const r = src.charCodeAt(j);
          if (r === 10) break;
          if (r === 92) { j += 2; continue; }
          if (r === 91) inClass = true;
          else if (r === 93) inClass = false;
          else if (r === 47 && !inClass) { ok = true; break; }
          j++;
        }
        if (ok) {
          i = j + 1;
          for (let f = src.charCodeAt(i); (f >= 97 && f <= 122) || (f >= 65 && f <= 90); f = src.charCodeAt(++i));
          prev = A;
          continue;
        }
      }
    } else if (c === 34 || c === 39) { // " '
      i++;
      for (let q = src.charCodeAt(i); i < len && q !== c && q !== 10; q = src.charCodeAt(i)) i += q === 92 ? 2 : 1;
      i++;
      prev = A;
      continue;
    } else if (c === 96) { i++; scanTemplate(); prev = A; continue; }
    mask[i] = 1;
    if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (braceStack.length && braceStack[braceStack.length - 1] === depth) {
        braceStack.pop();
        mask[i] = 0;
        i++;
        scanTemplate();
        prev = A;
        continue;
      }
    }
    prev = c;
    i++;
  }
  return mask;
}

/** Source plus its codeMask, kept in step as replacements are made. */
interface MaskedSource { src: string; mask: Uint8Array }

/**
 * import(x) → __dynamic_import(x), in code only, leaving alone a URL (the
 * browser loads it), a member call (`runner.import(url)`, also across a line
 * break: vite's module runner) and a method definition (`import(id) { … }`:
 * Astro's module loader).
 */
function rewriteDynamicImports(ms: MaskedSource): void {
  const mask = ms.mask;
  replaceInCode(ms, /(?<![\w$.])import\s*\((?!\s*['"`](?:https?|data|blob):)/g, (m: string, off: number, text: string) => {
    let k = off - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (text[k] === '.') return m;
    let depth = 0, i = off + m.length - 1;
    for (; i < text.length; i++) {
      if (!mask[i]) continue;
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    return text[j] === '{' ? m : '__dynamic_import(';
  });
}

/** src.replace(re, replacer) for matches that start in code (see codeMask). */
function replaceInCode(ms: MaskedSource, re: RegExp, replacer: string | ((...args: any[]) => string)): void {
  re.lastIndex = 0;
  if (!re.test(ms.src)) return;
  re.lastIndex = 0; // matchAll starts from lastIndex
  const { src, mask } = ms;
  const out: string[] = [];
  const maskParts: Uint8Array[] = [];
  let last = 0;
  for (const m of src.matchAll(re.global ? re : new RegExp(re.source, re.flags + 'g'))) {
    const off = m.index!;
    if (!mask[off]) continue;
    const rep = typeof replacer === 'function'
      ? replacer(...m, off, src)
      : replacer.replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? '');
    out.push(src.slice(last, off), rep);
    maskParts.push(mask.subarray(last, off), new Uint8Array(rep.length).fill(1));
    last = off + m[0].length;
    if (!re.global) break;
  }
  if (!out.length) return;
  out.push(src.slice(last));
  maskParts.push(mask.subarray(last));
  const newMask = new Uint8Array(maskParts.reduce((n, part) => n + part.length, 0));
  let pos = 0;
  for (const part of maskParts) { newMask.set(part, pos); pos += part.length; }
  ms.src = out.join('');
  ms.mask = newMask;
}

/** What runs on a transformed module's text with its code mask (async-context.ts's carryAsyncContext) */
export type MaskedPass = (src: string, mask?: Uint8Array) => string;

/** ms.src[start, end) → text, the mask kept in step (text's own mask: it may hold strings) */
function spliceMasked(ms: MaskedSource, start: number, end: number, text: string): void {
  const m = codeMask(text);
  const mask = new Uint8Array(ms.mask.length - (end - start) + text.length);
  mask.set(ms.mask.subarray(0, start), 0);
  mask.set(m, start);
  mask.set(ms.mask.subarray(end), start + text.length);
  ms.src = ms.src.slice(0, start) + text + ms.src.slice(end);
  ms.mask = mask;
}

export function transformBundledESM(src: string, pass?: MaskedPass): string {
  // Fast path for large bundled files (>500KB).
  // Bundled ESM files have thousands of string/template literals.
  // The full regex-based transform introduces quote characters in
  // replacements (e.g. require("mod")) that break enclosing string
  // delimiters, causing SyntaxError: Invalid or unexpected token.
  //
  // This fast path only does safe transforms:
  // - Leading imports at file start (not inside strings)
  // - import.meta → __import_meta (no quotes introduced)
  // - import( → __dynamic_import( (no quotes introduced)
  // - Strip 'export' keyword (no quotes introduced)

  src = stripShebang(src);
  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');


  // 1. Transform leading import statements at the file start.
  //    In bundled ESM, real imports are at position 0, NOT inside strings.
  let pos = 0;
  const parts: string[] = [];

  // Skip whitespace, semicolons, and comments before/between imports
  function skipNonCode() {
    while (pos < src.length) {
      if (/[\s;]/.test(src[pos])) { parts.push(src[pos]); pos++; continue; }
      // Single-line comment
      if (src[pos] === '/' && pos + 1 < src.length && src[pos + 1] === '/') {
        const nl = src.indexOf('\n', pos);
        const end = nl >= 0 ? nl + 1 : src.length;
        parts.push(src.substring(pos, end));
        pos = end;
        continue;
      }
      // Block comment
      if (src[pos] === '/' && pos + 1 < src.length && src[pos + 1] === '*') {
        const end = src.indexOf('*/', pos + 2);
        const commentEnd = end >= 0 ? end + 2 : src.length;
        parts.push(src.substring(pos, commentEnd));
        pos = commentEnd;
        continue;
      }
      break;
    }
  }
  skipNonCode();

  // Process consecutive import statements
  while (pos < src.length) {
    const rest = src.substring(pos);
    if (!rest.startsWith('import')) break;

    // Don't transform import.meta or import() here — handled globally below
    const afterImport = rest[6];
    if (afterImport === '.' || afterImport === '(') break;

    let matched = false;

    // import { x as y } from "module" (handles minified: import{x}from"m")
    const namedMatch = rest.match(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
    if (namedMatch) {
      const fixed = namedMatch[1].replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
      parts.push(`const {${fixed}} = __shiro_require("${namedMatch[2]}");`);
      pos += namedMatch[0].length;
      matched = true;
    }

    if (!matched) {
      // import x, { y } from "module"
      const combinedMatch = rest.match(/^import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (combinedMatch) {
        const fixed = combinedMatch[2].replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
        parts.push(`const ${combinedMatch[1]} = __shiro_require("${combinedMatch[3]}"); const {${fixed}} = __shiro_require("${combinedMatch[3]}");`);
        pos += combinedMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import x from "module"
      const defaultMatch = rest.match(/^import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (defaultMatch) {
        parts.push(`const ${defaultMatch[1]} = __shiro_require("${defaultMatch[2]}");`);
        pos += defaultMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import * as x from "module"
      const starMatch = rest.match(/^import\s*\*\s*as\s+([\w$]+)\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (starMatch) {
        parts.push(`const ${starMatch[1]} = __shiro_require("${starMatch[2]}");`);
        pos += starMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import "module" (side-effect)
      const sideEffectMatch = rest.match(/^import\s+['"]([^'"]+)['"]\s*;?\s*/);
      if (sideEffectMatch) {
        parts.push(`__shiro_require("${sideEffectMatch[1]}");`);
        pos += sideEffectMatch[0].length;
        matched = true;
      }
    }

    if (!matched) break;
    skipNonCode(); // Skip whitespace/comments between imports
  }

  parts.push(src.substring(pos));
  src = parts.join('');

  const ms: MaskedSource = { src, mask: codeMask(src) };

  // 2. import.meta → __import_meta (safe everywhere, no quotes introduced)
  replaceInCode(ms, /import\.meta/g, '__import_meta');

  // 3. Dynamic import() → __dynamic_import()
  //    Safe: just replaces the keyword with a function name, no quotes.
  rewriteDynamicImports(ms);

  // 4. Transform remaining static imports globally.
  //    Minified bundles have imports scattered throughout (not just at the top)
  //    for externalized Node.js builtins (fs, path, os, crypto, etc.).
  //    Uses \s* instead of \s+ to handle minified import{x}from"y" patterns.

  // Note: JS identifiers can contain $ (common in minified code: Z$, M$6)
  // so we use [\w$]+ instead of \w+ for identifier matching.

  // import Default, { named } from "module"
  replaceInCode(ms, /\bimport\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\3\s*;?/g,
    (_, defaultName, namedImports, q, mod) => {
      const fixed = namedImports.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
      return `const ${defaultName} = __shiro_require(${q}${mod}${q}); const {${fixed}} = __shiro_require(${q}${mod}${q});`;
    });

  // import { x as y } from "module"  (handles minified: import{x}from"m")
  replaceInCode(ms, /\bimport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, imports, q, mod) => {
      const fixed = imports.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
      return `const {${fixed}} = __shiro_require(${q}${mod}${q});`;
    });

  // import x from "module"
  replaceInCode(ms, /\bimport\s+([\w$]+)\s+from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `const ${name} = __shiro_require(${q}${mod}${q});`);

  // import * as x from "module"  (handles minified: import*as x from"m")
  replaceInCode(ms, /\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `const ${name} = __shiro_require(${q}${mod}${q});`);

  // import "module" (side-effect only)
  replaceInCode(ms, /\bimport\s*(['"])([^'"]+)\1\s*;?/g,
    (_, q, mod) => `__shiro_require(${q}${mod}${q});`);

  // 5. Strip 'export' keyword from declarations (safe, no quotes introduced).
  replaceInCode(ms, /\bexport\s+default\s+/g, '__shiro_module.exports = ');
  replaceInCode(ms, /\bexport\s+async\s+function\s+/g, 'async function ');
  replaceInCode(ms, /\bexport\s+function\s+/g, 'function ');
  replaceInCode(ms, /\bexport\s+class\s+/g, 'class ');
  replaceInCode(ms, /\bexport\s+(const|let|var)\s+/g, '$1 ');

  // 6. Handle export { x as y } and export { x } from "y" patterns
  //    These appear in minified bundles as export{x as y} or export{x}from"y"
  replaceInCode(ms, /\bexport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, exports, q, mod) => {
      const items = exports.split(',').map((s: string) => s.trim()).filter((s: string) => s);
      return items.map((item: string) => {
        const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        if (asMatch) return `__shiro_module.exports.${asMatch[2]} = __shiro_require(${q}${mod}${q}).${asMatch[1]};`;
        return `__shiro_module.exports.${item} = __shiro_require(${q}${mod}${q}).${item};`;
      }).join(' ');
    });

  // export * as name from "module"
  replaceInCode(ms, /\bexport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `__shiro_module.exports.${name} = __shiro_require(${q}${mod}${q});`);

  // export * from "module"
  replaceInCode(ms, /\bexport\s*\*\s*from\s*(['"])([^'"]+)\1\s*;?/g,
    (_, q, mod) => `Object.assign(__shiro_module.exports, __shiro_require(${q}${mod}${q}));`);

  // export { x as y } (local re-exports, no from)
  replaceInCode(ms, /\bexport\s*\{([^}]+)\}\s*;?/g, (_, exports) => {
    const items = exports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^[\w$]/.test(s));
    return items.map((item: string) => {
      const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (asMatch) return `__shiro_module.exports.${asMatch[2]} = ${asMatch[1]};`;
      return `__shiro_module.exports.${item} = ${item};`;
    }).join(' ');
  });

  // 7. Remove TypeScript type-only imports/exports
  replaceInCode(ms, /\bimport\s+type\s+[^;]+;?/g, '/* import type */');
  replaceInCode(ms, /\bexport\s+type\s+/g, '/* export type */ ');

  // (Each pattern that starts with an identifier starts at an identifier's start: tried
  // at every character of one, a 145 KB run of them (an inline source map in a webpack
  // dev chunk) cost quadratic time; Next's 8 MB vendor chunk took 171 s.)

  // 8. Patch lazy module factory to handle initialization failures gracefully.
  //    The bundled code uses X=(A,q)=>()=>(q||A((q={exports:{}}).exports,q),q.exports)
  //    as a lazy CJS module factory (where X is a minified name like R, y, etc.).
  //    If factory A throws (missing Node.js API), subsequent code accessing exports gets {}.
  //    We wrap in try-catch and auto-stub missing properties so that
  //    `class X extends FailedModule.SomeClass` doesn't crash.
  //    Uses regex to match any variable name, not just a hardcoded one.
  const rPattern = /(?<![\w$])([\w$]+)=\((\w+),(\w+)\)=>\(\)=>\(\3\|\|\2\(\(\3=\{exports:\{\}\}\)\.exports,\3\),\3\.exports\)/;
  // (each edit keeps the mask in step: a pass after these reads it instead of scanning again)
  const rMatch = rPattern.exec(ms.src);
  if (rMatch) {
    const [rOld, rName, rArg1, rArg2] = rMatch;
    const rNew = `${rName}=(${rArg1},${rArg2})=>()=>{if(!${rArg2}){${rArg2}={exports:{}};try{${rArg1}(${rArg2}.exports,${rArg2})}catch(e){if(e&&e._isProcessExit)throw e;${rArg2}.exports=__stubProxy(${rArg2}.exports)}}return ${rArg2}.exports}`;
    spliceMasked(ms, rMatch.index, rMatch.index + rOld.length, rNew);
    // Inject __stubProxy helper and Node.js-compatible setTimeout/setInterval at the very start
    spliceMasked(ms, 0, 0, [
      'function __stubProxy(o){return new Proxy(o,{get(t,p,r){if(typeof p==="symbol"||p in t)return Reflect.get(t,p,r);var _s=function(){};_s.prototype={};_s.default=_s;t[p]=_s;return _s}})}',
      // Hide browser globals from SDK browser detection (typeof window/navigator checks)
      // Must be void 0 so typeof navigator === "undefined" — SDK and CLI both guard with typeof before access
      'var navigator=void 0;',
      // Override setTimeout/setInterval to return Timer-like objects with .unref()/.ref()
      'var _origSetTimeout=setTimeout,_origSetInterval=setInterval,_origClearTimeout=clearTimeout,_origClearInterval=clearInterval;',
      'function _wrapTimer(id){return{_id:id,ref(){return this},unref(){return this},hasRef(){return true},refresh(){return this},[Symbol.toPrimitive](){return id}}}',
      'setTimeout=function(fn,ms,...args){return _wrapTimer(_origSetTimeout(fn,ms,...args))};',
      'setInterval=function(fn,ms,...args){return _wrapTimer(_origSetInterval(fn,ms,...args))};',
      'clearTimeout=function(t){_origClearTimeout(t&&t._id!==void 0?t._id:t)};',
      'clearInterval=function(t){_origClearInterval(t&&t._id!==void 0?t._id:t)};',
      // Suppress unhandled rejections from ProcessExitError and CLI's "unreachable" throws
      'if(typeof globalThis.addEventListener==="function"){var _rejHandler=function(e){if(e&&e.reason&&(e.reason._isProcessExit||e.reason==="unreachable"||e.reason.message==="unreachable"))e.preventDefault()};globalThis.addEventListener("unhandledrejection",_rejHandler)}',
    ].join('\n') + '\n');
  }

  // Patch lazy side-effect runner: X=(A,q)=>()=>(A&&(q=A(A=0)),q)
  // where X is a minified name like v, E, etc.
  // If the side-effect factory throws, cache undefined rather than re-throwing on every access.
  const vPattern = /(?<![\w$])([\w$]+)=\((\w+),(\w+)\)=>\(\)=>\(\2&&\(\3=\2\(\2=0\)\),\3\)/;
  const vMatch = vPattern.exec(ms.src);
  if (vMatch) {
    const [vOld, vName, vArg1, vArg2] = vMatch;
    const vNew = `${vName}=(${vArg1},${vArg2})=>()=>{try{${vArg1}&&(${vArg2}=${vArg1}(${vArg1}=0))}catch(e){if(e&&e._isProcessExit)throw e;if(!${vArg2})${vArg2}=__stubProxy({})}return ${vArg2}}`;
    spliceMasked(ms, vMatch.index, vMatch.index + vOld.length, vNew);
  }

  // 9. Detect trailing unawaited async function call (e.g., `cMz();`)
  // In real Node.js, the event loop keeps running. In our AsyncFunction, we need to await it.
  // (in the last few hundred characters: matched against all of a 13 MB bundle it took 100 ms)
  const from = Math.max(0, ms.src.length - 512);
  const tail = /(?<![\w$])([\w$]+)\(\)\s*;?\s*$/.exec(ms.src.slice(from));
  if (tail && (tail.index > 0 || from === 0 || !/[\w$]/.test(ms.src[from - 1]))) {
    spliceMasked(ms, from + tail.index, ms.src.length, `await ${tail[1]}();`);
  }

  return pass ? pass(ms.src, ms.mask) : ms.src;
}

/** Transformed large bundles by source text: each `claude` launch (every pane)
 *  loads the same 13 MB cli.js, and the transform takes about a second. */
const bundleCache = new Map<string, string>();
/** ...and with a pass run on them */
const passedBundleCache = new Map<string, string>();

/**
 * `new Function("m", "return import(m)")`, the idiom CommonJS builds use to
 * keep a real dynamic import (prettier's CLI, TypeScript-compiled code): the
 * native import() would resolve against the page, so it becomes the module's
 * __dynamic_import.
 */
export function rewriteFunctionImport(src: string): string {
  if (!src.includes('Function(')) return src;
  return src.replace(
    /\bnew\s+Function\(\s*(['"])([\w$]+)\1\s*,\s*(['"])return\s+import\(\s*\2\s*\);?\3\s*\)/g,
    (_, _q, name) => `((${name}) => __dynamic_import(${name}))`);
}

/**
 * `pass`: run on the result with its code mask, where the transform has one
 * (carryAsyncContext: a second scan of Claude Code's 13 MB cli.js cost each
 * launch ~150 ms and 13 MB)
 */
export function transformESModules(src: string, pass?: MaskedPass): string {
  src = rewriteFunctionImport(src);
  // esbuild code-split chunks need live import bindings (see esm-live.ts)
  if (isEsbuildChunk(src)) src = liveEsbuildChunk(stripShebang(src));
  // Fast path for large bundled files (>500KB)
  if (src.length > 500000) {
    const cache = pass ? passedBundleCache : bundleCache;
    const cached = cache.get(src);
    if (cached !== undefined) return cached;
    const out = transformBundledESM(src, pass);
    if (cache.size >= 2) cache.delete(cache.keys().next().value!);
    cache.set(src, out);
    return out;
  }

  src = stripShebang(src);
  // Normalize line endings to LF
  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Preserve block comments to avoid transforming export/import keywords inside them
  // Note: We don't preserve line comments (//) as they can appear in strings (URLs)
  // (the ones codeMask finds: `/*` inside a string or template, as tsconfck's
  // `**/*`, isn't one, and taking it for one hid the code up to the next `*/`)
  const comments: string[] = [];
  {
    const ranges: [number, number][] = [];
    codeMask(src, ranges);
    let out = '', last = 0;
    for (const [a, b] of ranges) {
      comments.push(src.slice(a, b));
      out += src.slice(last, a) + `___COMMENT_${comments.length - 1}___`;
      last = b;
    }
    src = out + src.slice(last);
  }

  // Dynamic import() → __dynamic_import() (must be before other import
  // transforms): resolved like require, relative to the module, giving a
  // namespace object; only in code (not in strings: prettier builds one with
  // new Function). URLs (a CDN module) stay native import(): the browser loads
  // them, and a native import() of anything else resolves against the page.
  {
    const ms: MaskedSource = { src, mask: codeMask(src) };
    rewriteDynamicImports(ms);
    src = ms.src;
  }

  // Import and export statements, rewritten only in code (not in strings or
  // templates: create-vite carries `import react from '...'` as template text),
  // spaced or minified alike (`import{a as b}from"x"`, identifiers with $)
  const ms: MaskedSource = { src, mask: codeMask(src) };
  const I = '(?<![\\w$.])';
  // Named imports, read again once their module has loaded if it was still
  // loading (a cycle: ESM bindings are live, and a copy made then is undefined;
  // Astro's render-context → middleware/index → sequence → render-context)
  // `{ default as x }` is the default import (Astro's `import { default as default2 }`):
  // a module's default export is its exports here, as CommonJS's is in node
  const namedImport = (pattern: string, mod: string) => {
    const entries = pattern.split(',').map((e) => e.trim()).filter(Boolean);
    const def = entries.map((e) => /^default\s*:\s*([\w$]+)$/.exec(e)).find(Boolean)?.[1];
    const rest = entries.filter((e) => !/^default\s*:/.test(e)).join(', ');
    const decl = [def ? `let ${def} = __shiro_require("${mod}");` : '', rest ? `let {${rest}} = __shiro_require("${mod}");` : ''].join(' ').trim();
    const reread = [def ? `${def} = __shiro_m;` : '', rest ? `({${rest}} = __shiro_m);` : ''].join(' ').trim();
    return `${decl} __shiro_require.relink?.("${mod}", (__shiro_m) => { ${reread} });`;
  };
  const asColon = (list: string) => list.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
  const exportItems = (list: string) => list.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',').map((x: string) => x.trim()).filter((x: string) => x && /^[\w$]/.test(x))
    .map((item: string) => {
      // `x as y`, and ES2022 string names: `x as "module.exports"` (@vitejs/plugin-react)
      const m = /^([\w$]+)\s+as\s+([\w$]+|(['"])[^'"]*\3)$/.exec(item);
      if (!m) return [item, '.' + item];
      return [m[1], m[3] ? `[${JSON.stringify(m[2].slice(1, -1))}]` : '.' + m[2]];
    })
    // `x as default` is `export default x` (the exports themselves), so it goes first and the rest attach to it
    .sort((a: string[], b: string[]) => Number(b[1] === '.default') - Number(a[1] === '.default'));

  // import.meta → __import_meta (must be before import statement transforms)
  replaceInCode(ms, /import\.meta/g, '__import_meta');

  // import Default, { named } from 'y' → combined default + named import
  replaceInCode(ms, new RegExp(I + String.raw`import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?`, 'g'),
    (_: string, defaultName: string, namedImports: string, mod: string) =>
      `const ${defaultName} = __shiro_require("${mod}"); ${namedImport(asColon(namedImports), mod)}`);

  // import Default, * as ns from 'y'
  replaceInCode(ms, new RegExp(I + String.raw`import\s+([\w$]+)\s*,\s*\*\s*as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?`, 'g'),
    'const $1 = __shiro_require("$3"); const $2 = __shiro_require("$3");');

  // import x from 'y' → const x = require('y')
  replaceInCode(ms, new RegExp(I + String.raw`import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?`, 'g'),
    'const $1 = __shiro_require("$2");');

  // import { a, b } from 'y' → const { a, b } = require('y'); a as b → a: b
  replaceInCode(ms, new RegExp(I + String.raw`import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?`, 'g'),
    (_: string, imports: string, mod: string) => asColon(imports).trim() ? namedImport(asColon(imports), mod) : `__shiro_require("${mod}");`);

  // import * as x from 'y' → const x = require('y')
  replaceInCode(ms, new RegExp(I + String.raw`import\s*\*\s*as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?`, 'g'),
    'const $1 = __shiro_require("$2");');

  // import 'y' → require('y')
  replaceInCode(ms, new RegExp(I + String.raw`import\s*['"]([^'"]+)['"]\s*;?`, 'g'), '__shiro_require("$1");');

  // export default x → module.exports = x
  replaceInCode(ms, new RegExp(I + String.raw`export\s+default\s+`, 'g'), '__shiro_module.exports = ');

  // export { x, y as z } from 'w'
  replaceInCode(ms, new RegExp(I + String.raw`export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?`, 'g'),
    (_: string, list: string, mod: string) => exportItems(list).map(([local, exported]) =>
      exported === '.default' ? `__shiro_module.exports = __shiro_require("${mod}").${local};` : `__shiro_module.exports${exported} = __shiro_require("${mod}").${local};`).join(' '));

  // export * as name from 'z' → module.exports.name = require('z')
  replaceInCode(ms, new RegExp(I + String.raw`export\s*\*\s*as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?`, 'g'),
    '__shiro_module.exports.$1 = __shiro_require("$2");');

  // export * from 'z' → Object.assign(module.exports, require('z'))
  replaceInCode(ms, new RegExp(I + String.raw`export\s*\*\s*from\s*['"]([^'"]+)['"]\s*;?`, 'g'),
    'Object.assign(__shiro_module.exports, __shiro_require("$1"));');

  // export { x, y as z } → module.exports.x = x; module.exports.z = y;
  const listExports: string[][] = [];
  replaceInCode(ms, new RegExp(I + String.raw`export\s*\{([^}]*)\}\s*;?`, 'g'),
    (_: string, list: string) => exportItems(list).map(([local, exported]) => {
      listExports.push([local, exported]);
      return exported === '.default' ? `__shiro_module.exports = ${local};` : `__shiro_module.exports${exported} = ${local};`;
    }).join(' '));

  // Track named exports to add module.exports at the end
  const namedExports: string[] = [];
  const track = (name: string) => { namedExports.push(name); };

  // export const/let/var x = ... → const x = ...; (track x)
  replaceInCode(ms, new RegExp(I + String.raw`export\s+(const|let|var)\s+([\w$]+)\s*=`, 'g'),
    (_: string, decl: string, name: string) => { track(name); return `${decl} ${name} =`; });
  // export var/let x; (declaration without initialization)
  replaceInCode(ms, new RegExp(I + String.raw`export\s+(var|let)\s+([\w$]+)\s*;`, 'g'),
    (_: string, decl: string, name: string) => { track(name); return `${decl} ${name};`; });
  // export [async] function[*] name / export class Name
  const functionExports: string[] = [];
  replaceInCode(ms, new RegExp(I + String.raw`export\s+(async\s+function\s*\*?|function\s*\*?|class)\s*([\w$]+)`, 'g'),
    (_: string, kind: string, name: string) => {
      track(name);
      if (kind !== 'class') functionExports.push(name);
      return `${kind.replace(/\s+/g, ' ').replace(/function \*/, 'function*')} ${name}`;
    });

  // TypeScript's type-only forms
  replaceInCode(ms, new RegExp(I + String.raw`export\s+type\s+`, 'g'), '/* export type */ ');
  replaceInCode(ms, new RegExp(I + String.raw`import\s+type\s+[^;]+;?`, 'g'), '/* import type */');
  src = ms.src;

  // Add module.exports for all tracked named exports at the end
  if (namedExports.length > 0) {
    src += '\n' + namedExports.map(n => `__shiro_module.exports.${n} = ${n};`).join('\n');
  }

  // Exported function declarations are there from the start, as in ESM (hoisted):
  // a module that imports this one back while this one is still loading its
  // imports gets them (Astro's middleware: index.js imports sequence.js, which
  // imports index.js's defineMiddleware). On the first line, after any
  // directives, so line numbers stay.
  {
    // (top-level ones only: a nested function may share a name with an exported const)
    const declared = new Set<string>();
    const fm = codeMask(src);
    const depthAt = new Int32Array(src.length + 1);
    for (let i = 0, d = 0; i < src.length; i++) {
      depthAt[i] = d;
      if (fm[i]) { const c = src.charCodeAt(i); if (c === 123) d++; else if (c === 125) d--; }
    }
    for (const m of src.matchAll(/(?<![\w$.])(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/g)) {
      if (fm[m.index!] && depthAt[m.index!] === 0) declared.add(m[1]);
    }
    const hoist = [
      ...functionExports.map((n) => `__shiro_module.exports.${n} = ${n};`),
      ...listExports.filter(([local, exported]) => exported !== '.default' && declared.has(local)).map(([local, exported]) => `__shiro_module.exports${exported} = ${local};`),
    ];
    // A default export is the exports themselves here: named exports set before it
    // (`export * from`, `export { z }` ahead of `export default z`: zod) are carried
    // over to it at the end
    const replacesExports = /__shiro_module\.exports\s*=(?!=)/.test(src);
    if (replacesExports) {
      hoist.unshift('const __shiro_exports0 = __shiro_module.exports;');
      src += '\n;{ const __e = __shiro_module.exports; if (__e !== __shiro_exports0 && __e && (typeof __e === "object" || typeof __e === "function")) for (const __k of Object.keys(__shiro_exports0)) if (!(__k in __e)) try { __e[__k] = __shiro_exports0[__k]; } catch {} }';
    }
    if (hoist.length) {
      const prologue = /^(?:\s*(?:(['"])use [\w ]+\1\s*;?))*/.exec(src)![0];
      src = prologue + hoist.join(' ') + ' ' + src.slice(prologue.length);
    }
  }

  // Remove __filename/__dirname/Buffer declarations (we provide these as parameters)
  // Handles: const __filename = fileURLToPath(import.meta.url);
  //          const __dirname = dirname(__filename);
  //          const Buffer = require('buffer').Buffer;
  // (in code only, and within one statement: a template that carries such a line
  // as text, as Next's build/utils.js does, ran on to a `;` far past it)
  {
    const cm: MaskedSource = { src, mask: codeMask(src) };
    replaceInCode(cm, /(?:const|let|var)\s+__filename\s*=\s*[^;\n]+;?/g, '/* __filename provided */');
    replaceInCode(cm, /(?:const|let|var)\s+__dirname\s*=\s*[^;\n]+;?/g, '/* __dirname provided */');
    // Handle: const Buffer = require('buffer').Buffer; or var Buffer = ...
    // Use [^;,]+ to stop at comma (multi-line declarations) or semicolon
    replaceInCode(cm, /(?:const|let|var)\s+Buffer\s*=\s*[^;,]+;/g, '/* Buffer provided */');
    // Handle multi-line: var Buffer = ...,\n    OtherVar = ...; -> var OtherVar = ...;
    replaceInCode(cm, /(const|let|var)\s+Buffer\s*=\s*[^,]+,\s*/g, '$1 ');
    // Handle: const { Buffer } = require('buffer'); (destructuring)
    replaceInCode(cm, /(?:const|let|var)\s*\{\s*Buffer\s*\}\s*=\s*[^;]+;/g, '/* Buffer provided */');
    // Handle: const { Buffer, ... } = require('buffer'); (Buffer in destructuring with others)
    replaceInCode(cm, /(\{\s*)Buffer(\s*,)/g, '$1/* Buffer */$2');
    replaceInCode(cm, /(,\s*)Buffer(\s*\})/g, '$1/* Buffer */$2');
    replaceInCode(cm, /(,\s*)Buffer(\s*,)/g, '$1/* Buffer */$2');
    src = cm.src;
  }

  // Note: We removed aggressive catch-all transforms for import/export
  // as they were corrupting URLs in strings (//example.com) and other code.
  // If ES module syntax slips through, we'll get a clear "Unexpected token" error.

  // Restore preserved comments
  src = src.replace(/___COMMENT_(\d+)___/g, (_, idx) => comments[parseInt(idx)]);

  // Note: trailing await transform is in transformBundledESM, not here

  return pass ? pass(src) : src;
}
