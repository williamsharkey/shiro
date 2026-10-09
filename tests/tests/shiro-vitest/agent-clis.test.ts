/**
 * Shiro-side fixes found running AI coding-agent CLIs (docs/COMPAT.md
 * "Agent CLIs"): Gemini CLI's esbuild chunks (top-level await, live ESM
 * bindings), dns/promises, utimes/stat mtimes (proper-lockfile), spawn env,
 * and curl -o of binary files.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestShell, run } from './helpers';
import { transformESModules } from '@shiro/commands/jseval/module-transform';
import { isEsbuildChunk, liveEsbuildChunk } from '@shiro/commands/jseval/esm-live';
import { claudeCmd } from '@shiro/commands/claude';

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

describe('claude --native', () => {
  it('explains where the binary goes when there is none', async () => {
    const { shell } = await createTestShell();
    shell.commands.register(claudeCmd);
    const r = await run(shell, 'CLAUDE_NATIVE_PATH=/nowhere/claude claude --native --version');
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('no binary at /nowhere/claude');
    expect(r.output).toContain('linux-x64-musl');
  });

  it('runs the ELF at CLAUDE_NATIVE_PATH in Blink, with --native or CLAUDE_NATIVE=1', async () => {
    const { fs, shell } = await createTestShell();
    shell.commands.register(claudeCmd);
    await fs.mkdir('/opt/n', { recursive: true });
    await fs.writeFile('/opt/n/claude', readFileSync(resolve(__dirname, 'fixtures/x86/hello-musl')), { mode: 0o755 });
    await fs.writeFile('/home/user/input.txt', 'hi from shiro\n');
    await run(shell, 'cd /home/user');
    let r = await run(shell, "CLAUDE_NATIVE_PATH=/opt/n/claude claude --native a 'b c' < /dev/null");
    expect(r.output).toContain('hello from c');
    expect(r.output).toContain('arg1=a');
    expect(r.output).toContain('arg2=b c');
    r = await run(shell, 'CLAUDE_NATIVE=1 CLAUDE_NATIVE_PATH=/opt/n/claude claude fail < /dev/null; echo "status=$?"');
    expect(r.output).toContain('status=7');
  }, 60_000);
});

describe('claude install --native', () => {
  // A .deb: ar archive with an uncompressed data.tar holding `files`
  function tarOf(files: Record<string, Uint8Array>): Uint8Array {
    const blocks: Uint8Array[] = [];
    for (const [name, data] of Object.entries(files)) {
      const h = new Uint8Array(512);
      const put = (s: string, off: number) => h.set(new TextEncoder().encode(s), off);
      put(name, 0); put('0000755\0', 100); put('0000000\0', 108); put('0000000\0', 116);
      put(data.length.toString(8).padStart(11, '0') + '\0', 124); put('00000000000\0', 136);
      put('        ', 148); put('0', 156); put('ustar\0', 257); put('00', 263);
      put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
      blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
    }
    blocks.push(new Uint8Array(1024));
    const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
    let o = 0; for (const b of blocks) { out.set(b, o); o += b.length; }
    return out;
  }
  function debOf(tar: Uint8Array): Uint8Array {
    const enc = new TextEncoder();
    const member = (name: string, data: Uint8Array) => {
      const h = enc.encode(`${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\`\n`);
      return [h, data, data.length & 1 ? enc.encode('\n') : new Uint8Array(0)];
    };
    const parts = [enc.encode('!<arch>\n'), ...member('debian-binary', enc.encode('2.0\n')), ...member('data.tar', tar)];
    const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let o = 0; for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }
  const hex = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');

  async function setup(binary: Uint8Array, manifestSum: string) {
    const { installNativeClaude } = await import('@shiro/commands/claude-native');
    const { fs } = await createTestShell();
    // The test FileSystem is shared between tests (one IndexedDB)
    for (const p of ['/home/user/.local/bin/claude', '/lib/ld-musl-x86_64.so.1']) await fs.unlink(p).catch(() => {});
    await fs.mkdir('/usr/lib/pkg/curl/bin', { recursive: true });
    await fs.writeFile('/usr/lib/pkg/curl/bin/curl', new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
    const libc = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
    const deb = debOf(tarOf({ './usr/lib/x86_64-linux-musl/libc.so': libc }));
    const urls: Record<string, Uint8Array | string> = {
      'https://downloads.claude.ai/claude-code-releases/latest': '9.9.9\n',
      'https://downloads.claude.ai/claude-code-releases/9.9.9/manifest.json': JSON.stringify({ platforms: { 'linux-x64-musl': { checksum: manifestSum, size: binary.length } } }),
      'https://downloads.claude.ai/claude-code-releases/9.9.9/linux-x64-musl/claude': binary,
      'https://mirror.test/musl.deb': deb,
    };
    const lines: string[] = [];
    const shell = {
      async execute(line: string, out: (s: string) => void) {
        lines.push(line);
        const url = /(https:\/\/[^\s']+)'?\s*$/.exec(line)?.[1];
        const body = url ? urls[url] : undefined;
        if (body === undefined) return 22;
        const o = /-o '?([^\s']+)'?/.exec(line)?.[1];
        if (o) await fs.writeFile(o, body);
        else out(typeof body === 'string' ? body : '');
        return 0;
      },
    };
    const ctx: any = { fs, shell, env: { HOME: '/home/user', HTTPS_PROXY: 'http://proxy.test:3128' }, cwd: '/', stdout: '', stderr: '', args: [] };
    const muslDeb = { urls: ['https://mirror.test/musl.deb'], sha256: await hex(deb), libc: 'usr/lib/x86_64-linux-musl/libc.so' };
    return { fs, ctx, lines, run: () => installNativeClaude(ctx, '/home/user/.local/bin/claude', undefined, muslDeb), libc };
  }

  it('downloads the latest musl build, checks its sha256 and installs musl\'s loader', async () => {
    const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 9, 9, 9]);
    const { fs, ctx, lines, run, libc } = await setup(binary, await hex(binary));
    expect(await run()).toBe(0);
    expect(Array.from(await fs.readFile('/home/user/.local/bin/claude') as Uint8Array)).toEqual(Array.from(binary));
    expect(Array.from(await fs.readFile('/lib/ld-musl-x86_64.so.1') as Uint8Array)).toEqual(Array.from(libc));
    expect(ctx.stdout).toContain('Installed Claude Code 9.9.9');
    expect(lines.every((l) => !l.includes('/usr/lib/pkg/curl/bin/curl') || l.startsWith("HTTPS_PROXY='http://proxy.test:3128' "))).toBe(true);
  });

  it('refuses a binary whose sha256 differs from the manifest', async () => {
    const { fs, ctx, run } = await setup(new Uint8Array([1, 2, 3]), 'f'.repeat(64));
    expect(await run()).toBe(1);
    expect(ctx.stderr).toContain('sha256 mismatch');
    expect(await fs.exists('/home/user/.local/bin/claude')).toBe(false);
  });

  it('fails with a pointer to the relay when the guest has no network', async () => {
    const { ctx } = await setup(new Uint8Array([1]), 'f'.repeat(64));
    const { installNativeClaude } = await import('@shiro/commands/claude-native');
    ctx.shell = { execute: async () => 7 };
    expect(await installNativeClaude(ctx, '/home/user/.local/bin/claude')).toBe(1);
    expect(ctx.stderr).toContain('TCP relay');
  });
});
