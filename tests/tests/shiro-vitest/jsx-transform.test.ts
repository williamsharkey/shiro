/**
 * Tests for TypeScript type stripping (transformTS) and JSX transform (transformJSX).
 * Also tests extension resolution in require() and node command.
 */
import { describe, it, expect } from 'vitest';
import { transformTS, transformJSX, hasJSX } from '@shiro/commands/jseval/module-transform';
import { createTestShell, run } from './helpers';

describe('transformTS — TypeScript type stripping', () => {
  it('strips interface declarations', () => {
    const out = transformTS('interface Foo { x: number; y: string; }\nconst a = 1;');
    expect(out).not.toContain('interface');
    expect(out).toContain('const a = 1');
  });

  it('strips exported interface', () => {
    const out = transformTS('export interface Bar { a: boolean; }');
    expect(out).not.toContain('interface');
    expect(out).not.toContain('Bar');
  });

  it('strips type aliases', () => {
    const out = transformTS('type MyType = string | number;\nconst b = 2;');
    expect(out).not.toContain('type MyType');
    expect(out).toContain('const b = 2');
  });

  it('strips exported type aliases', () => {
    const out = transformTS('export type Result = { ok: boolean; data: any };');
    expect(out).not.toContain('type Result');
  });

  it('strips enum declarations', () => {
    const out = transformTS('enum Color { Red, Green, Blue }\nconst c = 3;');
    expect(out).not.toContain('enum');
    expect(out).toContain('const c = 3');
  });

  it('strips const enum', () => {
    const out = transformTS('const enum Dir { Up, Down }\nconst d = 4;');
    expect(out).not.toContain('enum');
    expect(out).toContain('const d = 4');
  });

  it('strips parameter type annotations', () => {
    const out = transformTS('function add(x: number, y: number): number { return x + y; }');
    expect(out).toContain('function add(x, y)');
    expect(out).toContain('return x + y');
    expect(out).not.toContain(': number');
  });

  it('strips variable type annotations', () => {
    const out = transformTS('const x: number = 42;');
    expect(out).toContain('const x = 42');
    expect(out).not.toContain(': number');
  });

  it('strips as-casts', () => {
    const out = transformTS('const el = document.getElementById("x") as HTMLDivElement;');
    expect(out).not.toContain('as HTMLDivElement');
  });

  it('strips generic type parameters before function calls', () => {
    const out = transformTS('const result = foo<string, number>(a, b);');
    expect(out).toContain('foo(a, b)');
    expect(out).not.toContain('<string');
  });

  it('strips import type statements', () => {
    const out = transformTS('import type { Foo } from "./types";\nconst x = 1;');
    expect(out).not.toContain('import type');
    expect(out).toContain('const x = 1');
  });

  it('strips inline type keyword from imports', () => {
    const out = transformTS('import { type Foo, Bar } from "./mod";');
    expect(out).toContain('Bar');
    expect(out).not.toContain('type Foo');
  });

  it('preserves ternary colons', () => {
    const out = transformTS('const x = a ? b : c;');
    expect(out).toContain('a ? b : c');
  });

  it('preserves object literal colons', () => {
    const out = transformTS('const obj = { key: "value" };');
    expect(out).toContain('key: "value"');
  });

  it('preserves string contents', () => {
    const out = transformTS('const s = "interface Foo { x: number }";');
    expect(out).toContain('interface Foo { x: number }');
  });

  it('preserves template literals', () => {
    const out = transformTS('const s = `type: ${x}`;');
    expect(out).toContain('`type: ${x}`');
  });

  it('strips declare blocks', () => {
    const out = transformTS('declare module "foo" { export function bar(): void; }\nconst x = 1;');
    expect(out).not.toContain('declare');
    expect(out).toContain('const x = 1');
  });

  it('strips return type annotations before arrow', () => {
    const out = transformTS('const fn = (x: number): string => x.toString();');
    // Should strip `: string` before =>
    expect(out).not.toContain(': string');
  });

  it('strips non-null assertions', () => {
    const out = transformTS('const x = obj!.prop;');
    expect(out).toContain('obj.prop');
    expect(out).not.toContain('!.');
  });

  it('handles complex generic parameters', () => {
    const out = transformTS('function map<T, U>(arr: T[], fn: (x: T) => U): U[] { return arr.map(fn); }');
    expect(out).toContain('function map(arr, fn)');
  });
});

describe('transformJSX — JSX to __jsx() calls', () => {
  it('transforms self-closing element', () => {
    const out = transformJSX('const el = <br />;');
    expect(out).toContain('__jsx("br", null)');
  });

  it('transforms element with children text', () => {
    const out = transformJSX('const el = <div>Hello</div>;');
    expect(out).toContain('__jsx("div", null, "Hello")');
  });

  it('transforms element with string props', () => {
    const out = transformJSX('const el = <div className="foo">bar</div>;');
    expect(out).toContain('__jsx("div", {className: "foo"}, "bar")');
  });

  it('transforms expression props', () => {
    const out = transformJSX('const el = <input value={x} />;');
    expect(out).toContain('__jsx("input", {value: x})');
  });

  it('transforms boolean props', () => {
    const out = transformJSX('const el = <input disabled />;');
    expect(out).toContain('disabled: true');
  });

  it('transforms spread props', () => {
    const out = transformJSX('const el = <Comp {...props} />;');
    expect(out).toContain('Object.assign({}, props)');
  });

  it('transforms component (uppercase) tags as identifiers', () => {
    const out = transformJSX('const el = <MyComponent />;');
    expect(out).toContain('__jsx(MyComponent, null)');
    expect(out).not.toContain('"MyComponent"');
  });

  it('transforms lowercase tags as strings', () => {
    const out = transformJSX('const el = <div />;');
    expect(out).toContain('__jsx("div", null)');
  });

  it('transforms fragments', () => {
    const out = transformJSX('const el = <>A{b}</>;');
    expect(out).toContain('__jsx(__jsxFrag, null, "A", b)');
  });

  it('transforms nested elements', () => {
    const out = transformJSX('const el = <div><span>hi</span></div>;');
    expect(out).toContain('__jsx("div", null, __jsx("span", null, "hi"))');
  });

  it('transforms dot-notation tags', () => {
    const out = transformJSX('const el = <Foo.Bar />;');
    expect(out).toContain('__jsx(Foo.Bar, null)');
  });

  it('preserves comparison operators', () => {
    const out = transformJSX('const x = a < b && c > d;');
    expect(out).toContain('a < b && c > d');
    expect(out).not.toContain('__jsx');
  });

  it('adds __jsx preamble when JSX is detected', () => {
    const out = transformJSX('const el = <div />;');
    expect(out).toContain('var __jsx = require("react").createElement');
    expect(out).toContain('__jsxFrag = require("react").Fragment');
  });

  it('does not add preamble when no JSX', () => {
    const out = transformJSX('const x = 1 + 2;');
    expect(out).not.toContain('__jsx');
  });

  it('preserves strings containing angle brackets', () => {
    const out = transformJSX('const s = "a < b > c";');
    expect(out).not.toContain('__jsx');
  });

  it('handles expression children', () => {
    const out = transformJSX('const el = <p>{name}</p>;');
    expect(out).toContain('__jsx("p", null, name)');
  });

  it('transforms JSX after return', () => {
    const out = transformJSX('function App() { return <div>hi</div>; }');
    expect(out).toContain('return __jsx("div", null, "hi")');
  });

  it('transforms JSX after arrow =>', () => {
    const out = transformJSX('const App = () => <div>hi</div>;');
    expect(out).toContain('=> __jsx("div", null, "hi")');
  });
});

describe('hasJSX — quick detection', () => {
  it('detects component tags', () => {
    expect(hasJSX('<Component />')).toBe(true);
  });

  it('detects HTML tags', () => {
    expect(hasJSX('<div>hello</div>')).toBe(true);
  });

  it('detects fragments', () => {
    expect(hasJSX('<>text</>')).toBe(true);
  });

  it('returns false for plain code', () => {
    expect(hasJSX('const x = 1;')).toBe(false);
  });
});

describe('node command — extension probing', () => {
  it('runs a .ts file with node command', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/app.ts', new TextEncoder().encode(
      'const x: number = 42;\nconsole.log(x);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/app.ts');
    expect(exitCode).toBe(0);
    expect(output).toContain('42');
  });

  it('probes extensions when none given', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/myapp.js', new TextEncoder().encode(
      'console.log("found-js");'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/myapp');
    expect(exitCode).toBe(0);
    expect(output).toContain('found-js');
  });

  it('probes .ts extension', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/tsapp.ts', new TextEncoder().encode(
      'const msg: string = "from-ts";\nconsole.log(msg);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/tsapp');
    expect(exitCode).toBe(0);
    expect(output).toContain('from-ts');
  });

  it('runs .tsx file with JSX', async () => {
    const { fs, shell } = await createTestShell();
    // Provide a mock react module that the JSX preamble can require
    await fs.mkdir('/home/user/node_modules');
    await fs.mkdir('/home/user/node_modules/react');
    await fs.writeFile('/home/user/node_modules/react/package.json', new TextEncoder().encode(
      '{"name":"react","main":"index.js"}'
    ));
    await fs.writeFile('/home/user/node_modules/react/index.js', new TextEncoder().encode(
      'module.exports = { createElement: function(tag, props) { var ch = [].slice.call(arguments, 2); return { tag: tag, props: props, children: ch }; }, Fragment: "Fragment" };'
    ));
    await fs.writeFile('/home/user/comp.tsx', new TextEncoder().encode(
      'const el = <div className="test">Hello</div>;\n' +
      'console.log(JSON.stringify(el));'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/comp.tsx');
    expect(exitCode).toBe(0);
    expect(output).toContain('"tag":"div"');
    expect(output).toContain('Hello');
  });
});

describe('require() — extension resolution', () => {
  it('resolves .ts files from require("./module")', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/lib.ts', new TextEncoder().encode(
      'const val: number = 99;\nmodule.exports = { val };'
    ));
    await fs.writeFile('/home/user/main.js', new TextEncoder().encode(
      'const lib = require("./lib");\nconsole.log(lib.val);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/main.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('99');
  });

  it('resolves .tsx files from require("./component")', async () => {
    const { fs, shell } = await createTestShell();
    // Provide mock react
    try { await fs.mkdir('/home/user/node_modules'); } catch {}
    try { await fs.mkdir('/home/user/node_modules/react'); } catch {}
    await fs.writeFile('/home/user/node_modules/react/package.json', new TextEncoder().encode(
      '{"name":"react","main":"index.js"}'
    ));
    await fs.writeFile('/home/user/node_modules/react/index.js', new TextEncoder().encode(
      'module.exports = { createElement: function() { return {}; }, Fragment: "Fragment" };'
    ));
    await fs.writeFile('/home/user/comp.tsx', new TextEncoder().encode(
      'const Comp = () => <span>hi</span>;\n' +
      'module.exports = { Comp };'
    ));
    await fs.writeFile('/home/user/app.js', new TextEncoder().encode(
      'const { Comp } = require("./comp");\nconsole.log(typeof Comp);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/app.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('function');
  });
});
