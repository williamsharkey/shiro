import { describe, it, expect } from 'vitest';
import { transformBundledESM, codeMask } from '@shiro/commands/jseval/module-transform';

// Issue 74: typescript's lib/_tsc.js failed to load ("Unexpected token ')'") because
// the large-bundle ESM transform rewrote `import`/`export` inside its message strings.
describe('bundled ESM transform leaves literals alone', () => {
  it('does not touch strings, templates, comments, or regexes', () => {
    const src = [
      'import { a } from "./a.js";',
      'var msg1 = "Cannot use \'export import\' on a type";',
      "var msg2 = 'Did you mean typeof import(\"x\")? import.meta too';",
      'var msg3 = `Consider \'import * as ns from "mod"\' ${ import.meta.url } and import "y"`;',
      '// import "commented"',
      '/* export default nope */',
      'var re = /import\\s+x/g;',
      'var d = 4 / 2 / 1; var e = (import.meta.url);',
      'const lazy = () => import("./lazy.js");',
      'export function f() { return "export const no"; }',
      'export default f;',
    ].join('\n');
    const out = transformBundledESM(src);
    expect(out).toContain('const { a } = __shiro_require("./a.js");');
    expect(out).toContain('"Cannot use \'export import\' on a type"');
    expect(out).toContain("'Did you mean typeof import(\"x\")? import.meta too'");
    expect(out).toContain('`Consider \'import * as ns from "mod"\' ${ __import_meta.url } and import "y"`');
    expect(out).toContain('// import "commented"');
    expect(out).toContain('/* export default nope */');
    expect(out).toContain('/import\\s+x/g');
    expect(out).toContain('var e = (__import_meta.url)');
    expect(out).toContain('__dynamic_import("./lazy.js")');
    expect(out).toContain('function f() { return "export const no"; }');
    expect(out).toContain('__shiro_module.exports = f;');
    expect(() => new Function('module', 'exports', 'require', '__import_meta', '__dynamic_import', out)).not.toThrow();
  });

  it('tells regex literals from division', () => {
    const src = 'a = b / c; d = x.replace(/"/g, "q"); if (y) return /\'/.test(z); w = "import x";';
    const m = codeMask(src);
    expect(m[src.indexOf('replace')]).toBe(1);
    expect(m[src.indexOf('"q"') + 1]).toBe(0);
    expect(m[src.indexOf('test')]).toBe(1);
    expect(m[src.indexOf('import')]).toBe(0);
  });
});

// Next's dev server chunks (webpack eval-source-map) carry inline source maps: runs of
// 100 000+ identifier characters. Patterns that start with an identifier were tried at
// every character of them, and its 8 MB vendor chunk took 171 s to load.
describe('bundled ESM transform in linear time', () => {
  it('a 2 MB bundle with long identifier runs transforms in well under a second, and still patches', () => {
    const run = 'A'.repeat(150_000);
    const body = Array.from({ length: 12 }, (_, i) => `var s${i} = "${run}";`).join('\n');
    const src = 'var R=(A,q)=>()=>(q||A((q={exports:{}}).exports,q),q.exports);\n' + body + '\nmain();\n';
    const t0 = performance.now();
    const out = transformBundledESM(src);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(out).toContain('R=(A,q)=>()=>{if(!q){q={exports:{}};try{');
    expect(out.trimEnd().endsWith('await main();')).toBe(true);
  });
});
