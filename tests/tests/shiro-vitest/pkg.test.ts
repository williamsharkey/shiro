import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import { TtySession } from '@shiro/kernel/pty';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import {
  parseIndex, builtinIndex, resolveDeps, installPackages, removePackage, readStatus,
  packageStatus, findEntry, missingFeatures, type PkgIndex, type PkgEntry,
} from '@shiro/pkg-manager';
import { parseWebc, webcCommands, decodeCbor } from '@shiro/webc';
import { extractWasmFromWebc, findPackage, downloadPackage } from '@shiro/wasi-packages';

const REPO = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/\/$/, '');
const CACHE = `${REPO}/tests/.pkg-cache`;
const realFetch = globalThis.fetch;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function sh(shell: Shell, cmd: string) {
  let out = '';
  let err = '';
  const exitCode = await shell.execute(cmd, s => { out += s; }, s => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), exitCode };
}

// ── fetch stub ────────────────────────────────────────────────────────
// "/pkg/..." (the Shiro mirror) is served from public/pkg in this repo.
// Registry downloads go to the network once and are cached in tests/.pkg-cache.
// Extra URLs can be served from memory.

const served = new Map<string, Uint8Array>();

async function fakeFetch(input: any): Promise<Response> {
  const url = String(input);
  const mem = served.get(url);
  if (mem) return new Response(mem);
  const m = url.match(/^https?:\/\/[^/]+(\/pkg\/.*)$/);
  if (m) {
    const file = `${REPO}/public${m[1]}`;
    return existsSync(file) ? new Response(readFileSync(file)) : new Response('not found', { status: 404 });
  }
  if (url.startsWith('https://cdn.wasmer.io/')) {
    const file = `${CACHE}/${url.split('/').pop()}`;
    if (!existsSync(file)) {
      const resp = await realFetch(url);
      if (!resp.ok) return resp;
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(file, new Uint8Array(await resp.arrayBuffer()));
    }
    return new Response(readFileSync(file));
  }
  return new Response('no route', { status: 404 });
}

// ── tiny WASI programs and WebC containers built in the test ────────────

function leb(n: number): number[] {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
const str = (s: string) => { const b = [...new TextEncoder().encode(s)]; return [...leb(b.length), ...b]; };
const sec = (id: number, payload: number[]) => [id, ...leb(payload.length), ...payload];

/** A WASI program that writes `msg` to stdout and exits with `code`, importing from `abi`. */
function printWasm(msg: string, code = 0, abi = 'wasi_snapshot_preview1'): Uint8Array {
  const text = [...new TextEncoder().encode(msg)];
  const body = [0,
    0x41, 0, 0x41, 16, 0x36, 2, 0,            // iov.base = 16
    0x41, 4, 0x41, ...leb(text.length), 0x36, 2, 0, // iov.len
    0x41, 1, 0x41, 0, 0x41, 1, 0x41, 8, 0x10, 0, 0x1a, // fd_write(1, iov, 1, &n)
    0x41, code, 0x10, 1, 0x0b];               // proc_exit(code)
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...sec(1, [3, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
    ...sec(2, [2, ...str(abi), ...str('fd_write'), 0, 0, ...str(abi), ...str('proc_exit'), 0, 1]),
    ...sec(3, [1, 2]),
    ...sec(5, [1, 0, 1]),
    ...sec(7, [2, ...str('memory'), 2, 0, ...str('_start'), 0, 2]),
    ...sec(10, [1, ...leb(body.length), ...body]),
    ...sec(11, [1, 0, 0x41, 16, 0x0b, ...leb(text.length), ...text]),
  ]);
}

function cbor(v: any): number[] {
  const head = (major: number, n: number) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255];
  if (typeof v === 'string') { const b = [...new TextEncoder().encode(v)]; return [...head(3, b.length), ...b]; }
  if (Array.isArray(v)) return [...head(4, v.length), ...v.flatMap(cbor)];
  const e = Object.entries(v);
  return [...head(5, e.length), ...e.flatMap(([k, x]) => [...cbor(k), ...cbor(x)])];
}

const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return [...b]; };
const lenPrefixed = (b: number[]) => [...u64(b.length), ...b];

/** WebC v2 volume/atoms header + data for a flat directory of files (and one subdir). */
function webcVolume(files: Record<string, Uint8Array>): { header: number[]; data: number[] } {
  const data: number[] = [];
  const fileEntries: Array<{ name: string; start: number; end: number }> = [];
  for (const [name, bytes] of Object.entries(files)) {
    fileEntries.push({ name, start: data.length, end: data.length + bytes.length });
    data.push(...bytes);
  }
  // root dir: [30][u64 len][entries...] ; entry = u64 offset, u64 namelen, name
  const nameBytes = fileEntries.map(f => [...new TextEncoder().encode(f.name)]);
  const entriesLen = nameBytes.reduce((n, b) => n + 16 + b.length, 0);
  let offset = 9 + entriesLen;
  const entries: number[] = [];
  const fileHeaders: number[] = [];
  fileEntries.forEach((f, i) => {
    entries.push(...u64(offset), ...u64(nameBytes[i].length), ...nameBytes[i]);
    const fh = [31, ...u64(f.start), ...u64(f.end), ...new Array(32).fill(0)];
    fileHeaders.push(...fh);
    offset += fh.length;
  });
  return { header: [30, ...u64(entriesLen), ...entries, ...fileHeaders], data };
}

function buildWebc(manifest: any, atoms: Record<string, Uint8Array>, volumes: Record<string, Record<string, Uint8Array>> = {}): Uint8Array {
  const out = [...new TextEncoder().encode('\0webc002')];
  const m = cbor(manifest);
  out.push(1, ...lenPrefixed(m));
  const a = webcVolume(atoms);
  out.push(3, ...lenPrefixed([...lenPrefixed(a.header), ...lenPrefixed(a.data)]));
  for (const [name, files] of Object.entries(volumes)) {
    // volumes may nest one directory level: { "fonts/a.flf": bytes } is not supported here;
    // files go at the root of the volume
    const v = webcVolume(files);
    out.push(4, ...lenPrefixed([...lenPrefixed([...new TextEncoder().encode(name)]), ...lenPrefixed(v.header), ...lenPrefixed(v.data)]));
  }
  return new Uint8Array(out);
}

function testEntry(name: string, url: string, bytes: Uint8Array, extra: Partial<PkgEntry> = {}): PkgEntry {
  return {
    name, version: '1.0', description: `${name} test package`, license: 'MIT', source: 'https://example.test/src',
    origin: 'shiro', section: 'test', abi: 'wasi_snapshot_preview1',
    files: [{ path: `bin/${name}.wasm`, url, sha256: sha256(bytes), size: bytes.length }],
    bin: { [name]: { file: `bin/${name}.wasm` } },
    ...extra,
  };
}

async function writeList(fs: FileSystem, index: PkgIndex) {
  await fs.mkdir('/var/lib/pkg/lists', { recursive: true });
  await fs.writeFile('/var/lib/pkg/lists/test.json', JSON.stringify(index));
}

// ═══════════════════════════════════════════════════════════════════

describe('package index', () => {
  it('the built-in index parses and every package names a license and a source', () => {
    const idx = builtinIndex();
    expect(idx.packages.length).toBeGreaterThan(20);
    for (const p of idx.packages) {
      expect(p.license, p.name).toBeTruthy();
      expect(p.source, p.name).toMatch(/^https?:\/\//);
      for (const f of p.files) expect(f.sha256, `${p.name} ${f.path}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('packages built here are in public/pkg with the pinned sha256, size, and a recipe', () => {
    const own = builtinIndex().packages.filter(p => p.origin === 'shiro');
    expect(own.map(p => p.name)).toEqual(expect.arrayContaining(['coreutils', 'jq', 'lua', 'sqlite', 'less', 'vim']));
    for (const p of own) {
      expect(existsSync(`${REPO}/${p.recipe}`), p.recipe).toBe(true);
      for (const f of p.files) {
        const bytes = readFileSync(`${REPO}/public${f.url}`);
        expect(bytes.length, f.url).toBe(f.size);
        expect(sha256(bytes), f.url).toBe(f.sha256);
      }
    }
  });

  it('wasmer downloads are pinned by content address (the URL is the sha256)', () => {
    for (const p of builtinIndex().packages.filter(p => p.origin === 'wasmer')) {
      for (const f of p.files) expect(f.url).toBe(`https://cdn.wasmer.io/webcimages/${f.sha256}.webc`);
    }
  });

  it('WASIX packages are blocked until a kernel provides the features', () => {
    const bash = findEntry(builtinIndex(), 'bash')!;
    expect(bash.abi).toBe('wasix');
    expect(packageStatus(bash)).toBe('blocked');
    expect(packageStatus(findEntry(builtinIndex(), 'jq')!)).toBe('ok');
    expect(packageStatus(findEntry(builtinIndex(), 'lua')!)).toBe('partial'); // REPL wants blocking stdin
    (globalThis as any).__shiroKernel = { features: ['wasix', 'processes', 'threads', 'wasix-stack'] };
    try {
      expect(packageStatus(bash)).toBe('partial');
    } finally {
      delete (globalThis as any).__shiroKernel;
    }
  });

  const good = () => ({ format: 1, packages: [testEntry('a', 'https://x.test/a.wasm', new Uint8Array([1]))] });

  it('parseIndex accepts a minimal index and rejects malformed ones', () => {
    expect(parseIndex(good()).packages[0].name).toBe('a');
    const bad = (mut: (d: any) => void, msg: RegExp) => {
      const d = good(); mut(d);
      expect(() => parseIndex(d)).toThrow(msg);
    };
    bad(d => { d.format = 2; }, /format/);
    bad(d => { d.packages[0].files[0].sha256 = 'abc'; }, /sha256/);
    bad(d => { d.packages[0].files[0].path = '../etc/passwd'; }, /file path/);
    bad(d => { d.packages[0].files[0].url = 'http://insecure/a.wasm'; }, /url/);
    bad(d => { d.packages[0].bin = { a: { file: 'bin/other.wasm' } }; }, /unknown file/);
    bad(d => { d.packages[0].deps = ['missing']; }, /unknown dependency/);
    bad(d => { d.packages[0].needs = ['telepathy']; }, /needs/);
    bad(d => { d.packages.push(d.packages[0]); }, /duplicate/);
    bad(d => { delete d.packages[0].license; }, /license/);
  });

  it('resolveDeps orders dependencies first and detects cycles', () => {
    const b = new Uint8Array([1]);
    const idx: PkgIndex = { format: 1, packages: [
      testEntry('app', 'https://x.test/app', b, { deps: ['lib'] }),
      testEntry('lib', 'https://x.test/lib', b, { deps: ['base'] }),
      testEntry('base', 'https://x.test/base', b),
    ] };
    expect(resolveDeps(idx, ['app']).map(p => p.name)).toEqual(['base', 'lib', 'app']);
    idx.packages[2].deps = ['app'];
    expect(() => resolveDeps(idx, ['app'])).toThrow(/cycle/);
    expect(() => resolveDeps(idx, ['nope'])).toThrow(/unable to locate/);
  });
});

describe('webc reader', () => {
  it('reads atoms, volumes and commands from a v2 container', () => {
    const hello = printWasm('hi');
    const webc = buildWebc(
      { entrypoint: 'hello', commands: { hello: { annotations: { wasi: { atom: 'hello' } } }, hi: { annotations: { wasi: { atom: 'hello' } } } } },
      { hello },
      { atom: { 'font.flf': new TextEncoder().encode('flf2a') } },
    );
    const pkg = parseWebc(webc);
    expect(pkg.version).toBe(2);
    expect([...pkg.atoms.keys()]).toEqual(['hello']);
    expect(pkg.atoms.get('hello')).toEqual(hello);
    expect(pkg.volumes.get('atom')!.files.map(f => f.path)).toEqual(['/font.flf']);
    expect(webcCommands(pkg).map(c => `${c.name}:${c.atom}`)).toEqual(['hello:hello', 'hi:hello']);
    // the legacy single-binary extractor now uses the real reader
    expect(new Uint8Array(extractWasmFromWebc(webc.slice().buffer)!)).toEqual(hello);
  });

  it('decodes the CBOR a manifest uses', () => {
    expect(decodeCbor(new Uint8Array(cbor({ a: ['x', 'yz'], b: {} })))).toEqual({ a: ['x', 'yz'], b: {} });
    expect(decodeCbor(new Uint8Array([0xf5]))).toBe(true);
    expect(decodeCbor(new Uint8Array([0x39, 0x01, 0x00]))).toBe(-257);
  });

  it('rejects truncated containers', () => {
    const webc = buildWebc({}, { a: printWasm('x') });
    expect(() => parseWebc(webc.slice(0, webc.length - 10))).toThrow(/overruns/);
  });
});

describe('pkg install / remove', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    served.clear();
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function addTestPackage(name: string, msg: string, extra: Partial<PkgEntry> = {}) {
    const bytes = printWasm(msg);
    const url = `https://example.test/${name}.wasm`;
    served.set(url, bytes);
    const entry = testEntry(name, url, bytes, extra);
    await writeList(fs, { format: 1, packages: [entry] });
    return entry;
  }

  it('installs into /usr/lib/pkg, links /usr/bin, records status, and runs from PATH', async () => {
    await addTestPackage('hello', 'hello from a package\n');
    const r = await sh(shell, 'pkg install hello');
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('Setting up hello (1.0)');

    expect(await fs.readlink('/usr/bin/hello')).toBe('/usr/lib/pkg/hello/bin/hello.wasm');
    expect((await fs.stat('/usr/lib/pkg/hello/bin/hello.wasm')).type).toBe('file');
    const status = await readStatus(fs);
    expect(status.hello.version).toBe('1.0');
    expect(status.hello.bins).toEqual(['hello']);

    expect((await sh(shell, 'which hello')).out.trim()).toBe('/usr/bin/hello');
    const run = await sh(shell, 'hello');
    expect(run.exitCode).toBe(0);
    expect(run.out).toBe('hello from a package\n');
    expect((await sh(shell, 'hello | wc -l')).out.trim()).toBe('1');

    expect((await sh(shell, 'pkg list')).out).toContain('hello');
    expect((await sh(shell, 'pkg files hello')).out).toContain('/usr/bin/hello');
  });

  it('remove deletes the files, the link and the status entry', async () => {
    await addTestPackage('hello', 'hi\n');
    await sh(shell, 'pkg install hello');
    const r = await sh(shell, 'apt-get remove -y hello');
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/usr/bin/hello')).toBe(false);
    expect(await fs.exists('/usr/lib/pkg/hello')).toBe(false);
    expect((await readStatus(fs)).hello).toBeUndefined();
    expect((await sh(shell, 'hello')).exitCode).toBe(127);
    expect((await sh(shell, 'pkg remove hello')).err).toContain('not installed');
  });

  it('refuses a download whose sha256 differs and leaves nothing behind', async () => {
    const entry = await addTestPackage('hello', 'hi\n');
    served.set(entry.files[0].url, printWasm('tampered\n'));
    const r = await sh(shell, 'pkg install hello');
    expect(r.exitCode).toBe(100);
    expect(r.err).toContain('sha256 mismatch');
    expect(await fs.exists('/usr/bin/hello')).toBe(false);
    expect((await readStatus(fs)).hello).toBeUndefined();
  });

  it('installs dependencies first and keeps them while something depends on them', async () => {
    const lib = printWasm('lib\n');
    const app = printWasm('app\n');
    served.set('https://example.test/lib.wasm', lib);
    served.set('https://example.test/app.wasm', app);
    await writeList(fs, { format: 1, packages: [
      testEntry('libthing', 'https://example.test/lib.wasm', lib),
      testEntry('app', 'https://example.test/app.wasm', app, { deps: ['libthing'] }),
    ] });
    const r = await sh(shell, 'apt install app');
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/libthing app/);
    expect(Object.keys(await readStatus(fs)).sort()).toEqual(['app', 'libthing']);
    expect((await sh(shell, 'pkg remove libthing')).err).toContain('needed by app');
    expect((await sh(shell, 'pkg remove app libthing')).exitCode).toBe(0);
  });

  it('extracts atoms and data volumes from WebC packages', async () => {
    const tool = printWasm('tool\n');
    const webc = buildWebc({ commands: { tool: {} } }, { tool }, { atom: { 'data.txt': new TextEncoder().encode('payload') } });
    const url = 'https://example.test/tool.webc';
    served.set(url, webc);
    const common = { url, sha256: sha256(webc), size: webc.length };
    await writeList(fs, { format: 1, packages: [{
      ...testEntry('tool', url, tool),
      origin: 'wasmer',
      files: [
        { path: 'bin/tool.wasm', ...common, webc: { atom: 'tool' } },
        { path: 'share/tool', ...common, webc: { volume: 'atom', dir: '/' } },
      ],
    }] });
    expect((await sh(shell, 'pkg install tool')).exitCode).toBe(0);
    expect(await fs.readFile('/usr/lib/pkg/tool/share/tool/data.txt', 'utf8')).toBe('payload');
    expect((await sh(shell, 'tool')).out).toBe('tool\n');
    expect((fetch as any).mock.calls.filter((c: any[]) => String(c[0]) === url)).toHaveLength(1);
  });

  it('runs programs that import wasi_unstable (snapshot 0)', async () => {
    const bytes = printWasm('old abi\n', 0, 'wasi_unstable');
    served.set('https://example.test/old.wasm', bytes);
    await writeList(fs, { format: 1, packages: [testEntry('old', 'https://example.test/old.wasm', bytes, { abi: 'wasi_unstable' })] });
    await sh(shell, 'pkg install old');
    expect((await sh(shell, 'old')).out).toBe('old abi\n');
  });

  it('passes exit codes through', async () => {
    const bytes = printWasm('', 3);
    served.set('https://example.test/fail.wasm', bytes);
    await writeList(fs, { format: 1, packages: [testEntry('fail', 'https://example.test/fail.wasm', bytes)] });
    await sh(shell, 'pkg install fail');
    expect((await sh(shell, 'fail')).exitCode).toBe(3);
  });

  it('blocks packages needing kernel features: install needs --force, running exits 126', async () => {
    const r = await sh(shell, 'pkg install bash');
    expect(r.exitCode).toBe(100);
    expect(r.err).toMatch(/needs kernel support.*wasix/);
    expect(await fs.exists('/usr/bin/bash')).toBe(false);

    await addTestPackage('needy', 'never\n', { needs: ['threads'] });
    expect((await sh(shell, 'pkg install needy')).exitCode).toBe(100);
    expect((await sh(shell, 'pkg install --force needy')).exitCode).toBe(0);
    const run = await sh(shell, 'needy');
    expect(run.exitCode).toBe(126);
    expect(run.err).toContain('threads');
    expect((await sh(shell, 'SHIRO_PKG_FORCE=1 needy')).out).toBe('never\n');
  });

  it('suggests the package for a missing command', async () => {
    const r = await sh(shell, 'luac -v');
    expect(r.exitCode).toBe(127);
    expect(r.err).toContain('pkg install lua');
  });

  it('search, info, available and apt verbs', async () => {
    expect((await sh(shell, 'pkg search json')).out).toContain('jq');
    const info = await sh(shell, 'apt show sqlite3');
    expect(info.out).toContain('Package:     sqlite');
    expect(info.out).toContain('License:     blessing');
    expect(info.out).toContain('scripts/pkgbuild/sqlite.sh');
    const avail = await sh(shell, 'pkg available');
    expect(avail.out).toMatch(/bash .*\[needs kernel\]/);
    expect((await sh(shell, 'apt list')).out).toContain('coreutils');
    expect((await sh(shell, 'pkg info nope')).exitCode).toBe(1);
    expect((await sh(shell, 'pkg update')).exitCode).toBe(0);
  });
});

describe('real packages in the current runtime', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('lua 5.4.7: version, -e, scripts, errors', async () => {
    expect((await sh(shell, 'pkg install lua')).exitCode).toBe(0);
    expect((await sh(shell, 'lua -v')).out).toContain('Lua 5.4.7');
    expect((await sh(shell, `lua -e 'print(string.format("%d %s", 6*7, pcall(error, "x") and "?" or "caught"))'`)).out).toBe('42 caught\n');
    await fs.writeFile('/home/user/fib.lua', 'local function f(n) if n < 2 then return n end return f(n-1)+f(n-2) end print(f(20))\n');
    expect((await sh(shell, 'cd /home/user && lua fib.lua')).out).toBe('6765\n');
    expect((await sh(shell, `echo 'print(io.read("n") * 2)' > /home/user/d.lua; echo 21 | lua /home/user/d.lua`)).out).toBe('42\n');
    const err = await sh(shell, `lua -e 'error("boom")'`);
    expect(err.exitCode).toBe(1);
    expect(err.err).toContain('boom');
    expect((await sh(shell, 'luac -v')).out).toContain('Lua 5.4.7');
  });

  it('sqlite3 3.50.4: -version, queries, and a database file that persists', async () => {
    expect((await sh(shell, 'pkg install sqlite')).exitCode).toBe(0);
    expect((await sh(shell, 'sqlite3 -version')).out).toMatch(/^3\.50\.4 /);
    expect((await sh(shell, `sqlite3 :memory: 'select 6*7, sqrt(16);'`)).out).toBe('42|4.0\n');
    expect((await sh(shell, `echo 'select upper("piped");' | sqlite3`)).out).toBe('PIPED\n');
    await sh(shell, `cd /home/user && sqlite3 app.db "create table t(x); insert into t values ('kept');"`);
    expect((await fs.stat('/home/user/app.db')).size).toBeGreaterThan(0);
    expect((await sh(shell, `cd /home/user && sqlite3 app.db 'select x from t;'`)).out).toBe('kept\n');
  });

  it('jq 1.8.1 takes over from the builtin while installed', async () => {
    const before = (await sh(shell, 'jq --version')).out;
    expect(before).not.toContain('jq-1.8.1');
    await sh(shell, 'pkg install jq');
    expect((await sh(shell, 'jq --version')).out).toBe('jq-1.8.1\n');
    expect((await sh(shell, `echo '{"a":[1,2,3],"s":"Hello"}' | jq -c '{n:(.a|add), r:(.s|test("^h";"i"))}' | cat`)).out).toBe('{"n":6,"r":true}\n');
    expect((await sh(shell, `echo 1 | jq .`)).out).toContain('\x1b['); // colours on a terminal, like jq
    expect((await sh(shell, 'which jq')).out.trim()).toBe('/usr/bin/jq');
    expect((await sh(shell, 'builtin jq --version')).out).toBe(before);
    await sh(shell, 'pkg remove jq');
    expect((await sh(shell, 'jq --version')).out).toBe(before);
  });

  it('coreutils: multi-call binary and applets by argv[0], builtins stay put', async () => {
    expect((await sh(shell, 'pkg install coreutils')).exitCode).toBe(0);
    await fs.mkdir('/home/user/d', { recursive: true });
    await fs.writeFile('/home/user/d/b.txt', 'beta\nalpha\n');
    await fs.writeFile('/home/user/d/a.txt', 'x\n');
    expect((await sh(shell, 'cd /home/user/d && coreutils ls | cat')).out).toBe('a.txt\nb.txt\n');
    expect((await sh(shell, 'cd /home/user/d && coreutils ls')).out).toBe('a.txt  b.txt\n'); // a terminal gets columns
    expect((await sh(shell, 'cd /home/user/d && /usr/bin/sort b.txt')).out).toBe('alpha\nbeta\n');
    expect((await sh(shell, 'coreutils sha256sum /home/user/d/a.txt')).out)
      .toBe(`${sha256(new TextEncoder().encode('x\n'))}  /home/user/d/a.txt\n`);
    expect((await sh(shell, 'coreutils --version')).out).toContain('coreutils 0.12.0');
    expect((await sh(shell, 'type ls')).out).not.toContain('/usr/bin/ls'); // applets don't shadow builtins
  });

  it('wasi exec and the legacy single-binary API use the verified index', async () => {
    expect(findPackage('sqlite3')?.name).toBe('sqlite');
    const bin = await downloadPackage('jq');
    expect(new Uint8Array(bin).slice(0, 4)).toEqual(new Uint8Array([0, 0x61, 0x73, 0x6d]));
    expect((await sh(shell, `echo '[1,2]' | wasi exec jq -c 'map(.*10)' | cat`)).out).toBe('[10,20]\n');
  });
});

// The same packages as kernel processes (src/wasi): what a cross-origin
// isolated page (SharedArrayBuffer) or Chrome with JSPI runs. Guests are
// Node worker threads, as in kernel-wasi.test.ts.
describe('real packages as kernel processes', () => {
  let shell: Shell;
  let fs: FileSystem;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(`${process.env.TMPDIR || '/tmp'}/shiro-pkg-kernel-`);
    writeFileSync(`${tmp}/entry.ts`, `
      import { parentPort } from 'node:worker_threads';
      import { guestMain } from ${JSON.stringify(`${REPO}/src/wasi/guest-worker.ts`)};
      const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
      parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
      guestMain(port);
    `);
    await build({ entryPoints: [`${tmp}/entry.ts`], bundle: true, platform: 'node', format: 'esm', outfile: `${tmp}/guest.mjs`, logLevel: 'error' });
    setGuestWorkerFactory(() => {
      const w = new Worker(`${tmp}/guest.mjs`);
      return {
        postMessage: (m) => w.postMessage(m),
        terminate: () => w.terminate(),
        onMessage: (cb) => { w.on('message', cb); },
        onError: (cb) => { w.on('error', cb); },
      };
    });
    forceWasmProcessMode('sab');
  });
  afterAll(() => {
    forceWasmProcessMode(null);
    setGuestWorkerFactory(null);
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('runs packages with files opened on demand, absolute paths, and piped stdin', async () => {
    expect((await sh(shell, 'pkg install lua sqlite jq coreutils')).exitCode).toBe(0);
    expect((await sh(shell, `echo 'print(1+1)' | lua`)).out).toBe('2\n'); // piped stdin is not a terminal
    expect((await sh(shell, 'coreutils ls /usr/lib/pkg | cat')).out).toMatch(/^coreutils\n(.*\n)*lua\n(.*\n)*sqlite\n/);
    await sh(shell, `cd /home/user && sqlite3 k.db "create table t(x); insert into t values (7);"`);
    expect((await sh(shell, `cd /home/user && sqlite3 k.db 'select x * 6 from t;'`)).out).toBe('42\n');
    expect((await sh(shell, `echo '[3,4]' | jq -c 'map(. * 2)' | cat`)).out).toBe('[6,8]\n');
  }, 60_000);

  it('every WASIX package in the index is installable where WASM processes have threads', () => {
    // wasix-stack, sockets, dynamic-linking and mounts came with unix/wasix
    for (const p of builtinIndex().packages.filter(p => p.abi === 'wasix')) {
      expect([p.name, missingFeatures(p)]).toEqual([p.name, []]);
    }
  });

  it('WASIX grep, sed, ripgrep and quickjs-ng run (network)', async (ctx) => {
    try {
      await fakeFetch('https://cdn.wasmer.io/webcimages/42a2dd5452990c94a51036cfb5eb9574899beccb5ce8f83f75995f7ac5e0e1ca.webc');
    } catch {
      ctx.skip();
    }
    expect((await sh(shell, 'pkg install grep-wasix sed-wasix ripgrep quickjs-ng')).exitCode).toBe(0);
    await fs.writeFile('/home/user/w.txt', 'b\na\nfoo bar\n');
    expect((await sh(shell, 'cd /home/user && /usr/bin/grep -n foo w.txt')).out).toBe('3:foo bar\n');
    expect((await sh(shell, 'cd /home/user && /usr/bin/sed -i s/foo/FOO/ w.txt && cat w.txt')).out).toBe('b\na\nFOO bar\n');
    expect((await sh(shell, 'echo hello | /usr/bin/sed s/l/L/g')).out).toBe('heLLo\n');
    expect((await sh(shell, 'cd /home/user && /usr/bin/rg -n bar w.txt')).out).toBe('3:FOO bar\n');
    expect((await sh(shell, `qjs-ng -e 'console.log(6*7)'`)).out).toBe('42\n');
    expect((await sh(shell, 'type grep')).out).not.toContain('/usr/bin/grep'); // the builtin keeps the name
  }, 120_000);

  describe('on the terminal pty', () => {
    /** A terminal stand-in with a pty session (as in kernel-shell.test.ts) */
    function fakeTerminal() {
      const tty = new TtySession();
      let screen = '';
      tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
      return {
        tty,
        screen: () => screen,
        writeOutput: (t: string) => { screen += t; },
        enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {},
        isRawMode: () => false, onResize: () => () => {},
        getSize: () => ({ rows: tty.pty.winsize.rows, cols: tty.pty.winsize.cols }),
        term: null,
      };
    }
    const until = async (cond: () => boolean, ms = 10_000) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timed out');
        await new Promise(r => setTimeout(r, 5));
      }
    };

    it('lua and sqlite3 REPLs read the tty interactively', async () => {
      await sh(shell, 'pkg install lua sqlite');
      let term = fakeTerminal();
      let r = shell.execute('lua', () => {}, () => {}, false, term);
      await until(() => term.tty.jobInForeground && term.screen().includes('> '));
      term.tty.pty.input('print(6*7)\r');
      await until(() => term.screen().includes('42'));
      term.tty.pty.input('\x04');
      expect(await r).toBe(0);
      expect(term.screen()).toContain('Lua 5.4.7');

      term = fakeTerminal();
      r = shell.execute('cd /home/user && sqlite3 repl.db', () => {}, () => {}, false, term);
      await until(() => term.tty.jobInForeground && term.screen().includes('sqlite> '));
      term.tty.pty.input('create table t(x); insert into t values (6);\r');
      term.tty.pty.input('select x * 7 from t;\r');
      await until(() => term.screen().includes('42'));
      term.tty.pty.input('.quit\r');
      expect(await r).toBe(0);
      expect((await sh(shell, `cd /home/user && sqlite3 repl.db 'select count(*) from t;'`)).out).toBe('1\n');
    }, 60_000);
  });
});

// Downloads from cdn.wasmer.io (cached in tests/.pkg-cache). Skipped offline.
describe('registry packages (network)', () => {
  let shell: Shell;
  let online = true;

  beforeEach(async (ctx) => {
    ({ shell } = await createTestShell());
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
    if (online) {
      try {
        await fakeFetch('https://cdn.wasmer.io/webcimages/c7e7487ac3a41c18862f0bc76e8af0def0f12c4167d6fce5c1cc1b5d061f6bb7.webc');
      } catch {
        online = false;
      }
    }
    if (!online) ctx.skip();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('cowsay and figlet (preview1, figlet reads its fonts volume)', async () => {
    expect((await sh(shell, 'pkg install cowsay figlet')).exitCode).toBe(0);
    expect((await sh(shell, 'cowsay moo')).out).toContain('< moo >');
    const fig = await sh(shell, 'figlet Hi');
    expect(fig.exitCode).toBe(0);
    expect(fig.out).toContain('|_| |_|_|');
  }, 60_000);

  it('openssl and qr2text (wasi_unstable through the snapshot-0 adapter)', async () => {
    expect((await sh(shell, 'pkg install openssl qr2text')).exitCode).toBe(0);
    await shell.fs.writeFile('/home/user/abc.txt', 'abc');
    const dgst = await sh(shell, 'cd /home/user && openssl dgst -sha256 abc.txt');
    expect(dgst.out).toContain('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect((await sh(shell, 'qr2text shiro')).exitCode).toBe(0);
  }, 60_000);

  it('wabt round-trips a module', async () => {
    expect((await sh(shell, 'pkg install wabt')).exitCode).toBe(0);
    await shell.fs.writeFile('/home/user/t.wat', '(module (func (export "f") (result i32) i32.const 42))');
    expect((await sh(shell, 'cd /home/user && wat2wasm t.wat -o t.wasm')).exitCode).toBe(0);
    expect((await sh(shell, 'cd /home/user && wasm2wat t.wasm')).out).toContain('i32.const 42');
  }, 60_000);
});
