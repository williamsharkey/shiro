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

export function transformBundledESM(src: string): string {
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
      parts.push(`const {${fixed}} = require("${namedMatch[2]}");`);
      pos += namedMatch[0].length;
      matched = true;
    }

    if (!matched) {
      // import x, { y } from "module"
      const combinedMatch = rest.match(/^import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (combinedMatch) {
        const fixed = combinedMatch[2].replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
        parts.push(`const ${combinedMatch[1]} = require("${combinedMatch[3]}"); const {${fixed}} = require("${combinedMatch[3]}");`);
        pos += combinedMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import x from "module"
      const defaultMatch = rest.match(/^import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (defaultMatch) {
        parts.push(`const ${defaultMatch[1]} = require("${defaultMatch[2]}");`);
        pos += defaultMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import * as x from "module"
      const starMatch = rest.match(/^import\s*\*\s*as\s+([\w$]+)\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (starMatch) {
        parts.push(`const ${starMatch[1]} = require("${starMatch[2]}");`);
        pos += starMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import "module" (side-effect)
      const sideEffectMatch = rest.match(/^import\s+['"]([^'"]+)['"]\s*;?\s*/);
      if (sideEffectMatch) {
        parts.push(`require("${sideEffectMatch[1]}");`);
        pos += sideEffectMatch[0].length;
        matched = true;
      }
    }

    if (!matched) break;
    skipNonCode(); // Skip whitespace/comments between imports
  }

  parts.push(src.substring(pos));
  src = parts.join('');

  // 2. import.meta → __import_meta (safe everywhere, no quotes introduced)
  src = src.replace(/import\.meta/g, '__import_meta');

  // 3. Dynamic import() → __dynamic_import()
  //    Safe: just replaces the keyword with a function name, no quotes.
  src = src.replace(/\bimport\s*\(/g, '__dynamic_import(');

  // 4. Transform remaining static imports globally.
  //    Minified bundles have imports scattered throughout (not just at the top)
  //    for externalized Node.js builtins (fs, path, os, crypto, etc.).
  //    Uses \s* instead of \s+ to handle minified import{x}from"y" patterns.

  // Note: JS identifiers can contain $ (common in minified code: Z$, M$6)
  // so we use [\w$]+ instead of \w+ for identifier matching.

  // import Default, { named } from "module"
  src = src.replace(/\bimport\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\3\s*;?/g,
    (_, defaultName, namedImports, q, mod) => {
      const fixed = namedImports.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
      return `const ${defaultName} = require(${q}${mod}${q}); const {${fixed}} = require(${q}${mod}${q});`;
    });

  // import { x as y } from "module"  (handles minified: import{x}from"m")
  src = src.replace(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, imports, q, mod) => {
      const fixed = imports.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
      return `const {${fixed}} = require(${q}${mod}${q});`;
    });

  // import x from "module"
  src = src.replace(/\bimport\s+([\w$]+)\s+from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `const ${name} = require(${q}${mod}${q});`);

  // import * as x from "module"  (handles minified: import*as x from"m")
  src = src.replace(/\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `const ${name} = require(${q}${mod}${q});`);

  // import "module" (side-effect only)
  src = src.replace(/\bimport\s*(['"])([^'"]+)\1\s*;?/g,
    (_, q, mod) => `require(${q}${mod}${q});`);

  // 5. Strip 'export' keyword from declarations (safe, no quotes introduced).
  src = src.replace(/\bexport\s+default\s+/g, 'module.exports = ');
  src = src.replace(/\bexport\s+async\s+function\s+/g, 'async function ');
  src = src.replace(/\bexport\s+function\s+/g, 'function ');
  src = src.replace(/\bexport\s+class\s+/g, 'class ');
  src = src.replace(/\bexport\s+(const|let|var)\s+/g, '$1 ');

  // 6. Handle export { x as y } and export { x } from "y" patterns
  //    These appear in minified bundles as export{x as y} or export{x}from"y"
  src = src.replace(/\bexport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, exports, q, mod) => {
      const items = exports.split(',').map((s: string) => s.trim()).filter((s: string) => s);
      return items.map((item: string) => {
        const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        if (asMatch) return `module.exports.${asMatch[2]} = require(${q}${mod}${q}).${asMatch[1]};`;
        return `module.exports.${item} = require(${q}${mod}${q}).${item};`;
      }).join(' ');
    });

  // export * as name from "module"
  src = src.replace(/\bexport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `module.exports.${name} = require(${q}${mod}${q});`);

  // export * from "module"
  src = src.replace(/\bexport\s*\*\s*from\s*(['"])([^'"]+)\1\s*;?/g,
    (_, q, mod) => `Object.assign(module.exports, require(${q}${mod}${q}));`);

  // export { x as y } (local re-exports, no from)
  src = src.replace(/\bexport\s*\{([^}]+)\}\s*;?/g, (_, exports) => {
    const items = exports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^[\w$]/.test(s));
    return items.map((item: string) => {
      const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (asMatch) return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
      return `module.exports.${item} = ${item};`;
    }).join(' ');
  });

  // 7. Remove TypeScript type-only imports/exports
  src = src.replace(/\bimport\s+type\s+[^;]+;?/g, '/* import type */');
  src = src.replace(/\bexport\s+type\s+/g, '/* export type */ ');

  // 8. Patch lazy module factory to handle initialization failures gracefully.
  //    The bundled code uses X=(A,q)=>()=>(q||A((q={exports:{}}).exports,q),q.exports)
  //    as a lazy CJS module factory (where X is a minified name like R, y, etc.).
  //    If factory A throws (missing Node.js API), subsequent code accessing exports gets {}.
  //    We wrap in try-catch and auto-stub missing properties so that
  //    `class X extends FailedModule.SomeClass` doesn't crash.
  //    Uses regex to match any variable name, not just a hardcoded one.
  const rPattern = /([\w$]+)=\((\w+),(\w+)\)=>\(\)=>\(\3\|\|\2\(\(\3=\{exports:\{\}\}\)\.exports,\3\),\3\.exports\)/;
  const rMatch = src.match(rPattern);
  if (rMatch) {
    const [rOld, rName, rArg1, rArg2] = rMatch;
    const rNew = `${rName}=(${rArg1},${rArg2})=>()=>{if(!${rArg2}){${rArg2}={exports:{}};try{${rArg1}(${rArg2}.exports,${rArg2})}catch(e){if(e&&e._isProcessExit)throw e;${rArg2}.exports=__stubProxy(${rArg2}.exports)}}return ${rArg2}.exports}`;
    src = src.replace(rOld, rNew);
    // Inject __stubProxy helper and Node.js-compatible setTimeout/setInterval at the very start
    src = [
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
    ].join('\n') + '\n' + src;
  }

  // Patch lazy side-effect runner: X=(A,q)=>()=>(A&&(q=A(A=0)),q)
  // where X is a minified name like v, E, etc.
  // If the side-effect factory throws, cache undefined rather than re-throwing on every access.
  const vPattern = /([\w$]+)=\((\w+),(\w+)\)=>\(\)=>\(\2&&\(\3=\2\(\2=0\)\),\3\)/;
  const vMatch = src.match(vPattern);
  if (vMatch) {
    const [vOld, vName, vArg1, vArg2] = vMatch;
    const vNew = `${vName}=(${vArg1},${vArg2})=>()=>{try{${vArg1}&&(${vArg2}=${vArg1}(${vArg1}=0))}catch(e){if(e&&e._isProcessExit)throw e;if(!${vArg2})${vArg2}=__stubProxy({})}return ${vArg2}}`;
    src = src.replace(vOld, vNew);
  }

  // 9. Detect trailing unawaited async function call (e.g., `cMz();`)
  // In real Node.js, the event loop keeps running. In our AsyncFunction, we need to await it.
  src = src.replace(/([\w$]+)\(\)\s*;?\s*$/, 'await $1();');

  return src;
}

export function transformESModules(src: string): string {
  // Fast path for large bundled files (>500KB)
  if (src.length > 500000) {
    return transformBundledESM(src);
  }

  src = stripShebang(src);
  // Normalize line endings to LF
  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Preserve block comments to avoid transforming export/import keywords inside them
  // Note: We don't preserve line comments (//) as they can appear in strings (URLs)
  const comments: string[] = [];
  src = src.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    comments.push(match);
    return `___COMMENT_${comments.length - 1}___`;
  });

  // Dynamic import() → Promise.resolve(require()) - must be before other import transforms
  // Handles: await import("./path") or import("./path").then(...)
  src = src.replace(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, 'Promise.resolve(require($1$2$1))');

  // import.meta → __import_meta (must be before import statement transforms)
  src = src.replace(/import\.meta/g, '__import_meta');

  // import Default, { named } from 'y' → combined default + named import
  src = src.replace(/import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, defaultName, namedImports, mod) => {
      const cleanImports = namedImports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const fixed = cleanImports.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
      return `const ${defaultName} = require("${mod}"); const {${fixed}} = require("${mod}");`;
    });

  // import x from 'y' → const x = require('y')
  src = src.replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'const $1 = require("$2");');

  // import { a, b } from 'y' → const { a, b } = require('y')
  // Also handles: import { a as b } → const { a: b }
  src = src.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, imports, mod) => {
      // Strip comments and fix 'as' syntax
      const cleanImports = imports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const fixed = cleanImports.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
      return `const {${fixed}} = require("${mod}");`;
    });

  // import * as x from 'y' → const x = require('y')
  src = src.replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'const $1 = require("$2");');

  // import 'y' → require('y')
  src = src.replace(/import\s+['"]([^'"]+)['"]\s*;?/g,
    'require("$1");');

  // export default x → module.exports = x
  src = src.replace(/export\s+default\s+/g, 'module.exports = ');

  // export { x, y } from 'z' or export { x as y } from 'z' (handles multiline and comments)
  // Note: \s* allows no space between export and { (e.g., export{x})
  src = src.replace(/export\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, exports, mod) => {
      // Strip comments from exports
      const cleanExports = exports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const items = cleanExports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
      const assigns = items.map((item: string) => {
        const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          return `module.exports.${asMatch[2]} = require("${mod}").${asMatch[1]};`;
        }
        return `module.exports.${item} = require("${mod}").${item};`;
      }).join(' ');
      return assigns;
    });

  // export * as name from 'z' → module.exports.name = require('z')
  src = src.replace(/export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'module.exports.$1 = require("$2");');

  // export * from 'z' → Object.assign(module.exports, require('z'))
  src = src.replace(/export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'Object.assign(module.exports, require("$1"));');

  // export { x, y } or export { x as y } → module.exports.x = x; module.exports.y = y;
  // Note: \s* allows no space between export and { (e.g., export{x as y})
  src = src.replace(/export\s*\{([^}]+)\}\s*;?/g, (_, exports) => {
    // Strip comments and parse exports like "x, y as z, foo"
    const cleanExports = exports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const items = cleanExports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
    return items.map((item: string) => {
      const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        // export { local as exported }
        return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
      }
      // export { x }
      return `module.exports.${item} = ${item};`;
    }).join(' ');
  });

  // Track named exports to add module.exports at the end
  const namedExports: string[] = [];

  // export const/let/var x = ... → const x = ...; (track x)
  src = src.replace(/export\s+(const|let|var)\s+(\w+)\s*=/g, (_, decl, name) => {
    namedExports.push(name);
    return `${decl} ${name} =`;
  });

  // export var/let x; (declaration without initialization) → var x; (track x)
  src = src.replace(/export\s+(var|let)\s+(\w+)\s*;/g, (_, decl, name) => {
    namedExports.push(name);
    return `${decl} ${name};`;
  });

  // export function name() → function name(); (track name)
  src = src.replace(/export\s+function\s+(\w+)/g, (_, name) => {
    namedExports.push(name);
    return `function ${name}`;
  });

  // export class Name → class Name; (track Name)
  src = src.replace(/export\s+class\s+(\w+)/g, (_, name) => {
    namedExports.push(name);
    return `class ${name}`;
  });

  // export async function name() → async function name(); (track name)
  src = src.replace(/export\s+async\s+function\s+(\w+)/g, (_, name) => {
    namedExports.push(name);
    return `async function ${name}`;
  });

  // Add module.exports for all tracked named exports at the end
  if (namedExports.length > 0) {
    src += '\n' + namedExports.map(n => `module.exports.${n} = ${n};`).join('\n');
  }

  // Remove __filename/__dirname/Buffer declarations (we provide these as parameters)
  // Handles: const __filename = fileURLToPath(import.meta.url);
  //          const __dirname = dirname(__filename);
  //          const Buffer = require('buffer').Buffer;
  src = src.replace(/(?:const|let|var)\s+__filename\s*=\s*[^;]+;?/g, '/* __filename provided */');
  src = src.replace(/(?:const|let|var)\s+__dirname\s*=\s*[^;]+;?/g, '/* __dirname provided */');
  // Handle: const Buffer = require('buffer').Buffer; or var Buffer = ...
  // Use [^;,]+ to stop at comma (multi-line declarations) or semicolon
  src = src.replace(/(?:const|let|var)\s+Buffer\s*=\s*[^;,]+;/g, '/* Buffer provided */');
  // Handle multi-line: var Buffer = ...,\n    OtherVar = ...; -> var OtherVar = ...;
  src = src.replace(/(const|let|var)\s+Buffer\s*=\s*[^,]+,\s*/g, '$1 ');
  // Handle: const { Buffer } = require('buffer'); (destructuring)
  src = src.replace(/(?:const|let|var)\s*\{\s*Buffer\s*\}\s*=\s*[^;]+;/g, '/* Buffer provided */');
  // Handle: const { Buffer, ... } = require('buffer'); (Buffer in destructuring with others)
  src = src.replace(/(\{\s*)Buffer(\s*,)/g, '$1/* Buffer */$2');
  src = src.replace(/(,\s*)Buffer(\s*\})/g, '$1/* Buffer */$2');
  src = src.replace(/(,\s*)Buffer(\s*,)/g, '$1/* Buffer */$2');

  // Catch-all: remove any remaining export keywords that weren't handled
  // This handles edge cases like TypeScript 'export type' that might slip through
  src = src.replace(/\bexport\s+type\s+/g, '/* export type */ ');
  src = src.replace(/\bimport\s+type\s+[^;]+;?/g, '/* import type */');

  // Final safety: if any export/import statements remain, handle them aggressively
  // This prevents "Unexpected token 'export'" errors

  // Catch any remaining export { name } patterns (including no-space like export{x})
  while (/\bexport\s*\{/.test(src)) {
    src = src.replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (_, names) => {
      const cleanNames = names.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const items = cleanNames.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
      return items.map((item: string) => {
        const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
        return `module.exports.${item} = ${item};`;
      }).join(' ');
    });
  }

  // Note: We removed aggressive catch-all transforms for import/export
  // as they were corrupting URLs in strings (//example.com) and other code.
  // If ES module syntax slips through, we'll get a clear "Unexpected token" error.

  // Restore preserved comments
  src = src.replace(/___COMMENT_(\d+)___/g, (_, idx) => comments[parseInt(idx)]);

  // Note: trailing await transform is in transformBundledESM, not here

  return src;
}
