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
