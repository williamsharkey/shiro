// Script rewriting for browse origins (docs/BROWSER.md, "location"). A page on
// https://en-wikipedia-org.web.tabcomputer.com/ that reads `location.hostname`
// should see en.wikipedia.org. Location's properties can't be redefined (they
// are [LegacyUnforgeable]), so scripts are rewritten instead, the way UV and
// Scramjet do it, but narrowly:
//
//   location, x.location        → __tcLocation, x.__tcLocation
//       (shim.ts: an Object.prototype accessor; for a real Location it returns
//        a stand-in that reports the real origin, otherwise x.location as is)
//   top, x.top                  → __tcTop, x.__tcTop
//       (for a window, the tab's top document, not the desktop above it; for
//        anything else, x.top. Every `.top` goes through it: frame walks like
//        `while (w !== w.top) w = w.parent` must see one consistent world)
//   x.postMessage(m, origin)    → x.postMessage(m, __tcPMO(origin))
//       (a real target origin becomes its browse origin, else the message is dropped)
//   eval(src)                   → eval(__tcJS(src))      (still a direct eval)
//
// Every `location` binding is renamed the same way, so a local variable or
// parameter called `location` keeps working. Object keys, class members,
// labels and module export names are left alone, so data shapes don't change.
// A script that doesn't parse is passed through unchanged.
import { parse, type Node } from 'acorn';

export const LOC = '__tcLocation';
export const TOP = '__tcTop';
/** Globals whose every binding is renamed. */
const RENAME: Record<string, string> = { location: LOC, top: TOP };
const PMO = '__tcPMO';
const EVAL = '__tcJS';

const HINT = /location|\btop\b|postMessage|\beval\b/;

interface Edit { at: number; end: number; text: string }

type AnyNode = Node & Record<string, any>;

export interface RewriteResult {
  code: string;
  module: boolean;
  changed: boolean;
  /** Where a prelude can go in `code` without ending the directive prologue ("use strict") or a hashbang. */
  preludeAt: number;
}

/** Parse `src` as a classic script, else as a module; null if neither parses. */
function parseAny(src: string, as?: 'script' | 'module' | 'body'): { ast: AnyNode; module: boolean } | null {
  const tries: ('script' | 'module')[] = as === 'module' ? ['module'] : as === 'script' || as === 'body' ? ['script'] : ['script', 'module'];
  for (const sourceType of tries) {
    try {
      const ast = parse(src, {
        ecmaVersion: 'latest', sourceType, allowHashBang: true,
        allowReturnOutsideFunction: as === 'body', allowAwaitOutsideFunction: sourceType === 'module',
      }) as AnyNode;
      return { ast, module: sourceType === 'module' };
    } catch { /* next */ }
  }
  return null;
}

/**
 * Rewrite a script. `as`: 'script' or 'module' when known, 'body' for an event
 * handler attribute (a function body), else both are tried.
 */
export function rewriteJs(src: string, as?: 'script' | 'module' | 'body'): RewriteResult {
  const same = (module: boolean): RewriteResult => ({ code: src, module, changed: false, preludeAt: 0 });
  if (!HINT.test(src)) return same(as === 'module');
  const parsed = parseAny(src, as);
  if (!parsed) return same(as === 'module');
  const edits: Edit[] = [];
  collect(parsed.ast, null, edits);
  if (!edits.length) return same(parsed.module);
  const code = apply(src, edits);
  // The prologue's directives come first in the rewritten code too, and are unchanged by it
  let at = src.startsWith('#!') ? (src.indexOf('\n') + 1 || src.length) : 0;
  for (const st of parsed.ast.body as AnyNode[]) { if (st.type === 'ExpressionStatement' && st.directive !== undefined) at = st.end; else break; }
  return { code, module: parsed.module, changed: true, preludeAt: at };
}

function apply(src: string, edits: Edit[]): string {
  // Zero-width inserts at a position go before a replacement starting there
  edits.sort((a, b) => a.at - b.at || (a.end - a.at) - (b.end - b.at));
  let out = '';
  let pos = 0;
  for (const e of edits) {
    if (e.at < pos) continue; // overlapping (shouldn't happen)
    out += src.slice(pos, e.at) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos);
}

const renamed = (n: AnyNode | null | undefined): string | null =>
  !!n && n.type === 'Identifier' && Object.prototype.hasOwnProperty.call(RENAME, n.name) ? n.name : null;
const rename = (n: AnyNode, edits: Edit[]) => edits.push({ at: n.start, end: n.end, text: RENAME[n.name] });
const wrap = (n: AnyNode, fn: string, edits: Edit[]) => {
  edits.push({ at: n.start, end: n.start, text: fn + '(' });
  edits.push({ at: n.end, end: n.end, text: ')' });
};

function collect(node: AnyNode, parent: AnyNode | null, edits: Edit[]): void {
  switch (node.type) {
    case 'Identifier':
      if (renamed(node)) rename(node, edits);
      return;
    case 'MemberExpression': {
      collect(node.object, node, edits);
      if (node.computed) { collect(node.property, node, edits); return; }
      const name = renamed(node.property);
      if (name && !(parent?.type === 'UnaryExpression' && parent.operator === 'delete')) rename(node.property, edits);
      return;
    }
    case 'Property': {
      const name = node.shorthand ? renamed(node.key) : null;
      if (name) {
        // {location} / {location = d}: the key stays, the binding or value is renamed
        edits.push({ at: node.key.start, end: node.key.end, text: `${name}: ${RENAME[name]}` });
        if (node.value.type === 'AssignmentPattern') collect(node.value.right, node.value, edits);
        return;
      }
      if (node.computed) collect(node.key, node, edits);
      collect(node.value, node, edits);
      return;
    }
    case 'MethodDefinition':
    case 'PropertyDefinition':
      if (node.computed) collect(node.key, node, edits);
      if (node.value) collect(node.value, node, edits);
      return;
    case 'LabeledStatement':
      collect(node.body, node, edits);
      return;
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'MetaProperty':
      return;
    case 'ImportSpecifier': {
      const name = renamed(node.local);
      if (name) {
        const same = node.imported.start === node.local.start;
        edits.push({ at: node.local.start, end: node.local.end, text: same ? `${name} as ${RENAME[name]}` : RENAME[name] });
      }
      return;
    }
    case 'ExportSpecifier': {
      // Re-exports (`export {location} from 'x'`) name the other module's exports, not bindings
      if (parent?.source) return;
      const name = renamed(node.local);
      if (name) {
        const same = node.exported.start === node.local.start;
        edits.push({ at: node.local.start, end: node.local.end, text: same ? `${RENAME[name]} as ${name}` : RENAME[name] });
      }
      return;
    }
    case 'ExportAllDeclaration':
      return;
    case 'CallExpression': {
      const c = node.callee as AnyNode;
      const args = node.arguments as AnyNode[];
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === 'postMessage'
        && args.length >= 2 && args[0].type !== 'SpreadElement' && args[1].type !== 'SpreadElement') wrap(args[1], PMO, edits);
      if (c.type === 'Identifier' && c.name === 'eval' && args.length >= 1 && args[0].type !== 'SpreadElement') wrap(args[0], EVAL, edits);
      break;
    }
  }
  for (const k in node) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') collect(c, node, edits); }
    else if (v && typeof v === 'object' && typeof v.type === 'string') collect(v, node, edits);
  }
}
