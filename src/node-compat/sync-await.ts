/**
 * child_process's *Sync calls can't block the page: they return a thenable
 * whose value arrives later (child-process.ts). A script that reads the
 * result at once (`spawnSync('cat', { input }).stdout`) saw "". Where the
 * script may await (its top level, which runs as an async function, and
 * async functions), each such call is awaited, so it has its result when
 * the next expression reads it. Calls inside plain functions are left as
 * they were.
 */
import { parse } from 'acorn';

const SYNC = new Set(['execSync', 'spawnSync', 'execFileSync']);

export function awaitSyncCalls(code: string): string {
  if (!/\b(execSync|spawnSync|execFileSync)\s*\(/.test(code) || code.length > 2_000_000) return code;
  let ast: any;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowHashBang: true });
  } catch {
    return code; // not plain JS (yet): leave it
  }
  const spots: { start: number; end: number }[] = [];
  const visit = (node: any, canAwait: boolean, parent: any) => {
    if (!node || typeof node.type !== 'string') return;
    let inner = canAwait;
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      inner = !!node.async && !node.generator;
    }
    if (node.type === 'CallExpression' && canAwait) {
      const c = node.callee;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : null;
      const awaited = parent?.type === 'AwaitExpression';
      if (name && SYNC.has(name) && !awaited) spots.push({ start: node.start, end: node.end });
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) for (const x of v) visit(x, inner, node);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, inner, node);
    }
  };
  visit(ast, true, null);
  if (!spots.length) return code;
  // innermost last, so offsets of enclosing calls stay right: insert from the end
  const edits: { at: number; text: string }[] = [];
  for (const s of spots) { edits.push({ at: s.start, text: '(await ' }, { at: s.end, text: ')' }); }
  edits.sort((a, b) => b.at - a.at || (a.text === ')' ? -1 : 1));
  let out = code;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}
