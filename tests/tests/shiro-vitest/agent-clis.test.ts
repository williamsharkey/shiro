/**
 * Shiro-side fixes found running AI coding-agent CLIs (docs/COMPAT.md
 * "Agent CLIs"): Gemini CLI's esbuild chunks (top-level await, live ESM
 * bindings), dns/promises, utimes/stat mtimes (proper-lockfile), spawn env,
 * and curl -o of binary files.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestShell, run } from './helpers';
import { transformESModules } from '@shiro/commands/jseval/module-transform';
import { isEsbuildChunk, liveEsbuildChunk } from '@shiro/commands/jseval/esm-live';

async function shellWith(files: Record<string, string>) {
  const { fs, shell } = await createTestShell();
  for (const [path, text] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, text);
  }
  return { fs, shell };
}

const banner = "const require = (await import('node:module')).createRequire(import.meta.url);\n";

describe('ES modules with top-level await', () => {
  it('an importer waits for the imported module to finish', async () => {
    const { shell } = await shellWith({
      '/t/package.json': '{"type":"module"}',
      '/t/chunk.js': banner + 'await new Promise((r) => setTimeout(r, 20));\nfunction foo() { return 42; }\nvar BAR = 7;\nexport {\n  BAR,\n  foo\n};\n',
      '/t/main.js': banner + 'import {\n  BAR,\n  foo\n} from "./chunk.js";\nconsole.log("got", typeof foo, foo(), BAR);\n',
    });
    const r = await run(shell, 'node /t/main.js');
    expect(r.output).toContain('got function 42 7');
  });

  it('import() waits for the module body too', async () => {
    const { shell } = await shellWith({
      '/t/package.json': '{"type":"module"}',
      '/t/late.js': 'await new Promise((r) => setTimeout(r, 20));\nexport const answer = 42;\n',
      '/t/main.js': 'const m = await import("./late.js");\nconsole.log("answer", m.answer);\n',
    });
    const r = await run(shell, 'node /t/main.js');
    expect(r.output).toContain('answer 42');
  });
});

describe('esbuild chunks: live import bindings', () => {
  const runtime = 'var __esm = (fn, res) => function __init() { return fn && (res = (0, fn[Object.getOwnPropertyNames(fn)[0]])(fn = 0)), res; };\nexport { __esm };\n';
  const lib = [
    'import { __esm } from "./runtime.js";',
    'var ValueType;',
    'var init_metric = __esm({ "metric.js"() { (function(V) { V[V["INT"] = 0] = "INT"; })(ValueType || (ValueType = {})); } });',
    'export { ValueType, init_metric };',
    '',
  ].join('\n');
  const main = [
    'import { __esm } from "./runtime.js";',
    'import { ValueType, init_metric } from "./lib.js";',
    'init_metric();',
    'const defs = { count: { valueType: ValueType.INT }, ValueType };',
    'class C { ValueType() { return 1; } }',
    'console.log("int", defs.count.valueType, typeof defs.ValueType, new C().ValueType());',
    '',
  ].join('\n');

  it('detects chunks by their runtime-helper import', () => {
    expect(isEsbuildChunk(main)).toBe(true);
    expect(isEsbuildChunk('import { readFile } from "node:fs";\n')).toBe(false);
  });

  it('a lazily initialized export is seen after its initializer runs', async () => {
    const { shell } = await shellWith({
      '/c/package.json': '{"type":"module"}',
      '/c/runtime.js': runtime,
      '/c/lib.js': lib,
      '/c/main.js': main,
    });
    const r = await run(shell, 'node /c/main.js');
    expect(r.output).toContain('int 0 object 1');
  });

  it('leaves keys, members, private names and declarations alone', () => {
    const src = [
      'import { __esm } from "./r.js";',
      'import { context, trace as tr } from "./api.js";',
      'const { context: c2 } = obj;',
      'class K { #context; context() { return this.#context; } }',
      'const o = { context, x: context, [context]: 1, get context() { return 1; } };',
      'f(context, ...tr);',
      'a.context = tr`x`;',
      '',
    ].join('\n');
    const out = liveEsbuildChunk(src);
    expect(out).toContain('const { context: c2 } = obj;');
    expect(out).toContain('class K { #context; context() { return this.#context; } }');
    expect(out).toContain('const o = { context: __shiro_live1.context, x: __shiro_live1.context, [__shiro_live1.context]: 1, get context() { return 1; } };');
    expect(out).toContain('f(__shiro_live1.context, ...__shiro_live1.trace);');
    expect(out).toContain('a.context = (0, __shiro_live1.trace)`x`;');
    // and still compiles after the regular transform
    expect(() => new Function('__shiro_require', '__shiro_module', transformESModules(src))).not.toThrow();
  });
});

describe('node builtins used by agent CLIs', () => {
  it('node:dns/promises resolves', async () => {
    const { shell } = await shellWith({
      '/d/main.mjs': 'import dns from "node:dns/promises";\nconst r = await dns.lookup("example.com");\nconsole.log("dns", typeof dns.resolve4, r.family);\n',
    });
    const r = await run(shell, 'node /d/main.mjs');
    expect(r.output).toContain('dns function 4');
  });

  it('utimes sets the mtime stat reports, and stat agrees with itself', async () => {
    const { shell } = await shellWith({
      '/u/main.js': [
        'const fs = require("fs");',
        'fs.mkdirSync("/u/x.lock");',
        'const a = fs.statSync("/u/x.lock").mtimeMs;',
        'setTimeout(() => {',
        '  const b = fs.statSync("/u/x.lock").mtimeMs;',
        '  const t = new Date(Date.now() - 60000);',
        '  fs.utimes("/u/x.lock", t, t, (e) => {',
        '    fs.stat("/u/x.lock", (e2, st) => console.log("stable", a === b, "set", e === null && st.mtimeMs === t.getTime()));',
        '  });',
        '}, 30);',
        '',
      ].join('\n'),
    });
    const r = await run(shell, 'node /u/main.js');
    expect(r.output).toContain('stable true set true');
  });

  it('spawn passes options.env to the child', async () => {
    const { shell } = await shellWith({
      '/s/main.js': [
        'const { spawn } = require("child_process");',
        'const c = spawn("sh", ["-c", "echo relaunched=$GEMINI_CLI_NO_RELAUNCH"], { env: { ...process.env, GEMINI_CLI_NO_RELAUNCH: "true" } });',
        'c.stdout.on("data", (d) => process.stdout.write(String(d)));',
        '',
      ].join('\n'),
    });
    const r = await run(shell, 'node /s/main.js');
    expect(r.output).toContain('relaunched=true');
  });
});

describe('curl -o', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('writes the body bytes as they came, without a trailing newline', async () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x80, 0xff, 0x00, 0xc3]);
    vi.stubGlobal('fetch', async () => new Response(bytes, { status: 200 }));
    const { fs, shell } = await createTestShell();
    expect((await run(shell, 'curl -fsSLo /tmp/bin https://example.com/bin')).exitCode).toBe(0);
    expect(Array.from(await fs.readFile('/tmp/bin') as Uint8Array)).toEqual(Array.from(bytes));
    await run(shell, 'cd /tmp && curl -sO https://example.com/dl/tool.bin');
    expect((await fs.readFile('/tmp/tool.bin') as Uint8Array).length).toBe(bytes.length);
  });
});
