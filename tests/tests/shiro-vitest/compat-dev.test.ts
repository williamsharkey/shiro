/**
 * Languages and toolchains (docs/COMPAT.md, "Languages and toolchains"):
 * one smoke test per scoreboard row, plus the shell/kernel fixes they needed.
 *
 * WASM guests run in Node worker_threads as kernel processes (sab mode), as
 * in kernel-shell.test.ts. Packages built here are read from public/pkg.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import { setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import { readTarball } from '@shiro/utils/tar';
import { createPathShims } from '@shiro/path-shims';
import { simpleCommandWords } from '@shiro/kernel/kernel';

const here = __dirname;
const REPO = path.resolve(here, '../../..');
const srcWasi = path.join(REPO, 'src/wasi');
const CACHE = `${REPO}/tests/.pkg-cache`;
let tmp: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-compat-dev-'));
  const entry = path.join(tmp, 'entry.ts');
  writeFileSync(entry, `
    import { parentPort } from 'node:worker_threads';
    import { guestMain } from ${JSON.stringify(path.join(srcWasi, 'guest-worker.ts'))};
    const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
    parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
    guestMain(port);
  `);
  const workerFile = path.join(tmp, 'guest-worker.mjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: workerFile, logLevel: 'error' });
  setGuestWorkerFactory((): GuestWorker => {
    const w = new Worker(workerFile);
    return {
      postMessage: (m) => w.postMessage(m),
      terminate: () => w.terminate(),
      onMessage: (cb) => { w.on('message', cb); },
      onError: (cb) => { w.on('error', cb); },
    };
  });
  forceWasmProcessMode('sab');
  // "/pkg/..." (the Shiro mirror) comes from public/pkg
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const m = url.match(/^https?:\/\/[^/]+(\/pkg\/.*)$/);
    if (m) {
      const file = `${REPO}/public${m[1]}`;
      return existsSync(file) ? new Response(readFileSync(file)) : new Response('not found', { status: 404 });
    }
    // Package downloads from npm go to the network once, then tests/.pkg-cache
    if (url.startsWith('https://registry.npmjs.org/') && url.endsWith('.tgz')) {
      const file = `${CACHE}/${url.split('/').pop()}`;
      if (!existsSync(file)) {
        const resp = await realFetch(url);
        if (!resp.ok) return resp;
        mkdirSync(CACHE, { recursive: true });
        writeFileSync(file, new Uint8Array(await resp.arrayBuffer()));
      }
      return new Response(readFileSync(file));
    }
    return realFetch(input, init);
  }) as typeof fetch;
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  setGuestWorkerFactory(null);
  forceWasmProcessMode(null);
  rmSync(tmp, { recursive: true, force: true });
});

async function sh(shell: Shell, cmd: string) {
  let out = '';
  let err = '';
  const exitCode = await shell.execute(cmd, s => { out += s; }, s => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), exitCode };
}

/** Without colour codes: Shiro's shell exports FORCE_COLOR, so chalk and
 *  supports-color colour even into a pipe */
const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');

/** A download pinned by sha256, cached in tests/.pkg-cache. */
async function cachedDownload(url: string, sha: string): Promise<Uint8Array> {
  const file = `${CACHE}/${url.split('/').pop()}`;
  if (!existsSync(file)) {
    const resp = await realFetch(url);
    if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, new Uint8Array(await resp.arrayBuffer()));
  }
  const data = new Uint8Array(readFileSync(file));
  expect(createHash('sha256').update(data).digest('hex')).toBe(sha);
  return data;
}

/** What boot creates that programs look for: PATH shims, /bin/sh, /usr/bin/env, /tmp */
async function bootFiles(fs: FileSystem) {
  await fs.mkdir('/tmp', { recursive: true });
  await createPathShims(fs);
}

async function script(fs: FileSystem, file: string, text: string) {
  await fs.writeFile(file, text);
  await fs.chmod?.(file, 0o755);
}

describe('shebang scripts', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => { ({ fs, shell } = await createTestShell()); });

  it('#!/usr/bin/env NAME runs a builtin interpreter with the script path', async () => {
    await script(fs, '/tmp/count.awk', '#!/usr/bin/env -S awk -f\n{ n++ } END { print n, "lines" }\n');
    const r = await sh(shell, 'printf "a\\nb\\nc\\n" > /tmp/in.txt; /tmp/count.awk /tmp/in.txt');
    expect(r.err).toBe('');
    expect(r.out).toBe('3 lines\n');
  });

  it('an absolute interpreter that is not on disk falls back to the command of that name', async () => {
    await script(fs, '/tmp/count2.awk', '#!/usr/bin/awk -f\nEND { print NR }\n');
    expect((await sh(shell, '/tmp/count2.awk /tmp/in.txt')).out).toBe('3\n');
  });

  it('an interpreter that is itself a script on disk runs that script', async () => {
    await script(fs, '/tmp/myinterp', '#!/bin/sh\necho "interp got: $@"\n');
    await script(fs, '/tmp/user', '#!/tmp/myinterp --flag\nbody\n');
    expect((await sh(shell, '/tmp/user x y')).out).toBe('interp got: --flag /tmp/user x y\n');
  });

  it('a missing interpreter is "bad interpreter", exit 126', async () => {
    await script(fs, '/tmp/bad', '#!/usr/bin/env no-such-lang-xyz\n');
    const r = await sh(shell, '/tmp/bad');
    expect(r.exitCode).toBe(126);
    expect(r.err).toContain('no-such-lang-xyz: bad interpreter');
  });

  it('scripts on PATH run by name', async () => {
    await fs.mkdir('/tmp/bin', { recursive: true });
    await script(fs, '/tmp/bin/hello-awk', '#!/usr/bin/env awk -f\nBEGIN { print "hi from awk" }\n');
    expect((await sh(shell, 'PATH=/tmp/bin:$PATH hello-awk')).out).toBe('hi from awk\n');
  });
});

describe('shell constructs real scripts use (venv activate, build scripts)', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => { ({ fs, shell } = await createTestShell()); });

  it('a sourced file that starts with a comment still runs', async () => {
    await fs.writeFile('/tmp/env.sh', '# settings\nFOO_FROM_FILE=yes\n');
    expect((await sh(shell, '. /tmp/env.sh; echo "$FOO_FROM_FILE"')).out).toBe('yes\n');
  });

  it('multi-line function definitions in sourced files and scripts', async () => {
    await fs.writeFile('/tmp/fns.sh', 'greet () {\n    if [ -n "${1:-}" ] ; then\n        echo "hi $1"\n    else\n        echo "hi nobody"\n    fi\n}\n');
    expect((await sh(shell, '. /tmp/fns.sh; greet bob; greet')).out).toBe('hi bob\nhi nobody\n');
    await script(fs, '/tmp/fn-script', '#!/bin/sh\nadd() {\n  echo $(( $1 + $2 ))\n}\nadd 2 3\n');
    expect((await sh(shell, '/tmp/fn-script')).out).toBe('5\n');
  });

  it('a script run by path honours redirects and pipes (yarn is a sh launcher)', async () => {
    await script(fs, '/tmp/two-streams', '#!/bin/sh\necho there\necho oops >&2\n');
    let r = await sh(shell, '/tmp/two-streams > /dev/null');
    expect(r.out).toBe('');
    expect(r.err).toBe('oops\n');
    r = await sh(shell, '/tmp/two-streams 2>/dev/null | tr a-z A-Z; /tmp/two-streams > /tmp/both 2>&1; /tmp/two-streams >> /tmp/both 2>/dev/null; cat /tmp/both');
    expect(r.out).toBe('THERE\nthere\noops\nthere\n');
    expect(r.err).toBe('');
  });

  it('/bin/sh and /bin/bash by path take options as sh does (Claude Code runs `$SHELL -c -l CMD`)', async () => {
    const r = await sh(shell, `/bin/sh -c -l 'echo hi'; /bin/bash -c -l 'echo "$0 $1"' name one; /bin/sh -lc 'echo lc'; /bin/bash -c -e 'false; echo not reached'; echo "e=$?"; /bin/sh -c 'echo "$-"' | grep -c c`);
    expect(r.err).toBe('');
    expect(r.out).toBe('hi\nname one\nlc\ne=1\n1\n');
  });

  it('${1:-default} and [ ! a = b ] inside if', async () => {
    const r = await sh(shell, 'f() { echo "${1:-none}"; if [ ! "${1:-}" = "x" ]; then echo notx; fi; }; f; f x');
    expect(r.out).toBe('none\nnotx\nx\n');
  });

  it('awk -f progfile', async () => {
    await fs.writeFile('/tmp/sum.awk', '# sum column 2\n{ s += $2 }\nEND { print s }\n');
    expect((await sh(shell, 'printf "a 1\\nb 2\\n" | awk -f /tmp/sum.awk')).out).toBe('3\n');
  });
});

// ── Python packaging (src/utils/pep440.ts, src/commands/pip.ts) ─────────

import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  parseVersion, compareVersions, satisfies, parseSpecifiers, parseRequirement, evalMarker, markerEnv, wheelCompatible, parseWheelName,
} from '@shiro/utils/pep440';
import { pipMain, systemTarget, createVenv, listInstalled, venvTarget, PY_PREFIX } from '@shiro/commands/pip';

/** A zip (deflated entries), as wheels are. */
function makeZip(files: Record<string, string>): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), comp = deflateRawSync(data), nm = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, nm, comp); central.push(c, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, e]));
}

interface FakeDist { name: string; version: string; requires?: string[]; files: Record<string, string>; entryPoints?: string; tag?: string; requiresPython?: string }

/** PyPI's JSON API and files, from memory. */
function fakePypi(dists: FakeDist[]): typeof fetch {
  const files = new Map<string, Uint8Array>();
  const projects = new Map<string, any>();
  for (const d of dists) {
    const norm = d.name.toLowerCase().replace(/[-_.]+/g, '-');
    const under = d.name.replace(/-/g, '_');
    const di = `${under}-${d.version}.dist-info`;
    const wheelFiles: Record<string, string> = {
      ...d.files,
      [`${di}/METADATA`]: `Metadata-Version: 2.1\nName: ${d.name}\nVersion: ${d.version}\nSummary: ${d.name} for tests\n` +
        (d.requires ?? []).map(r => `Requires-Dist: ${r}\n`).join(''),
      [`${di}/WHEEL`]: 'Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
      [`${di}/RECORD`]: '',
    };
    if (d.entryPoints) wheelFiles[`${di}/entry_points.txt`] = d.entryPoints;
    const filename = `${under}-${d.version}-${d.tag ?? 'py3-none-any'}.whl`;
    const bytes = makeZip(wheelFiles);
    const url = `https://files.example/${filename}`;
    files.set(url, bytes);
    const p = projects.get(norm) ?? { info: { name: d.name, version: d.version, requires_dist: d.requires ?? [] }, releases: {}, perVersion: {} };
    p.releases[d.version] = [{ filename, url, packagetype: 'bdist_wheel', requires_python: d.requiresPython ?? null, size: bytes.length,
      digests: { sha256: createHash('sha256').update(bytes).digest('hex') } }];
    p.perVersion[d.version] = { info: { name: d.name, version: d.version, requires_dist: d.requires ?? [] } };
    if (compareVersions(parseVersion(d.version)!, parseVersion(p.info.version)!) > 0) p.info = { name: d.name, version: d.version, requires_dist: d.requires ?? [] };
    projects.set(norm, p);
  }
  return (async (input: any) => {
    const url = String(input);
    const f = files.get(url);
    if (f) return new Response(f);
    const m = /^https:\/\/pypi\.org\/pypi\/([^/]+)\/(?:([^/]+)\/)?json$/.exec(url);
    const p = m && projects.get(m[1]);
    if (!p) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(m![2] ? p.perVersion[m![2]] : { info: p.info, releases: p.releases }));
  }) as typeof fetch;
}

describe('PEP 440 / 508', () => {
  it('orders versions like pip', () => {
    const order = ['1.0.dev1', '1.0a1', '1.0a2.dev1', '1.0a2', '1.0b1', '1.0rc1', '1.0', '1.0.post1', '1.0.1', '1.1', '2!0.1'];
    const sorted = [...order].sort(() => Math.random() - 0.5).sort((a, b) => compareVersions(parseVersion(a)!, parseVersion(b)!));
    expect(sorted).toEqual(order);
    expect(compareVersions(parseVersion('1.0')!, parseVersion('1.0.0')!)).toBe(0);
  });

  it('matches specifiers', () => {
    const s = (v: string, spec: string, pre = false) => satisfies(v, parseSpecifiers(spec), pre);
    expect(s('2.31.0', '>=2.0,<3')).toBe(true);
    expect(s('3.0', '>=2.0,<3')).toBe(false);
    expect(s('1.4.5', '~=1.4.2')).toBe(true);
    expect(s('1.5', '~=1.4.2')).toBe(false);
    expect(s('1.5.3', '==1.5.*')).toBe(true);
    expect(s('1.6', '!=1.5.*')).toBe(true);
    expect(s('3.0b1', '<3')).toBe(false);
    expect(s('2.0rc1', '>=1.0')).toBe(false);
    expect(s('2.0rc1', '>=2.0rc1')).toBe(true);
  });

  it('parses requirements and evaluates markers for WASI CPython', () => {
    const r = parseRequirement('requests[socks, security] (>=2.8.1,!=2.9) ; python_version >= "3.8" and extra == "x"');
    expect(r.name).toBe('requests');
    expect(r.extras).toEqual(['socks', 'security']);
    expect(r.specifiers.map(s => s.op + s.version)).toEqual(['>=2.8.1', '!=2.9']);
    const env = markerEnv('3.13.7');
    expect(evalMarker('python_version >= "3.8"', env)).toBe(true);
    expect(evalMarker('python_version < "3.10"', env)).toBe(false);
    expect(evalMarker('sys_platform == "win32" or platform_system == "Windows"', env)).toBe(false);
    expect(evalMarker('(os_name == "posix") and extra == "socks"', env, ['socks'])).toBe(true);
    expect(evalMarker('extra == "socks"', env, [])).toBe(false);
    expect(evalMarker("python_full_version >= '3.7.1' and implementation_name == 'cpython'", env)).toBe(true);
  });

  it('only installs pure-Python wheels', () => {
    expect(wheelCompatible(parseWheelName('six-1.16.0-py2.py3-none-any.whl')!)).toBe(true);
    expect(wheelCompatible(parseWheelName('attrs-23.1.0-py3-none-any.whl')!)).toBe(true);
    expect(wheelCompatible(parseWheelName('numpy-2.0.0-cp313-cp313-manylinux_2_17_x86_64.whl')!)).toBe(false);
    expect(wheelCompatible(parseWheelName('typing_extensions-4.0-py2-none-any.whl')!)).toBe(false);
  });
});

describe('pip (fake PyPI)', () => {
  let shell: Shell;
  let fs: FileSystem;
  const dists: FakeDist[] = [
    { name: 'greet', version: '1.0', files: { 'greet/__init__.py': 'def hello(n):\n    return "hello " + n\n' } },
    { name: 'greet', version: '2.0', requires: ['colorish>=0.2', 'winonly; sys_platform == "win32"', 'extra-thing; extra == "fancy"'],
      files: { 'greet/__init__.py': 'from colorish import red\ndef hello(n):\n    return red("hello " + n)\n',
        'greet/cli.py': 'import sys\nfrom greet import hello\ndef main():\n    print(hello(sys.argv[1] if len(sys.argv) > 1 else "world"))\n    return 0\n' },
      entryPoints: '[console_scripts]\ngreet = greet.cli:main\n' },
    { name: 'colorish', version: '0.1', files: { 'colorish.py': 'def red(s): return s\n' } },
    { name: 'colorish', version: '0.3', files: { 'colorish.py': 'def red(s):\n    return "<red>" + s + "</red>"\n' } },
    { name: 'colorish', version: '0.4b1', files: { 'colorish.py': 'def red(s): return s\n' } },
    { name: 'extra-thing', version: '1.0', files: { 'extra_thing.py': '' } },
    { name: 'natived', version: '1.0', tag: 'cp313-cp313-manylinux_2_17_x86_64', files: { 'natived.py': '' } },
  ];
  const fetchFn = fakePypi(dists);
  const pip = async (...args: string[]) => {
    const ctx: any = { args, fs, cwd: '/home/user', env: { ...shell.env }, stdin: '', stdout: '', stderr: '', shell };
    const code = await pipMain(ctx, args, systemTarget(), fetchFn);
    return { code, out: ctx.stdout as string, err: ctx.stderr as string };
  };
  beforeAll(async () => { ({ fs, shell } = await createTestShell()); });

  it('installs the newest match with its dependencies, markers and console scripts', async () => {
    const r = await pip('install', 'greet');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Successfully installed greet-2.0 colorish-0.3');
    const site = systemTarget().site;
    expect(await fs.readFile(`${site}/colorish.py`, 'utf8')).toContain('<red>');
    expect(await fs.exists(`${site}/winonly.py`)).toBe(false);
    const launcher = await fs.readFile('/usr/local/bin/greet', 'utf8') as string;
    expect(launcher.startsWith('#!/usr/bin/python3\n')).toBe(true);
    expect(launcher).toContain('from greet.cli import main');
    expect((await listInstalled(fs, site)).get('greet')?.version).toBe('2.0');
  });

  it('list, freeze and show', async () => {
    expect((await pip('freeze')).out).toBe('colorish==0.3\ngreet==2.0\n');
    expect((await pip('list')).out).toMatch(/^Package\s+Version\n-+ -+\ncolorish\s+0\.3\ngreet\s+2\.0\n$/);
    const show = (await pip('show', 'colorish')).out;
    expect(show).toContain('Name: colorish\nVersion: 0.3\n');
    expect(show).toContain('Required-by: greet');
  });

  it('satisfied requirements are skipped; pins downgrade; extras pull extra deps', async () => {
    expect((await pip('install', 'greet')).out).toContain('Requirement already satisfied: greet');
    const r = await pip('install', 'colorish==0.1');
    expect(r.out).toContain('Successfully uninstalled colorish-0.3');
    expect(r.out).toContain('Successfully installed colorish-0.1');
    expect((await pip('install', 'greet[fancy]')).out).toContain('extra-thing');
  });

  it('uninstall removes files, scripts and dist-info', async () => {
    const r = await pip('uninstall', '-y', 'greet');
    expect(r.out).toContain('Successfully uninstalled greet-2.0');
    const site = systemTarget().site;
    expect(await fs.exists(`${site}/greet`)).toBe(false);
    expect(await fs.exists('/usr/local/bin/greet')).toBe(false);
    expect(await fs.exists(`${site}/greet-2.0.dist-info`)).toBe(false);
  });

  it('requirements files, --target, and clear errors for native-only or missing projects', async () => {
    await fs.writeFile('/home/user/requirements.txt', '# deps\ngreet==1.0  # pinned\n\n');
    expect((await pip('install', '-r', 'requirements.txt', '--target', 'vendor')).out).toContain('Successfully installed greet-1.0');
    expect(await fs.readFile('/home/user/vendor/greet/__init__.py', 'utf8')).toContain('hello');
    const nat = await pip('install', 'natived');
    expect(nat.code).toBe(1);
    expect(nat.err).toContain('No matching distribution found for natived');
    expect((await pip('install', 'nope-not-real')).err).toContain('No matching distribution found for nope-not-real');
  });

  it('a venv gets its own site-packages, launchers and activate script', async () => {
    await createVenv(fs, '/home/user/proj/.venv');
    expect(await fs.readlink('/home/user/proj/.venv/bin/python')).toBe(`${PY_PREFIX}/bin/python3.wasm`);
    expect(await fs.readFile('/home/user/proj/.venv/pyvenv.cfg', 'utf8')).toContain(`home = ${PY_PREFIX}/bin`);
    const ctx: any = { args: [], fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell };
    await pipMain(ctx, ['install', 'colorish'], venvTarget('/home/user/proj/.venv'), fetchFn);
    expect(await fs.exists('/home/user/proj/.venv/lib/python3.13/site-packages/colorish.py')).toBe(true);
    const r = await sh(shell, 'cd /home/user/proj && . .venv/bin/activate && echo "$VIRTUAL_ENV" && echo "$PATH" | cut -d: -f1');
    expect(r.out).toBe('/home/user/proj/.venv\n/home/user/proj/.venv/bin\n');
  });
});

// ── python3: CPython 3.13 for WASI as a kernel process ─────────────────

import { pipCmd, python3Cmd } from '@shiro/commands/python';

describe('python3 (CPython WASI package)', () => {
  let shell: Shell;
  let fs: FileSystem;
  const pypi = fakePypi([
    { name: 'tinytable', version: '1.2.0', requires: ['wcwidthish>=0.1'], entryPoints: '[console_scripts]\ntinytable = tinytable:main\n',
      files: { 'tinytable/__init__.py': [
        'import sys, wcwidthish',
        'def render(rows):',
        '    w = [max(wcwidthish.width(str(r[i])) for r in rows) for i in range(len(rows[0]))]',
        '    return "\\n".join(" | ".join(str(c).ljust(w[i]) for i, c in enumerate(r)) for r in rows)',
        'def main():',
        '    rows = [l.split(",") for l in sys.stdin.read().split()]',
        '    print(render(rows))',
        '    return 0', ''].join('\n') } },
    { name: 'wcwidthish', version: '0.2', files: { 'wcwidthish.py': 'def width(s):\n    return len(s)\n' } },
  ]);
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    shell.commands.register(pipCmd);
    shell.commands.register(python3Cmd);
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.startsWith('https://pypi.org/') || url.startsWith('https://files.example/')) return pypi(input, init);
      return prev(input, init);
    }) as typeof fetch;
    const r = await sh(shell, 'pkg install python3');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  const py = (cmd: string) => sh(shell, cmd);

  it('runs -c, reports its version, and has zlib, sqlite3, json, hashlib, decimal', async () => {
    const r = await py(`python3 -c "import sys, zlib, sqlite3, json, hashlib, decimal; print(sys.version_info[:2], sqlite3.sqlite_version, hashlib.sha256(b'x').hexdigest()[:8], decimal.Decimal('1.10') + 1)"`);
    expect(r.err).toBe('');
    expect(r.out).toBe('(3, 13) 3.50.4 2d711642 2.10\n');
    expect((await py('python3 --version')).out).toBe('Python 3.13.7\n');
  }, 60_000);

  it('#!/usr/bin/env python3 scripts run with argv, stdin and files', async () => {
    await script(fs, '/home/user/wc.py', '#!/usr/bin/env python3\nimport sys\ndata = sys.stdin.read()\nopen(sys.argv[1], "w").write(data.upper())\nprint(len(data.split()), "words")\n');
    const r = await py('cd /home/user && echo "one two three" | ./wc.py out.txt && cat out.txt');
    expect(r.err).toBe('');
    expect(r.out).toBe('3 words\nONE TWO THREE\n');
  }, 60_000);

  it('runs a small project: package, modules, unittest', async () => {
    await fs.mkdir('/home/user/calc/calc', { recursive: true });
    await fs.writeFile('/home/user/calc/calc/__init__.py', 'from .ops import add, mul\n');
    await fs.writeFile('/home/user/calc/calc/ops.py', 'def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n');
    await fs.writeFile('/home/user/calc/test_calc.py', 'import unittest\nfrom calc import add, mul\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_mul(self):\n        self.assertEqual(mul(4, 5), 20)\n\nif __name__ == "__main__":\n    unittest.main()\n');
    const r = await py('cd /home/user/calc && python3 -m unittest -v test_calc 2>&1');
    expect(r.out).toContain('test_add (test_calc.T.test_add) ... ok');
    expect(r.out).toMatch(/Ran 2 tests in [\d.]+s\n\nOK\n/);
  }, 60_000);

  it('pip installs from PyPI; the package imports and its console script runs', async () => {
    const r = await py('pip install tinytable');
    expect(r.err).toBe('');
    expect(r.out).toContain('Successfully installed tinytable-1.2.0 wcwidthish-0.2');
    expect((await py('printf "a,bb\\nccc,d\\n" | tinytable')).out).toBe('a   | bb\nccc | d \n');
    expect((await py('python3 -m pip list')).out).toMatch(/\ntinytable +1\.2\.0\n/);
  }, 60_000);

  it('python3 -m venv: an isolated environment with its own pip', async () => {
    const r = await py('cd /home/user && python3 -m venv .venv && . .venv/bin/activate && pip install wcwidthish && python -c "import sys, wcwidthish; print(sys.prefix, sys.base_prefix, wcwidthish.__file__)"');
    expect(r.err).toBe('');
    expect(r.out).toContain('/home/user/.venv /usr/lib/pkg/python3 /home/user/.venv/lib/python3.13/site-packages/wcwidthish.py\n');
    // the system python doesn't see the venv's packages
    const sys = await py('/usr/bin/python3 -c "import sys; print(sys.prefix)"');
    expect(sys.out).toBe('/usr/lib/pkg/python3\n');
  }, 60_000);

  it('a file renamed or unlinked while open keeps every write (kernel inodes follow renames)', async () => {
    const r = await py(`cd /home/user && python3 -c "
import os
f = open('part.tmp', 'w'); f.write('x' * 5000); f.flush()
os.rename('part.tmp', 'final.txt'); f.write('y'); f.close()
g = open('gone.txt', 'w'); g.write('z'); os.unlink('gone.txt'); g.write('more'); g.close()
print(os.path.getsize('final.txt'), os.path.exists('part.tmp'), os.path.exists('gone.txt'))
"`);
    expect(r.err).toBe('');
    expect(r.out).toBe('5001 False False\n');
  }, 60_000);
});

// ── C: GNU make + clang/LLVM 21 for WASI, building to wasm32-wasip1 ────

describe('make and clang (llvm package)', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await bootFiles(fs);
    const r = await sh(shell, 'pkg install make llvm');
    expect(r.err).toBe('');
    expect(r.exitCode).toBe(0);
  }, 300_000);

  it('GNU make: shell recipes, $(shell), pattern rules, -C, up-to-date checks', async () => {
    await fs.mkdir('/home/user/mk', { recursive: true });
    await fs.writeFile('/home/user/mk/Makefile', [
      'NAME := world', 'SRCS := $(wildcard *.txt)', 'all: out.txt', '\t@echo built $(NAME) from $(SRCS)',
      'out.txt: in.txt', '\tcat in.txt | tr a-z A-Z > $@', '\t@echo "in $(notdir $(CURDIR)): $(shell ls | wc -l) files"',
      '%.up: %.txt', '\ttr a-z A-Z < $< > $@', 'clean:', '\trm -f out.txt *.up', ''].join('\n'));
    await fs.writeFile('/home/user/mk/in.txt', 'hello\n');
    let r = await sh(shell, 'cd /home/user/mk && make');
    expect(r.err).toBe('');
    // the whole recipe is expanded before its first line runs: out.txt isn't there yet
    expect(r.out).toBe('cat in.txt | tr a-z A-Z > out.txt\nin mk: 2 files\nbuilt world from in.txt\n');
    r = await sh(shell, 'cd /home/user/mk && cat out.txt && make && make in.up && cat in.up');
    expect(r.out).toBe('HELLO\nbuilt world from in.txt out.txt\ntr a-z A-Z < in.txt > in.up\nHELLO\n');
    r = await sh(shell, 'cd / && make -C /home/user/mk clean');
    expect(r.out).toContain("make: Entering directory '/home/user/mk'\nrm -f out.txt *.up\n");
    expect(await fs.exists('/home/user/mk/out.txt')).toBe(false);
  }, 120_000);

  it('clang compiles and links C to WASI; the program runs', async () => {
    await fs.mkdir('/home/user/c', { recursive: true });
    await fs.writeFile('/home/user/c/hello.c', '#include <stdio.h>\n#include <string.h>\nint main(int c, char **v) { printf("hello %s %zu\\n", c > 1 ? v[1] : "world", strlen("abc")); return 0; }\n');
    const r = await sh(shell, 'cd /home/user/c && clang -O2 -Wall hello.c -o hello && ./hello shiro');
    expect(r.err).toBe('');
    expect(r.out).toBe('hello shiro 3\n');
    expect((await sh(shell, 'clang --version')).out).toContain('clang version 21.1.4');
  }, 120_000);

  it('a multi-file project: make, cc -c, a static library with llvm-ar, rebuild after a header changes', async () => {
    const d = '/home/user/proj';
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(`${d}/Makefile`, 'CC = cc\nCFLAGS = -O2 -Wall\nOBJS = main.o libsq.a\nprog: main.o libsq.a\n\t$(CC) -o $@ main.o -L. -lsq\nlibsq.a: util.o\n\tllvm-ar rcs $@ $^\n%.o: %.c util.h\n\t$(CC) $(CFLAGS) -c $<\nclean:\n\trm -f prog *.o *.a\n');
    await fs.writeFile(`${d}/util.h`, 'int square(int);\n');
    await fs.writeFile(`${d}/util.c`, '#include "util.h"\nint square(int x) { return x * x; }\n');
    await fs.writeFile(`${d}/main.c`, '#include <stdio.h>\n#include <stdlib.h>\n#include "util.h"\nint main(int argc, char **argv) { printf("%d\\n", square(argc > 1 ? atoi(argv[1]) : 12)); return 0; }\n');
    let r = await sh(shell, `cd ${d} && make && ./prog && ./prog 7`);
    expect(r.err).toBe('');
    expect(r.out).toBe('cc -O2 -Wall -c main.c\ncc -O2 -Wall -c util.c\nllvm-ar rcs libsq.a util.o\ncc -o prog main.o -L. -lsq\n144\n49\n');
    r = await sh(shell, `cd ${d} && make && touch util.h && make && llvm-nm libsq.a`);
    expect(r.out).toBe("make: 'prog' is up to date.\ncc -O2 -Wall -c main.c\ncc -O2 -Wall -c util.c\nllvm-ar rcs libsq.a util.o\ncc -o prog main.o -L. -lsq\n\nutil.o:\n00000001 T square\n");
  }, 180_000);

  it('a real project: zlib 1.3.1 builds with its Makefile and passes its own test', async () => {
    const tgz = await cachedDownload('https://zlib.net/fossils/zlib-1.3.1.tar.gz', '9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23');
    for (const e of await readTarball(tgz)) {
      if (e.type !== '0' || !/^zlib-1\.3\.1\/(test\/)?[^/]+$/.test(e.name)) continue;
      const p = `/home/user/${e.name}`;
      await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(p, e.data);
    }
    // configure's job (it needs a shell that can pass multi-line arguments to sed)
    const mk = 'make -f Makefile.in CC=cc "CFLAGS=-O2 -DHAVE_UNISTD_H"';
    let r = await sh(shell, `cd /home/user/zlib-1.3.1 && ${mk} libz.a example minigzip`);
    expect(r.exitCode).toBe(0);
    r = await sh(shell, `cd /home/user/zlib-1.3.1 && ${mk} teststatic && echo "hello hello hello" | ./minigzip | ./minigzip -d`);
    expect(r.out).toContain('zlib version 1.3.1');
    expect(r.out).toContain('*** zlib test OK ***');
    expect(r.out.endsWith('hello hello hello\n')).toBe(true);
  }, 600_000);

  it('compile errors are reported with the exit status', async () => {
    await fs.writeFile('/home/user/c/bad.c', 'int main(void) { return undefined_thing; }\n');
    const r = await sh(shell, 'cd /home/user/c && cc bad.c -o bad');
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toContain("bad.c:1:25: error: use of undeclared identifier 'undefined_thing'");
  }, 60_000);
});

// ── Go: the toolchain itself on wasip1, building GOOS=wasip1 programs ──

describe('go (toolchain on wasip1)', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await bootFiles(fs);
    const r = await sh(shell, 'pkg install go');
    expect(r.err).toBe('');
    expect(r.exitCode).toBe(0);
  }, 300_000);

  it('go version, go env, gofmt', async () => {
    expect((await sh(shell, 'go version')).out).toBe('go version go1.24.7 wasip1/wasm\n');
    expect((await sh(shell, 'go env GOROOT GOOS GOARCH GOCACHE GOTOOLCHAIN')).out)
      .toBe('/usr/lib/pkg/go\nwasip1\nwasm\n/usr/lib/pkg/go/cache\nlocal\n');
    await fs.writeFile('/tmp/ugly.go', 'package main\nimport "fmt"\nfunc main(){fmt.Println( "x" )}\n');
    expect((await sh(shell, 'gofmt /tmp/ugly.go')).out).toBe('package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("x") }\n');
  }, 60_000);

  it('go build: a module with two packages, from the shipped std cache; the program runs commands with os/exec', async () => {
    const d = '/home/user/gohello';
    await fs.mkdir(`${d}/greet`, { recursive: true });
    await fs.writeFile(`${d}/go.mod`, 'module example.com/gohello\n\ngo 1.24\n');
    await fs.writeFile(`${d}/greet/greet.go`, 'package greet\n\nimport "strings"\n\n// Hello greets name.\nfunc Hello(name string) string { return "hello, " + strings.ToUpper(name) }\n');
    await fs.writeFile(`${d}/main.go`, [
      'package main', '', 'import (', '\t"fmt"', '\t"os"', '\t"os/exec"', '\t"strings"', '', '\t"example.com/gohello/greet"', ')', '',
      'func main() {', '\tout, err := exec.Command("echo", "from", "a", "child").Output()', '\tif err != nil {', '\t\tpanic(err)', '\t}',
      '\tfmt.Println(greet.Hello(os.Args[1]), strings.TrimSpace(string(out)))', '}', ''].join('\n'));
    const t0 = Date.now();
    const r = await sh(shell, `cd ${d} && go build -o hello.wasm . && ./hello.wasm gopher`);
    expect(r.err).toBe('');
    expect(r.out).toBe('hello, GOPHER from a child\n');
    expect(Date.now() - t0).toBeLessThan(60_000); // std came from the cache
    expect((await sh(shell, `cd ${d} && go vet ./... && go run . again`)).out).toBe('hello, AGAIN from a child\n');
  }, 240_000);

  it('go test runs a package test', async () => {
    const d = '/home/user/gohello';
    await fs.writeFile(`${d}/greet/greet_test.go`, 'package greet\n\nimport "testing"\n\nfunc TestHello(t *testing.T) {\n\tif got := Hello("x"); got != "hello, X" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n');
    const r = await sh(shell, `cd ${d} && go test ./greet`);
    expect(r.out).toMatch(/^ok\s+example\.com\/gohello\/greet\s+[\d.]+s\n$/);
  }, 600_000);
});

// ── Ruby 3.4 (ruby.wasm CLI build) ─────────────────────────────────────

describe('ruby', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await bootFiles(fs);
    const r = await sh(shell, 'pkg install ruby');
    expect(r.err).toBe('');
    expect(r.exitCode).toBe(0);
  }, 300_000);

  it('ruby -e with the standard library (json, set, digest, time)', async () => {
    const r = await sh(shell, `ruby -e 'require "json"; require "set"; require "digest"; require "time"; puts RUBY_VERSION, JSON.generate({a: [1, 2]}), Set[3, 1, 3].size, Digest::SHA256.hexdigest("x")[0, 8], Time.at(0).utc.iso8601'`);
    expect(r.err).toBe('');
    expect(r.out).toBe('3.4.1\n{"a":[1,2]}\n2\n2d711642\n1970-01-01T00:00:00Z\n');
  }, 120_000);

  it('#!/usr/bin/env ruby scripts with argv, stdin and files; minitest', async () => {
    await script(fs, '/home/user/wc.rb', '#!/usr/bin/env ruby\nwords = STDIN.read.split\nFile.write(ARGV[0], words.map(&:upcase).join(" "))\nputs "#{words.size} words"\n');
    let r = await sh(shell, 'cd /home/user && echo "a b c" | ./wc.rb out.txt && cat out.txt');
    expect(r.err).toBe('');
    expect(r.out).toBe('3 words\nA B C');
    await fs.writeFile('/home/user/calc_test.rb', 'require "minitest/autorun"\n\nclass CalcTest < Minitest::Test\n  def test_add\n    assert_equal 4, 2 + 2\n  end\n\n  def test_upcase\n    assert_equal "AB", "ab".upcase\n  end\nend\n');
    r = await sh(shell, 'cd /home/user && ruby calc_test.rb')
    expect(r.out).toMatch(/2 runs, 2 assertions, 0 failures, 0 errors, 0 skips/);
  }, 120_000);

  it('rake runs a Rakefile; gem lists the default gems', async () => {
    await fs.mkdir('/home/user/rk', { recursive: true });
    await fs.writeFile('/home/user/rk/Rakefile', 'task default: [:build]\ntask :prep do\n  puts "prep"\nend\ntask build: :prep do\n  puts "build"\nend\n');
    let r = await sh(shell, 'cd /home/user/rk && rake');
    expect(r.err).toBe('');
    expect(r.out).toBe('prep\nbuild\n');
    r = await sh(shell, 'gem list json')
    expect(r.out).toMatch(/^json \(.*2\.9\.1/m);
  }, 180_000);
});

// ── Perl 5.40: static x86-64 Linux build in Blink ──────────────────────

describe('perl (x86-64 in Blink)', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await bootFiles(fs);
    const r = await sh(shell, 'pkg install perl');
    expect(r.err).toBe('');
    expect(r.exitCode).toBe(0);
  }, 300_000);

  it('perl -e, core modules, and no locale warnings', async () => {
    const r = await sh(shell, `perl -e 'use List::Util qw(sum max); use Data::Dumper; $Data::Dumper::Terse = 1; $Data::Dumper::Indent = 0; printf "%s %d %d %s\\n", $^V, sum(1..4), max(3, 9, 2), Dumper({a => [1]})'`);
    expect(r.err).toBe('');
    expect(r.out).toBe("v5.40.0 10 9 {'a' => [1]}\n");
  }, 120_000);

  it('#!/usr/bin/env perl scripts: argv, stdin, files, regexes, backticks and system()', async () => {
    await script(fs, '/home/user/count.pl', '#!/usr/bin/env perl\nuse strict; use warnings;\nmy %n; while (<STDIN>) { $n{lc $1}++ while /(\\w+)/g }\nopen my $fh, ">", $ARGV[0] or die; print $fh join(",", map { "$_=$n{$_}" } sort keys %n), "\\n"; close $fh;\nmy $c = `cat $ARGV[0]`; print "file: $c"; system("echo", "child", "ok") == 0 or die;\n');
    const r = await sh(shell, 'cd /home/user && printf "The cat. the dog\\n" | ./count.pl out.txt');
    expect(r.err).toBe('');
    expect(r.out).toBe('file: cat=1,dog=1,the=2\nchild ok\n');
  }, 120_000);

  it('Test::More tests run (TAP), and open "-|" reads a child perl', async () => {
    await fs.mkdir('/home/user/pt/t', { recursive: true });
    await fs.writeFile('/home/user/pt/t/basic.t', 'use strict; use Test::More tests => 2;\nis(1 + 1, 2, "adds");\nlike("hello", qr/ell/, "matches");\n');
    let r = await sh(shell, 'cd /home/user/pt && perl t/basic.t');
    expect(r.out).toBe('1..2\nok 1 - adds\nok 2 - matches\n');
    r = await sh(shell, `perl -e 'open my $fh, "-|", "perl", "-e", "print qq(from child\\n)" or die; print "got: ", <$fh>; close $fh; print "rc=$?\\n"'`);
    expect(r.out).toBe('got: from child\nrc=0\n');
  }, 300_000);

  // fork() is a real copy (Blink patch 0014): code between fork and exec
  // used to run on the parent's memory, and a fork without exec broke it
  it('fork: a child that dups a pipe onto stdout and execs; fork without exec', async () => {
    let r = await sh(shell, `perl -e 'pipe R,W; if(!fork){close R; open STDOUT,">&W"; exec "perl","-e","print 1"} close W; print <R>'`);
    expect(r.out).toBe('1');
    r = await sh(shell, `perl -e 'my $x = "parent"; my $pid = fork; if (!$pid) { $x = "child"; exit 3 } waitpid($pid, 0); print "$x ", $? >> 8, "\n"'`);
    expect(r.out).toBe('parent 3\n');
  }, 120_000);

  it('IPC::Open3 and prove get the child output', async () => {
    let r = await sh(shell, `perl -e 'use IPC::Open3; my $pid = open3(my $in, my $out, undef, "perl", "-e", "print scalar <STDIN>; print STDERR qq(e\n)"); print $in "hi\n"; close $in; my @l = sort <$out>; waitpid($pid, 0); print "open3: @l"'`);
    expect(r.out).toBe('open3: e\n hi\n'); // stderr unbuffered, stdout at exit: sorted
    r = await sh(shell, 'cd /home/user/pt && prove t/basic.t');
    expect(r.out).toMatch(/All tests successful/);
  }, 300_000);

});

describe('node-compat modules real packages rely on', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await fs.mkdir('/home/user/m', { recursive: true });
  });
  const node = async (code: string) => {
    await fs.writeFile('/home/user/m/t.js', code);
    const r = await sh(shell, 'cd /home/user/m && node t.js');
    expect(r.err).toBe('');
    return r.out;
  };

  it('an unhandled rejection ends the script with exit code 1, unless a process listener takes it', async () => {
    await fs.writeFile('/home/user/m/rej.js', `Promise.reject(new Error('boom'))`);
    let r = await sh(shell, 'cd /home/user/m && node rej.js; echo "a=$?"');
    expect(r.out).toContain('a=1');
    expect(r.out + r.err).toContain('boom');
    await fs.writeFile('/home/user/m/rej2.js', `process.on('unhandledRejection', (e) => console.log('caught', e.message)); Promise.reject(new Error('boom'))`);
    r = await sh(shell, 'cd /home/user/m && node rej2.js; echo "b=$?"');
    expect(r.out).toBe('caught boom\nb=0\n');
    await fs.writeFile('/home/user/m/rej3.js', `(async () => { await new Promise((r) => setTimeout(r, 50)); throw new Error('late'); })(); setTimeout(() => console.log('not reached'), 500)`);
    r = await sh(shell, 'cd /home/user/m && node rej3.js; echo "c=$?"');
    expect(r.out).toBe('c=1\n');
  }, 60_000);

  it("a process's globalThis: process and Buffer on it; replacing a page global stays the process's", async () => {
    await fs.writeFile('/home/user/m/g-mod.js', `globalThis.sharedByModules = 'yes'; module.exports = () => globalThis.fromEntry;`);
    expect(await node(`const read = require('./g-mod');
globalThis.fromEntry = 'entry';
// a new global is also a bare identifier (mocha's global.describe, then describe())
const out = [globalThis.process === process, global.process === process, globalThis.Buffer === Buffer, global === globalThis, read(), sharedByModules];
delete globalThis.sharedByModules;
const page = globalThis.crypto;
globalThis.crypto = { getRandomValues: (b) => b.fill(7) };
out.push(globalThis.crypto.getRandomValues(new Uint8Array(1))[0]);
Object.defineProperty(globalThis, 'performance', { writable: true, configurable: true });
out.push(typeof globalThis.performance.now);
globalThis.performance = { now: () => 42 };
out.push(globalThis.performance.now());
out.push(typeof globalThis.setTimeout(() => {}, 0) !== 'undefined', typeof atob === 'function' && globalThis.atob('aGk='));
delete globalThis.fromEntry;
out.push(globalThis.fromEntry, 'fromEntry' in globalThis);
// code compiled at run time sees the process's globals too (esbuild-wasm runs Go's wasm_exec this way)
const f = new Function('a', 'return [typeof process, process === globalThis.process, Buffer === globalThis.Buffer, a]');
const g = Function('process', '"use strict"; return process');
out.push(...f(1), g('own'), f instanceof Function, Function.prototype === Object.getPrototypeOf(f));
console.log(JSON.stringify(out));`)).toBe('[true,true,true,true,"entry","yes",7,"function",42,true,"hi",null,false,"object",true,true,1,"own",true,true]\n');
    // The page's own crypto and performance, and a next script, never saw those
    expect(typeof (globalThis as any).crypto?.subtle).toBe('object');
    expect(await node(`console.log(typeof globalThis.crypto.subtle, typeof globalThis.performance.timeOrigin, typeof globalThis.sharedByModules, typeof globalThis.fromEntry)`))
      .toBe('object number undefined undefined\n');
  }, 60_000);

  it('what vite 8 needs: Buffer#write encodings on a view, stdin read only when asked, IPv6 literals in long form', async () => {
    // es-module-lexer (vite's import analysis) writes the source as utf16le into WebAssembly memory
    expect(await node(`const ab = new ArrayBuffer(8);
const b = Buffer.from(ab, 2, 6);
const n = b.write('ab', 'utf16le');
const c = Buffer.alloc(6); c.write('ffee', 1, 'hex'); c.write('hi', 4);
console.log(n, Array.from(new Uint16Array(ab)).join(), c.toString('hex'))`)).toBe('4 0,97,98,0 00ffee006869\n');
    // An 'end' listener alone doesn't read piped input (vite exits on stdin 'end'); a 'data' listener does
    await fs.writeFile('/home/user/m/end.js', `process.stdin.on('end', () => console.log('ended')); setTimeout(() => console.log('alive'), 100)`);
    expect((await sh(shell, 'cd /home/user/m && echo x | node end.js')).out).toBe('alive\n');
    await fs.writeFile('/home/user/m/data.js', `process.stdin.on('end', () => console.log('ended')); process.stdin.on('data', (d) => console.log('data', String(d).trim()))`);
    expect((await sh(shell, 'cd /home/user/m && echo x | node data.js')).out).toBe('data x\nended\n');
    // vite probes its port on '0000:0000:0000:0000:0000:0000:0000:0000' too
    expect(await node(`const net = require('net');
const s = net.createServer().listen(5199, '0000:0000:0000:0000:0000:0000:0000:0000', () => {
  console.log(JSON.stringify(s.address())); s.close();
});
s.on('error', (e) => console.log('error', e.code));`)).toBe('{"address":"::","family":"IPv6","port":5199}\n');
  }, 60_000);

  it("esbuild-wasm's bin compiles its .wasm asynchronously (a page's main thread refuses a sync compile over 8 MB)", async () => {
    const { patchPackageSource } = await import('@shiro/node-compat/source-patches');
    const src = `function instantiate(bytes, importObject) {
  // comment
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, importObject);
  return Promise.resolve({ instance, module });
}`;
    for (const path of ['/p/node_modules/esbuild/bin/esbuild', '/p/node_modules/esbuild-wasm/bin/esbuild']) {
      expect(patchPackageSource(path, src)).toContain('return WebAssembly.instantiate(bytes, importObject);');
      expect(patchPackageSource(path, src)).not.toContain('new WebAssembly.Module');
    }
    expect(patchPackageSource('/p/other/bin/esbuild', src)).toBe(src);
    // Go's go.exit (process.exit from its own event loop) doesn't throw out of it
    const bin = patchPackageSource('/p/node_modules/esbuild/bin/esbuild', "const code = fs.readFileSync(wasm_exec_node, 'utf8');\nreturn code;");
    const code = new Function('fs', 'wasm_exec_node', bin)({ readFileSync: () => 'go.exit = process.exit;' }, '');
    const exit = new Function('process', `const go = {}; ${code} return go.exit;`)({ exit: (c: number) => { throw new Error(`process.exit(${c})`); } });
    expect(() => exit(0)).not.toThrow();
  });

  it("a node child's stdio are live pipes: the parent talks to it while it runs (esbuild's service)", async () => {
    // The child answers each line as it comes, from fs.read(0) (as Go does), with raw bytes on fd 1
    await fs.writeFile('/home/user/m/echo-child.js', `const fs = require('fs');
const buf = Buffer.alloc(64);
function next() {
  fs.read(0, buf, 0, buf.length, null, (e, n) => {
    if (e || n === 0) return;
    const line = buf.slice(0, n).toString();
    fs.writeSync(1, Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(line.toUpperCase())]));
    next();
  });
}
next();`);
    expect(await node(`const { spawn } = require('child_process');
const c = spawn(process.execPath, ['echo-child.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
const got = [];
let i = 0;
const words = ['one', 'two', 'three'];
c.stdout.on('data', (d) => {
  got.push([...d.slice(0, 2)].join(',') + ':' + d.slice(2).toString());
  if (++i < words.length) c.stdin.write(words[i]); else c.stdin.end();
});
c.on('exit', (code) => console.log(JSON.stringify(got), code));
c.stdin.write(words[0]);`)).toBe('["255,0:ONE","255,0:TWO","255,0:THREE"] 0\n');
    // An unref()'d child that never ends doesn't keep its parent alive (esbuild's service); it sees EOF when the parent goes
    await fs.writeFile('/home/user/m/forever-child.js', `process.stdin.on('data', () => {}); process.stdin.on('end', () => require('fs').writeFileSync('/home/user/m/child-saw-eof', 'yes'));`);
    expect(await node(`const c = require('child_process').spawn('node', ['forever-child.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
c.unref(); c.stdin.write('x'); console.log('parent done')`)).toBe('parent done\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(await fs.readFile('/home/user/m/child-saw-eof', 'utf8')).toBe('yes');
    // Piped input through fs.readSync(0) and fs.read(0)
    let r = await sh(shell, 'cd /home/user/m && echo hello | node -e "const b = Buffer.alloc(16); setTimeout(() => console.log(require(\'fs\').readSync(0, b, 0, 16, null), String(b.slice(0, 6))), 10)"');
    expect(r.out).toBe('6 hello\n\n');
    r = await sh(shell, 'cd /home/user/m && echo hi | node -e "const b = Buffer.alloc(16); require(\'fs\').read(0, b, 0, 16, null, (e, n) => console.log(e, n, JSON.stringify(String(b.slice(0, n)))))"');
    expect(r.out).toBe('null 3 "hi\\n"\n');
    r = await sh(shell, 'cd /home/user/m && printf \'{"a":1}\' | node -e "console.log(JSON.parse(require(\'fs\').readFileSync(0, \'utf8\')).a, require(\'fs\').readFileSync(\'/dev/stdin\').length)"');
    expect(r.out).toBe('1 0\n');
  }, 60_000);

  it('path follows Node (relative paths stay relative)', async () => {
    expect(await node(`const p = require('path');
console.log(JSON.stringify([p.dirname('a'), p.dirname('/a'), p.dirname('a/b/'), p.join('a', '../b', './c'), p.join(''), p.normalize('./x/../y/'),
  p.resolve('/a', 'b', '../c'), p.relative('/a/b', '/a/c/d'), p.relative('/a', '/a'), p.extname('.bashrc'), p.extname('a.b.c'), p.basename('/x/y.js', '.js'),
  p.parse('f.txt').dir, p.parse('/d/f.txt').dir, p.posix.dirname('*.jsa'), p.resolve('q') === process.cwd() + '/q']));`))
      .toBe('["." ,"/","a","b/c",".","y/","/a/c","../c/d","","",".c","y","","/d",".",true]\n'.replace(' ,', ','));
  }, 60_000);

  it('streams: Readable/Transform/Writable, pipe, pipeline, async iteration, objectMode, without new', async () => {
    expect(await node(`const { Readable, Transform, Writable, PassThrough, pipeline } = require('stream');
const upper = new Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); } });
let got = '';
const sink = new Writable({ write(c, e, cb) { got += c; setTimeout(cb, 1); } });
pipeline(Readable.from(['a', 'b', 'c']), upper, sink, (err) => {
  console.log('pipeline', err, got);
  const pt = PassThrough({ objectMode: true });
  (async () => { const seen = []; for await (const x of pt) seen.push(x.n); console.log('iter', seen.join(',')); })();
  pt.write({ n: 1 }); pt.write({ n: 2 }); pt.end();
  const r = new Readable({ read() {} });
  r.on('readable', () => { let c; while ((c = r.read()) !== null) console.log('read', String(c)); });
  r.on('end', () => console.log('end'));
  r.push('x'); r.push(null);
});`).then(o => o.split('\n').sort().join('\n'))).toBe('\nend\niter 1,2\npipeline null ABC\nread x');
  }, 60_000);

  it('EventEmitter: pre-class inheritance, listener this, once, error without listener throws', async () => {
    expect(await node(`const EE = require('events'); const util = require('util');
function Old() { EE.call(this); } util.inherits(Old, EE);
function Lazy() {} util.inherits(Lazy, EE);
const o = new Old(); o.on('x', function (v) { console.log('this ok', this === o, v); }); o.emit('x', 1);
const l = new Lazy(); l.once('y', (v) => console.log('lazy', v)); l.emit('y', 2); console.log(l.emit('y', 3), l.listenerCount('y'));
try { new EE().emit('error', new Error('boom')); } catch (e) { console.log('threw', e.message); }`))
      .toBe('this ok true 1\nlazy 2\nfalse 0\nthrew boom\n');
  }, 60_000);

  it('timers are Timeout objects (unref), and nothing prints after process.exit()', async () => {
    await fs.writeFile('/home/user/m/t.js', `const iv = setInterval(() => {}, 1000); iv.unref();
setTimeout(() => console.log('never'), 60000).unref();
const t = setTimeout(() => {}, 10); clearTimeout(t);
console.log(typeof iv.ref, typeof +iv, t.hasRef());
try { process.exit(3); } catch (e) { console.log('caught', e.message); }`);
    const start = Date.now();
    const r = await sh(shell, 'cd /home/user/m && node t.js');
    expect(r.out).toBe('function number true\n');
    expect(r.err).toBe('');
    expect(r.exitCode).toBe(3);
    expect(Date.now() - start).toBeLessThan(20_000);
  }, 60_000);

  it("a script's timers end with it (an interval left by process.exit() doesn't keep the next script alive)", async () => {
    await fs.writeFile('/home/user/m/iv.js', `setInterval(() => { setTimeout(() => {}, 200); }, 20); setTimeout(() => process.exit(0), 50);`);
    expect((await sh(shell, 'cd /home/user/m && node iv.js; echo rc=$?')).out).toBe('rc=0\n');
    const start = Date.now();
    expect(await node(`setTimeout(() => console.log('next done'), 30);`)).toBe('next done\n');
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 60_000);

  it('worker_threads: a pool worker gets workerData and answers messages', async () => {
    await fs.writeFile('/home/user/m/w.js', `const { parentPort, workerData, isMainThread } = require('worker_threads');
parentPort.on('message', (m) => parentPort.postMessage({ sum: m.a + m.b + workerData.base, main: isMainThread }));`);
    expect(await node(`const { Worker, isMainThread } = require('worker_threads');
const w = new Worker(require('path').join(__dirname, 'w.js'), { workerData: { base: 100 } });
w.on('online', () => console.log('online', isMainThread));
w.on('message', (m) => { console.log('reply', m.sum, m.main); w.terminate(); });
w.on('exit', (c) => console.log('exit', c));
w.postMessage({ a: 1, b: 2 });`)).toBe('online true\nreply 103 false\nexit 0\n');
  }, 60_000);

  it('fs: a sync mkdir then write is stored; directory renames wait for the writes into them', async () => {
    expect(await node(`const fs = require('fs');
fs.mkdirSync('/home/user/m/d1/sub', { recursive: true }); fs.writeFileSync('/home/user/m/d1/sub/a.txt', 'A');
fs.mkdirSync('/home/user/m/stage', { recursive: true }); fs.writeFileSync('/home/user/m/src.txt', 'S');
fs.copyFileSync('/home/user/m/src.txt', '/home/user/m/stage/b.txt'); fs.writeFileSync('/home/user/m/stage/c.txt', 'C');
fs.renameSync('/home/user/m/stage', '/home/user/m/pkg');
console.log(fs.readdirSync('/home/user/m/pkg').join(','), fs.existsSync('/home/user/m/stage'));`)).toBe('b.txt,c.txt false\n');
    const r = await sh(shell, 'cd /home/user/m && cat d1/sub/a.txt pkg/b.txt pkg/c.txt; ls stage 2>/dev/null || echo " gone"');
    expect(r.out).toBe('ASC gone\n');
  }, 60_000);

  it('fs: write-file-atomic\'s sequence (fs.write of a string, fsync, close, chmod, rename) lands the file', async () => {
    expect(await node(`const fs = require('fs'); const { promisify } = require('util');
(async () => {
  const fd = await promisify(fs.open)('/home/user/m/x.tmp', 'w');
  console.log('wrote', await promisify(fs.write)(fd, 'héllo\\n', 0, 'utf8'));
  await promisify(fs.fsync)(fd); await promisify(fs.close)(fd);
  await promisify(fs.chmod)('/home/user/m/x.tmp', 0o755);
  await promisify(fs.rename)('/home/user/m/x.tmp', '/home/user/m/x');
  console.log(await promisify(fs.unlink)('/home/user/m/x.tmp').catch((e) => e.code));
})();`)).toBe('wrote 7\nENOENT\n');
    const r = await sh(shell, 'cd /home/user/m && cat x && ls -l x');
    expect(r.out).toMatch(/^héllo\n-rwxr-xr-x /);
  }, 60_000);

  it('fs: symlinks keep relative targets; readdir dirents, realpath and lstat see them', async () => {
    expect(await node(`const fs = require('fs');
fs.mkdirSync('/home/user/m/real/pkg', { recursive: true }); fs.writeFileSync('/home/user/m/real/pkg/i.js', 'module.exports = 42');
fs.mkdirSync('/home/user/m/nm', { recursive: true });
fs.symlink('../real/pkg', '/home/user/m/nm/pkg', 'dir', async (e) => {
  console.log(e, fs.readlinkSync('/home/user/m/nm/pkg'));
  const d = fs.readdirSync('/home/user/m/nm', { withFileTypes: true })[0];
  console.log(d.name, d.isSymbolicLink(), d.isFile(), d.isDirectory());
  console.log(await fs.promises.realpath('/home/user/m/nm/pkg'), fs.realpathSync('/home/user/m/nm/pkg'));
  console.log(await fs.promises.realpath('/home/user/m/none').catch((e) => e.code));
});`)).toBe('null ../real/pkg\npkg true false false\n/home/user/m/real/pkg /home/user/m/real/pkg\nENOENT\n');
  }, 60_000);

  it('zlib, crypto hashes and Buffer views match node', async () => {
    expect(await node(`const zlib = require('zlib'); const crypto = require('crypto');
const gz = zlib.gzipSync('hello hello hello');
console.log(zlib.gunzipSync(gz).toString(), zlib.inflateSync(zlib.deflateSync(Buffer.from('abc'))).toString(), zlib.unzipSync(gz).length, zlib.crc32('hello'));
const chunks = []; const g = zlib.createGunzip(); g.on('data', (c) => chunks.push(c)); g.on('end', () => console.log('stream', Buffer.concat(chunks).toString()));
g.write(gz.subarray(0, 5)); g.end(gz.subarray(5));
console.log(crypto.createHash('sha512').update('abc').digest('hex').slice(0, 16), crypto.createHash('md5').update('abc').digest('hex'),
  crypto.createHmac('sha256', 'k').update('d').digest('base64'), crypto.createHash('sha384').update('').digest('hex').slice(0, 8));
const sab = new SharedArrayBuffer(4); new Uint8Array(sab)[1] = 7;
const b = Buffer.from(sab, 1, 2); console.log(b[0], b.length, Buffer.from('abcdef').subarray(1, 3).toString(), Buffer.from('hi', 'utf16le').length);`))
      .toBe('hello hello hello abc 17 907060870\nddaf35a193617aba 900150983cd24fb0d6963f7d28e17f72 ' + '5+ohw7y2Ok2jrXhQMWjTa9ygvmIjgupgoQj61OSWZnk=' + ' 38b060a7\n7 2 bc 4\nstream hello hello hello\n');
  }, 60_000);

  it('a node child of a node script exits when it is done (activity is per script)', async () => {
    await fs.writeFile('/home/user/m/c.js', `require('fs').promises.readFile('/home/user/m/c.js').then(() => console.log('child done'));`);
    const start = Date.now();
    expect(await node(`require('fs').promises.readFile(__filename).then(() => {});
const c = require('child_process').spawn('sh', ['-c', 'node c.js'], { stdio: [0, 1, 2] });
console.log(c.stdout === null);
c.on('close', (code) => console.log('closed', code));`)).toBe('true\nchild done\nclosed 0\n');
    expect(Date.now() - start).toBeLessThan(30_000);
  }, 60_000);

  it('fs.watch, watchFile and fs.promises.watch see writes from another process (rename vs change)', async () => {
    await fs.mkdir('/home/user/m/w/sub', { recursive: true });
    await fs.writeFile('/home/user/m/w/old.txt', 'old');
    await fs.writeFile('/home/user/m/watch.js', `const fs = require('fs'); const path = require('path');
const dir = '/home/user/m/w'; const ev = [];
const w = fs.watch(dir, (type, name) => ev.push('dir ' + type + ' ' + name));
const r = fs.watch(dir, { recursive: true }, (type, name) => { if (name.startsWith('sub')) ev.push('rec ' + type + ' ' + name); });
const f = fs.watch(path.join(dir, 'old.txt'), (type, name) => ev.push('file ' + type + ' ' + name + ' ' + fs.readFileSync(path.join(dir, 'old.txt'), 'utf8').trim()));
fs.watchFile(path.join(dir, 'old.txt'), (curr, prev) => ev.push('stat ' + prev.size + '->' + curr.size));
(async () => { for await (const e of fs.promises.watch(dir)) { if (e.filename === 'done') break; } ev.push('iter ended'); })();
setInterval(() => {
  if (!fs.existsSync(dir + '/done')) return;
  setTimeout(() => {
    w.close(); r.close(); f.close(); fs.unwatchFile(path.join(dir, 'old.txt'));
    console.log([...new Set(ev)].sort().join('\\n'));
    process.exit(0);
  }, 300);
}, 50);
console.log('watching');`);
    const watcher = sh(shell, 'cd /home/user/m && node watch.js');
    await new Promise((r) => setTimeout(r, 1500));
    // Another process writes: a new file, a change, a subdirectory file, a rename, a delete
    const other = (shell as any).fork();
    await sh(other, 'cd /home/user/m/w && echo hi > new.txt && echo more >> old.txt && echo s > sub/deep.txt && mv new.txt moved.txt && rm moved.txt && sleep 0.3 && touch done');
    const r = await watcher;
    // (Like Linux: a new file is 'rename' then 'change'; a non-recursive
    // directory watch doesn't see inside subdirectories)
    expect(r.out).toBe(`watching
dir change done
dir change new.txt
dir change old.txt
dir rename done
dir rename moved.txt
dir rename new.txt
file change old.txt oldmore
iter ended
rec change sub/deep.txt
rec rename sub/deep.txt
stat 3->8
`);
  }, 60_000);

  it('node:assert: match, rejects, deep equality and AssertionError like node', async () => {
    expect(await node(`const assert = require('assert'); const strict = require('node:assert/strict'); const r = [];
const t = (n, fn) => { try { fn(); r.push(n + ':ok'); } catch (e) { r.push(n + ':' + (e.code || e.name)); } };
t('match', () => assert.match('abc', /b/)); t('matchFail', () => assert.match('abc', /x/)); t('doesNotMatch', () => assert.doesNotMatch('abc', /b/));
t('dse', () => assert.deepStrictEqual({ a: [1, { b: new Map([[1, new Set([2])]]) }] }, { a: [1, { b: new Map([[1, new Set([2])]]) }] }));
t('dseProto', () => assert.deepStrictEqual(Object.create(null), {})); t('deProto', () => assert.deepEqual(Object.create(null), {}));
t('dseNaN', () => assert.deepStrictEqual([NaN], [NaN])); t('dseZero', () => assert.deepStrictEqual(-0, 0)); t('deLoose', () => assert.deepEqual({ a: 1 }, { a: '1' }));
t('dseCycle', () => { const a = {}; a.s = a; const b = {}; b.s = b; assert.deepStrictEqual(a, b); });
t('throwsWrong', () => assert.throws(() => { throw new TypeError('x'); }, RangeError));
t('throwsObj', () => assert.throws(() => { throw Object.assign(new Error('m'), { code: 'E1' }); }, { code: 'E1', message: /m/ }));
t('throwsNone', () => assert.throws(() => {})); t('strictMode', () => strict.equal(1, '1')); t('loose', () => assert.equal(1, '1'));
t('ifError', () => assert.ifError(new Error('e')));
try { assert.strictEqual(1, 2); } catch (e) { r.push([e.name, e.code, e.actual, e.expected, e.operator, e.generatedMessage, e instanceof assert.AssertionError].join(',')); }
(async () => {
  const at = async (n, p) => { try { await p; r.push(n + ':ok'); } catch (e) { r.push(n + ':' + (e.code || e.name)); } };
  await at('rejects', assert.rejects(Promise.reject(new TypeError('a')), TypeError)); await at('rejectsNone', assert.rejects(Promise.resolve(1)));
  await at('doesNotReject', assert.doesNotReject(async () => { throw new Error('w'); }));
  console.log(r.join(' '), assert.strict === strict, require('util').isDeepStrictEqual([1], ['1']));
})();`)).toBe('match:ok matchFail:ERR_ASSERTION doesNotMatch:ERR_ASSERTION dse:ok dseProto:ERR_ASSERTION deProto:ok dseNaN:ok dseZero:ERR_ASSERTION deLoose:ok dseCycle:ok '
      + 'throwsWrong:ERR_ASSERTION throwsObj:ok throwsNone:ERR_ASSERTION strictMode:ERR_ASSERTION loose:ok ifError:ERR_ASSERTION '
      + 'AssertionError,ERR_ASSERTION,1,2,strictEqual,true,true rejects:ok rejectsNone:ERR_ASSERTION doesNotReject:ERR_ASSERTION true false\n');
  }, 60_000);

  it('fs streams: binary round trip through pipe, append, events', async () => {
    expect(await node(`const fs = require('fs'); const { pipeline, Transform } = require('stream');
const bin = Buffer.from([0, 255, 128, 10, 200, 1]);
const ws = fs.createWriteStream('a.bin');
ws.on('open', () => console.log('open'));
ws.write(bin.subarray(0, 3)); ws.end(bin.subarray(3), () => {
  console.log('finish', ws.bytesWritten, fs.readFileSync('a.bin').equals(bin));
  const inc = new Transform({ transform(c, e, cb) { cb(null, Buffer.from(c.map(b => (b + 1) & 255))); } });
  pipeline(fs.createReadStream('a.bin'), inc, fs.createWriteStream('b.bin'), (err) => {
    console.log('piped', err, [...fs.readFileSync('b.bin')].join(','));
    const ap = fs.createWriteStream('b.bin', { flags: 'a' }); ap.end('!', () => {
      console.log('appended', fs.readFileSync('b.bin').length);
      fs.createReadStream('missing').on('error', (e) => console.log('error', e.code));
    });
  });
});`)).toBe('open\nfinish 6 true\npiped null 1,0,129,11,201,2\nappended 7\nerror ENOENT\n');
  }, 60_000);

  it('package exports: require picks require over import (browser first), import() a namespace', async () => {
    await fs.mkdir('/home/user/m/node_modules/dual/esm', { recursive: true });
    await fs.writeFile('/home/user/m/node_modules/dual/package.json', JSON.stringify({ name: 'dual', exports: { '.': { import: './esm/index.mjs', require: './index.cjs' }, './feature': { browser: './b.js', node: './n.js' } } }));
    await fs.writeFile('/home/user/m/node_modules/dual/index.cjs', 'module.exports = { kind: "cjs" };');
    await fs.writeFile('/home/user/m/node_modules/dual/esm/index.mjs', 'export const kind = "esm";');
    await fs.writeFile('/home/user/m/node_modules/dual/n.js', 'module.exports = "node";');
    await fs.writeFile('/home/user/m/node_modules/dual/b.js', 'module.exports = "browser";');
    expect(await node(`console.log(require('dual').kind, require('dual/feature'));
import('dual').then(ns => console.log(ns.default.kind, ns.kind));
const dyn = new Function('m', 'return import(m)'); dyn('./node_modules/dual/n.js').then(ns => console.log(ns.default));`))
      .toBe('cjs browser\ncjs cjs\nnode\n');
  }, 60_000);

  // Expected values are real node 22's (cases ported from node's
  // test/parallel/test-fs-open-flags, test-fs-write-file*, test-fs-lstat* and test-fs-realpath*)
  const fsCase = `const fs = require('fs'); const path = require('path'); const C = fs.constants;
const D = '/home/user/m/fsf'; fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
const j = (n) => path.join(D, n); const r = [];
const t = (name, fn) => { try { r.push(name + '=' + fn()); } catch (e) { r.push(name + '=' + e.code); } };
const perm = (n) => (fs.statSync(j(n)).mode & 0o777).toString(8);`;

  it('fs open flags: O_CREAT without a write bit creates, wx/O_EXCL is EEXIST, a missing file without O_CREAT is ENOENT', async () => {
    expect(await node(`${fsCase}
t('creat', () => { fs.closeSync(fs.openSync(j('c1'), C.O_CREAT)); return fs.existsSync(j('c1')); });
t('creatExcl', () => { const fd = fs.openSync(j('c2'), C.O_CREAT | C.O_EXCL | C.O_WRONLY); fs.writeSync(fd, 'x'); fs.closeSync(fd); return fs.readFileSync(j('c2'), 'utf8'); });
fs.writeFileSync(j('e'), 'keep');
t('wx', () => fs.openSync(j('e'), 'wx')); t('wxs', () => fs.openSync(j('e'), 'wx+'));
t('excl', () => fs.openSync(j('e'), C.O_CREAT | C.O_EXCL | C.O_RDWR));
t('ax', () => fs.openSync(j('e'), 'ax'));
t('kept', () => fs.readFileSync(j('e'), 'utf8'));
t('r', () => fs.openSync(j('nope'), 'r')); t('rplus', () => fs.openSync(j('nope'), 'r+')); t('rdwr', () => fs.openSync(j('nope'), C.O_RDWR));
t('a', () => { fs.closeSync(fs.openSync(j('a1'), 'a')); return fs.existsSync(j('a1')); });
t('rplusKeeps', () => { const fd = fs.openSync(j('e'), 'r+'); fs.closeSync(fd); return fs.readFileSync(j('e'), 'utf8'); });
t('trunc', () => { fs.closeSync(fs.openSync(j('e'), C.O_WRONLY | C.O_TRUNC)); return JSON.stringify(fs.readFileSync(j('e'), 'utf8')); });
t('openMode', () => { fs.closeSync(fs.openSync(j('om'), 'w', 0o600)); return perm('om'); });
fs.open(j('c1'), 'wx', (e) => { r.push('cbwx=' + (e && e.code));
  fs.open(j('nope'), (e2) => { r.push('cbr=' + (e2 && e2.code));
    fs.promises.open(j('c1'), 'wx').then(() => r.push('pwx=opened'), (e3) => r.push('pwx=' + e3.code)).then(() => console.log(r.join(' ')));
  });
});`)).toBe('creat=true creatExcl=x wx=EEXIST wxs=EEXIST excl=EEXIST ax=EEXIST kept=keep r=ENOENT rplus=ENOENT rdwr=ENOENT a=true rplusKeeps=keep trunc="" openMode=600 cbwx=EEXIST cbr=ENOENT pwx=EEXIST\n');
  }, 60_000);

  it('fs writeFile options: flag, mode and encoding (sync, callback and promise)', async () => {
    expect(await node(`${fsCase}
fs.writeFileSync(j('w'), 'one');
t('flagA', () => { fs.writeFileSync(j('w'), 'two', { flag: 'a' }); return fs.readFileSync(j('w'), 'utf8'); });
t('wx', () => fs.writeFileSync(j('w'), 'no', { flag: 'wx' })); t('kept', () => fs.readFileSync(j('w'), 'utf8'));
t('mode', () => { fs.writeFileSync(j('m'), 'x', { mode: 0o600 }); return perm('m'); });
t('modeStr', () => { fs.writeFileSync(j('ms'), 'x', { mode: '0640' }); return perm('ms'); });
t('modeUmask', () => { fs.writeFileSync(j('mu'), 'x', { mode: 0o777 }); return perm('mu'); });
t('modeKeepsExisting', () => { fs.writeFileSync(j('m'), 'y', { mode: 0o644 }); return perm('m'); });
t('hex', () => { fs.writeFileSync(j('h'), '6869', 'hex'); return fs.readFileSync(j('h'), 'utf8'); });
t('base64', () => { fs.writeFileSync(j('b'), 'aGk=', { encoding: 'base64' }); return fs.readFileSync(j('b'), 'utf8'); });
t('latin1', () => { fs.writeFileSync(j('l'), '\\u00e9', 'latin1'); return fs.statSync(j('l')).size; });
t('append', () => { fs.appendFileSync(j('w'), '3'); return fs.readFileSync(j('w'), 'utf8'); });
t('appendMode', () => { fs.appendFileSync(j('am'), 'x', { mode: 0o640 }); return perm('am'); });
t('appendAx', () => fs.appendFileSync(j('am'), 'x', { flag: 'ax' }));
t('fd', () => { const fd = fs.openSync(j('fd'), 'w'); fs.writeFileSync(fd, 'via fd'); fs.closeSync(fd); return fs.readFileSync(j('fd'), 'utf8'); });
fs.writeFile(j('w'), 'Z', { flag: 'a' }, (e) => { r.push('cbFlagA=' + (e ? e.code : fs.readFileSync(j('w'), 'utf8')));
  fs.writeFile(j('cm'), 'x', { mode: 0o600 }, () => { r.push('cbMode=' + perm('cm'));
    fs.appendFile(j('w'), 'Q', (e2) => { r.push('cbAppend=' + (e2 ? e2.code : fs.readFileSync(j('w'), 'utf8')));
      fs.writeFile(j('w'), 'no', { flag: 'wx' }, (e3) => { r.push('cbWx=' + (e3 && e3.code));
        (async () => {
          await fs.promises.writeFile(j('w'), 'P', { flag: 'a' }); r.push('pFlagA=' + await fs.promises.readFile(j('w'), 'utf8'));
          await fs.promises.writeFile(j('w'), 'no', 'wx').catch(() => {});
          await fs.promises.writeFile(j('w'), 'no', { flag: 'wx' }).then(() => r.push('pWx=wrote'), (e4) => r.push('pWx=' + e4.code));
          await fs.promises.appendFile(j('pa'), 'x', { mode: 0o600 }); r.push('pAppendMode=' + perm('pa'));
          await fs.promises.writeFile(j('ph'), '6869', 'hex'); r.push('pHex=' + fs.readFileSync(j('ph'), 'utf8'));
          const h = await fs.promises.open(j('fh'), 'w'); await h.writeFile('handle'); await h.close(); r.push('handle=' + fs.readFileSync(j('fh'), 'utf8'));
          console.log(r.join(' '));
        })();
      });
    });
  });
});`)).toBe('flagA=onetwo wx=EEXIST kept=onetwo mode=600 modeStr=640 modeUmask=755 modeKeepsExisting=600 hex=hi base64=hi latin1=1 append=onetwo3 appendMode=640 appendAx=EEXIST fd=via fd ' +
      'cbFlagA=onetwo3Z cbMode=600 cbAppend=onetwo3ZQ cbWx=EEXIST pFlagA=onetwo3ZQP pWx=EEXIST pAppendMode=600 pHex=hi handle=handle\n');
    // the modes reach the filesystem once the script is done
    expect((await sh(shell, 'stat -c %a /home/user/m/fsf/m /home/user/m/fsf/am')).out).toBe('600\n640\n');
  }, 60_000);

  it('fs mkdir mode applies to each directory it creates (sync, callback and promise)', async () => {
    expect(await node(`${fsCase}
fs.mkdirSync(j('a/b/c'), { recursive: true, mode: 0o700 }); r.push('rec=' + perm('a') + ',' + perm('a/b') + ',' + perm('a/b/c'));
fs.mkdirSync(j('a/b/d'), { recursive: true, mode: 0o750 }); r.push('existingKept=' + perm('a/b') + ' new=' + perm('a/b/d'));
fs.mkdirSync(j('plain'), 0o711); r.push('num=' + perm('plain'));
fs.mkdirSync(j('dflt')); r.push('default=' + perm('dflt'));
fs.mkdir(j('cb'), { mode: 0o700 }, () => { r.push('cb=' + perm('cb'));
  fs.promises.mkdir(j('p/q'), { recursive: true, mode: 0o700 }).then(() => { r.push('p=' + perm('p') + ',' + perm('p/q')); console.log(r.join(' ')); });
});`)).toBe('rec=700,700,700 existingKept=700 new=750 num=711 default=755 cb=700 p=700,700\n');
    expect((await sh(shell, 'stat -c %a /home/user/m/fsf/a/b/c /home/user/m/fsf/p/q')).out).toBe('700\n700\n');
  }, 60_000);

  it('fs lstat and realpath see symlinks; ino and dev are stable', async () => {
    expect(await node(`${fsCase}
fs.writeFileSync(j('f'), 'data'); fs.mkdirSync(j('dir')); fs.writeFileSync(j('dir/in'), 'x');
fs.symlinkSync('f', j('L')); fs.symlinkSync(j('dir'), j('DL')); fs.symlinkSync('gone', j('dangling'));
t('lstatLink', () => fs.lstatSync(j('L')).isSymbolicLink() + '/' + fs.lstatSync(j('L')).isFile());
t('lstatMode', () => (fs.lstatSync(j('L')).mode & C.S_IFMT) === C.S_IFLNK);
t('lstatSize', () => fs.lstatSync(j('L')).size);
t('statLink', () => fs.statSync(j('L')).isSymbolicLink() + '/' + fs.statSync(j('L')).isFile() + '/' + fs.statSync(j('L')).size);
t('lstatFile', () => fs.lstatSync(j('f')).isSymbolicLink());
t('lstatDir', () => fs.lstatSync(j('dir')).isDirectory());
t('lstatDirLink', () => fs.lstatSync(j('DL')).isSymbolicLink() + '/' + fs.statSync(j('DL')).isDirectory());
t('lstatDangling', () => fs.lstatSync(j('dangling')).isSymbolicLink());
t('statDangling', () => fs.statSync(j('dangling')));
t('lstatMissing', () => fs.lstatSync(j('nope')));
t('noThrow', () => fs.lstatSync(j('nope'), { throwIfNoEntry: false }));
t('direntLink', () => fs.readdirSync(D, { withFileTypes: true }).find((d) => d.name === 'L').isSymbolicLink());
t('existsSymlink', () => fs.symlinkSync('f', j('L')));
t('realLink', () => path.relative(D, fs.realpathSync(j('L'))));
t('realThroughDir', () => path.relative(D, fs.realpathSync(j('DL/in'))));
t('realDot', () => fs.realpathSync(D + '/./dir/../f') === fs.realpathSync(j('f')));
t('realDangling', () => fs.realpathSync(j('dangling')));
t('realMissing', () => fs.realpathSync(j('later')));
t('realLater', () => { const before = fs.existsSync(j('later')); fs.writeFileSync(j('later'), 'x'); return before + '/' + (fs.realpathSync(j('later')) === j('later')) + '/' + (fs.realpathSync(j('later')) === fs.realpathSync(j('later'))); });
t('realLaterViaLink', () => { fs.writeFileSync(j('DL/later'), 'y'); return path.relative(D, fs.realpathSync(j('DL/later'))); });
const s1 = fs.statSync(j('f')), s2 = fs.statSync(j('f'));
t('inoStable', () => s1.ino === s2.ino && s1.dev === s2.dev && s1.ino > 0);
t('inoAfterWrite', () => { fs.writeFileSync(j('f'), 'more'); return fs.statSync(j('f')).ino === s1.ino; });
t('inoDistinct', () => fs.statSync(j('dir')).ino !== s1.ino && fs.statSync(j('dir/in')).ino !== s1.ino);
t('inoViaLink', () => fs.statSync(j('L')).ino === s1.ino && fs.lstatSync(j('L')).ino !== s1.ino);
(async () => {
  r.push('pLstat=' + (await fs.promises.lstat(j('L'))).isSymbolicLink() + '/' + (await fs.promises.stat(j('L'))).isFile());
  r.push('pIno=' + ((await fs.promises.stat(j('L'))).ino === s1.ino));
  r.push('pReal=' + path.relative(D, await fs.promises.realpath(j('DL/in'))));
  await fs.promises.realpath(j('nope2')).catch((e) => r.push('pRealMissing=' + e.code));
  await fs.promises.symlink('f', j('L')).catch((e) => r.push('pSymlinkExists=' + e.code));
  await fs.promises.lstat(j('nope')).catch((e) => r.push('pLstatMissing=' + e.code));
  fs.lstat(j('L'), (e, st) => { r.push('cbLstat=' + st.isSymbolicLink());
    fs.stat(j('L'), (e2, st2) => { r.push('cbStat=' + st2.isFile() + '/' + (st2.ino === s1.ino)); console.log(r.join(' ')); });
  });
})();`)).toBe('lstatLink=true/false lstatMode=true lstatSize=1 statLink=false/true/4 lstatFile=false lstatDir=true lstatDirLink=true/true lstatDangling=true ' +
      'statDangling=ENOENT lstatMissing=ENOENT noThrow=undefined direntLink=true existsSymlink=EEXIST realLink=f realThroughDir=dir/in realDot=true realDangling=ENOENT ' +
      'realMissing=ENOENT realLater=false/true/true realLaterViaLink=dir/later inoStable=true inoAfterWrite=true inoDistinct=true inoViaLink=true ' +
      'pLstat=true/true pIno=true pReal=dir/in pRealMissing=ENOENT pSymlinkExists=EEXIST pLstatMissing=ENOENT cbLstat=true cbStat=true/true\n');
  }, 60_000);
});

describe('node: real npm packages', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await bootFiles(fs);
    await fs.mkdir('/home/user/app/test', { recursive: true });
    const r = await sh(shell, 'cd /home/user/app && npm init -y > /dev/null && npm install commander@12.1.0 chalk@4.1.2 dayjs@1.11.13 uuid@10.0.0 mocha@10.8.2 typescript@5.6.3 prettier@3.3.3');
    expect(r.exitCode).toBe(0);
  }, 300_000);

  it('npm install in a directory without package.json starts one, as npm does', async () => {
    const r = await sh(shell, 'mkdir -p /home/user/nopkg && cd /home/user/nopkg && npm install dayjs@1.11.13 > /dev/null; echo "e=$?"; cat package.json; node -e "console.log(typeof require(\'dayjs\'))"; npm install; echo "f=$?"');
    expect(r.out).toContain('e=0');
    expect(JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))).toEqual({ dependencies: { dayjs: '1.11.13' } });
    expect(r.out).toContain('function\n');
    expect(r.out).toContain('f=0');
    expect((await sh(shell, 'mkdir -p /home/user/nopkg2 && cd /home/user/nopkg2 && npm install; echo "g=$?"; ls')).out).toBe('up to date, audited 0 packages\ng=0\n');
  }, 120_000);

  it('pnpm: add into the virtual store, require through its symlinks, run scripts, exec bins', async () => {
    let r = await sh(shell, 'mkdir -p /home/user/pn && cd /home/user/pn && npm init -y > /dev/null && npm install pnpm@9.12.3 > /dev/null; echo $?');
    expect(r.out).toBe('0\n');
    await fs.mkdir('/home/user/pq', { recursive: true });
    await fs.writeFile('/home/user/pq/package.json', JSON.stringify({ name: 'pq', version: '1.0.0', scripts: { go: 'node app.js', v: 'semver 1.2.3 -r ^1' } }));
    await fs.writeFile('/home/user/pq/app.js', `const isOdd = require('is-odd'); const semver = require('semver');
console.log(isOdd(3), isOdd(4), semver.satisfies('1.2.3', '^1'), require.resolve('is-odd'));`);
    const pnpm = '/home/user/pn/node_modules/.bin/pnpm';
    r = await sh(shell, `cd /home/user/pq && ${pnpm} add is-odd@3.0.1 semver@7.6.3`);
    expect(r.exitCode).toBe(0);
    expect(plain(r.out)).toMatch(/\+ is-odd 3\.0\.1/);
    // package.json, the lockfile and .modules.yaml land (write-file-atomic: open, write, rename)
    expect(JSON.parse(await fs.readFile('/home/user/pq/package.json', 'utf8') as string).dependencies).toEqual({ 'is-odd': '3.0.1', semver: '7.6.3' });
    r = await sh(shell, 'cd /home/user/pq && readlink node_modules/is-odd node_modules/.pnpm/is-odd@3.0.1/node_modules/is-number && ls -a node_modules node_modules/.pnpm/is-odd@3.0.1/node_modules/is-odd && head -1 pnpm-lock.yaml');
    expect(r.out).toBe(`.pnpm/is-odd@3.0.1/node_modules/is-odd
../../is-number@6.0.0/node_modules/is-number
node_modules:
.
..
.bin
.modules.yaml
.pnpm
is-odd
semver

node_modules/.pnpm/is-odd@3.0.1/node_modules/is-odd:
.
..
LICENSE
README.md
index.js
package.json
lockfileVersion: '9.0'
`);
    // node resolves from the real path, as node does (is-odd finds is-number beside it)
    r = await sh(shell, `cd /home/user/pq && ${pnpm} run go`);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('true false true /home/user/pq/node_modules/.pnpm/is-odd@3.0.1/node_modules/is-odd/index.js\n');
    r = await sh(shell, `cd /home/user/pq && ${pnpm} run v && ${pnpm} exec semver -i minor 1.2.3 && node_modules/.bin/semver 2.0.0 -r '>1'`);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/> semver 1\.2\.3 -r \^1\n\n1\.2\.3\n1\.3\.0\n2\.0\.0\n$/);
    // A reinstall from the store, offline
    r = await sh(shell, `cd /home/user/pq && rm -rf node_modules && ${pnpm} install --offline; echo "rc=$?"`);
    expect(r.out, r.out + r.err).toMatch(/rc=0\n$/);
    r = await sh(shell, 'cd /home/user/pq && ls node_modules node_modules/.pnpm; node app.js; echo "rc=$?"');
    expect(r.out, r.out + r.err).toContain('true false true');
  }, 300_000);

  it('yarn 1: add from the registry, lockfile, run, bins, offline reinstall from its cache', async () => {
    let r = await sh(shell, 'mkdir -p /home/user/yn && cd /home/user/yn && npm init -y > /dev/null && npm install yarn@1.22.22 > /dev/null; echo $?');
    expect(r.out).toBe('0\n');
    await fs.mkdir('/home/user/yq', { recursive: true });
    await fs.writeFile('/home/user/yq/package.json', JSON.stringify({ name: 'yq', version: '1.0.0', license: 'MIT', scripts: { go: 'node app.js' } }));
    await fs.writeFile('/home/user/yq/app.js', `console.log(require('is-odd')(3), require('semver').valid('1.2.3'));`);
    const yarn = '/home/user/yn/node_modules/.bin/yarn';
    r = await sh(shell, `cd /home/user/yq && ${yarn} add is-odd@3.0.1 semver@7.6.3`);
    expect(r.exitCode).toBe(0);
    expect(plain(r.out)).toMatch(/success Saved 3 new dependencies/);
    r = await sh(shell, 'cd /home/user/yq && ls node_modules node_modules/.bin && grep -c resolved yarn.lock && wc -c < node_modules/is-odd/index.js');
    expect(r.out).toMatch(/^node_modules:\nis-number\nis-odd\nsemver\n\nnode_modules\/.bin:\nsemver\n3\n\s*\d{3,}\n$/);
    r = await sh(shell, `cd /home/user/yq && ${yarn} run go && node_modules/.bin/semver -i major 1.2.3`);
    expect(r.exitCode).toBe(0);
    expect(plain(r.out)).toMatch(/\$ node app\.js\ntrue 1\.2\.3\n(.|\n)*2\.0\.0\n$/);
    r = await sh(shell, `cd /home/user/yq && rm -rf node_modules && ${yarn} install --offline > /dev/null && node app.js`);
    expect(r.out).toBe('true 1.2.3\n');
  }, 300_000);

  it('chokidar 3 reports add, change, unlink and addDir for another process\'s writes', async () => {
    let r = await sh(shell, 'mkdir -p /home/user/ck/src/lib && cd /home/user/ck && npm init -y > /dev/null && npm install chokidar@3.6.0 > /dev/null; echo $?');
    expect(r.out).toBe('0\n');
    await fs.writeFile('/home/user/ck/src/a.js', 'a');
    await fs.writeFile('/home/user/ck/w.js', `const chokidar = require('chokidar'); const fs = require('fs'); const ev = [];
const w = chokidar.watch('src', { ignoreInitial: true });
w.on('all', (e, p) => { ev.push(e + ' ' + p); if (p.endsWith('stop')) setTimeout(() => { w.close().then(() => { console.log([...new Set(ev)].filter((x) => !x.includes('stop')).sort().join('\\n')); process.exit(0); }); }, 300); });
w.on('ready', () => console.log('ready'));`);
    const watcher = sh(shell, 'cd /home/user/ck && node w.js');
    await new Promise((res) => setTimeout(res, 2000));
    await sh((shell as any).fork(), 'cd /home/user/ck/src && echo b > b.js && echo aa >> a.js && mkdir lib/deep && echo c > lib/c.js && rm b.js && sleep 0.5 && touch stop');
    r = await watcher;
    expect(r.out).toBe('ready\nadd src/b.js\nadd src/lib/c.js\naddDir src/lib/deep\nchange src/a.js\nunlink src/b.js\n');
  }, 180_000);

  it('a CLI on commander, chalk, dayjs and uuid', async () => {
    // commander declares `const process = require('node:process')` at top level
    await fs.writeFile('/home/user/app/cli.js', `const { program } = require('commander');
program.name('greet').option('-n, --name <name>', 'who', 'world').option('-l, --loud');
program.parse();
const o = program.opts();
const chalk = require('chalk');
const dayjs = require('dayjs');
const { v4, validate } = require('uuid');
console.log(o.loud ? ('hello ' + o.name).toUpperCase() : 'hello ' + o.name, chalk.red('x').length > 0, dayjs('2024-01-31').add(1, 'month').format('YYYY-MM-DD'), validate(v4()));
console.log('%s has %d items (%j)', 'list', 3, { a: 1 });
`);
    const r = await sh(shell, 'cd /home/user/app && node cli.js --name shiro -l');
    expect(r.err).toBe('');
    expect(r.out).toBe('HELLO SHIRO true 2024-02-29 true\nlist has 3 items ({"a":1})\n');
  }, 60_000);

  it('mocha runs a spec (pass and fail exit codes)', async () => {
    await fs.writeFile('/home/user/app/test/a.spec.js', `const assert = require('assert');
describe('math', () => {
  it('adds', () => assert.strictEqual(1 + 1, 2));
  it('waits', async () => { await new Promise(r => setTimeout(r, 5)); });
});
`);
    let r = await sh(shell, 'cd /home/user/app && npx mocha test/a.spec.js');
    expect(plain(r.out)).toMatch(/math\n {4}✔ adds\n {4}✔ waits\n[\s\S]*2 passing/);
    expect(r.exitCode).toBe(0);
    await fs.writeFile('/home/user/app/test/b.spec.js', `const assert = require('assert');
describe('broken', () => { it('fails', () => assert.strictEqual(1, 2)); });
`);
    r = await sh(shell, 'cd /home/user/app && npx mocha test/b.spec.js');
    expect(plain(r.out)).toMatch(/0 passing[\s\S]*1 failing/);
    expect(r.exitCode).not.toBe(0);
  }, 120_000);

  it('ES modules may bind module, require and process themselves', async () => {
    await fs.writeFile('/home/user/app/lib.mjs', `import module from 'node:module';
import process from 'node:process';
const require = module.createRequire(import.meta.url);
const dayjs = require('dayjs');
export const year = dayjs('2020-05-05').year();
export default function plat() { return typeof process.platform; }
`);
    await fs.writeFile('/home/user/app/main.mjs', `import plat, { year } from './lib.mjs';
const { default: again } = await import(new URL('./lib.mjs', import.meta.url));
console.log(year, plat(), again === plat);
`);
    const r = await sh(shell, 'cd /home/user/app && node main.mjs');
    expect(r.err).toBe('');
    expect(r.out).toBe('2020 string true\n');
  }, 60_000);

  it('tsc type-checks and compiles', async () => {
    await fs.writeFile('/home/user/app/hello.ts', 'export function greet(name: string): string { return `hi ${name}`; }\nconsole.log(greet("ts"));\n');
    let r = await sh(shell, 'cd /home/user/app && npx tsc --version | od -c; node node_modules/typescript/bin/tsc --version | od -c');
    console.log(r.out);
    r = await sh(shell, 'cd /home/user/app && npx tsc --version');
    expect(r.out).toBe('Version 5.6.3\n');
    r = await sh(shell, 'cd /home/user/app && npx tsc --target es2020 --module commonjs hello.ts && node hello.js');
    expect(r.err).toBe('');
    expect(r.out).toBe('hi ts\n');
    await fs.writeFile('/home/user/app/bad.ts', 'const n: number = "str";\n');
    r = await sh(shell, 'cd /home/user/app && npx tsc --noEmit bad.ts');
    expect(r.out).toContain("error TS2322: Type 'string' is not assignable to type 'number'");
    expect(r.exitCode).not.toBe(0);
  }, 300_000);

  it('prettier formats files, stdin, and globs (--check, --write)', async () => {
    await fs.mkdir('/home/user/app/src/lib', { recursive: true });
    await fs.writeFile('/home/user/app/src/ugly.js', 'const a = {b:1,c:[1,2,3]}\nfunction f( x ){return x*2}\n');
    await fs.writeFile('/home/user/app/src/lib/fine.js', 'export const ok = true;\n');
    const pretty = 'const a = { b: 1, c: [1, 2, 3] };\nfunction f(x) {\n  return x * 2;\n}\n';
    let r = await sh(shell, 'cd /home/user/app && npx prettier src/ugly.js');
    expect(r.err).toBe('');
    expect(r.out).toBe(pretty);
    r = await sh(shell, 'cd /home/user/app && npx prettier --stdin-filepath x.js < src/ugly.js');
    expect(r.out).toBe(pretty);
    // a glob walks the tree (fast-glob), skipping node_modules
    r = await sh(shell, 'cd /home/user/app && npx prettier --check "src/**/*.js"');
    expect(plain(r.err)).toContain('[warn] src/ugly.js');
    expect(r.err).not.toContain('fine.js');
    expect(r.exitCode).toBe(1);
    r = await sh(shell, 'cd /home/user/app && npx prettier --write src && cat src/ugly.js');
    expect(r.out).toContain(pretty);
    r = await sh(shell, 'cd /home/user/app && npx prettier --check src');
    expect(r.exitCode).toBe(0);
  }, 180_000);

});

describe('lua and sqlite packages', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await bootFiles(fs);
    const r = await sh(shell, 'pkg install lua sqlite');
    expect(r.exitCode).toBe(0);
  }, 300_000);

  it('lua: #! script with stdin, argv, coroutines, string patterns; luac -p', async () => {
    await script(fs, '/home/user/wc.lua', `#!/usr/bin/env lua
local counts, order = {}, {}
for line in io.lines() do
  for w in line:lower():gmatch("%a+") do
    if not counts[w] then counts[w] = 0; order[#order + 1] = w end
    counts[w] = counts[w] + 1
  end
end
table.sort(order, function(a, b) return counts[a] > counts[b] or (counts[a] == counts[b] and a < b) end)
local gen = coroutine.wrap(function() for _, w in ipairs(order) do coroutine.yield(w) end end)
local out = {}
for i = 1, tonumber(arg[1]) do out[#out + 1] = string.format("%s=%d", gen(), counts[order[i]]) end
print(table.concat(out, " "), _VERSION)
`);
    let r = await sh(shell, 'cd /home/user && printf "the cat\\nThe dog the end\\n" | ./wc.lua 2');
    expect(r.err).toBe('');
    expect(r.out).toBe('the=3 cat=1\tLua 5.4\n');
    await fs.writeFile('/home/user/bad.lua', 'local x = = 1\n');
    r = await sh(shell, 'cd /home/user && luac -p wc.lua && echo ok; luac -p bad.lua');
    expect(r.out).toBe('ok\n');
    expect(r.err).toMatch(/bad\.lua:1: unexpected symbol near '='/);
  }, 120_000);

  it('sqlite3: a database file across runs, JSON, FTS5, and SQL on stdin', async () => {
    let r = await sh(shell, `cd /home/user && sqlite3 app.db "create table t(id integer primary key, doc text); insert into t(doc) values ('{\\"n\\":1,\\"tag\\":\\"a\\"}'), ('{\\"n\\":2,\\"tag\\":\\"b\\"}');"`);
    expect(r.exitCode).toBe(0);
    r = await sh(shell, `cd /home/user && sqlite3 app.db "select sum(json_extract(doc, '$.n')), group_concat(json_extract(doc, '$.tag'), '') from t;"`);
    expect(r.out).toBe('3|ab\n');
    r = await sh(shell, `cd /home/user && printf "create virtual table f using fts5(body);\\ninsert into f values ('shiro runs sqlite'), ('nothing here');\\nselect body from f where f match 'sqlite';\\n.mode csv\\nselect 1, 'x y';\\n" | sqlite3`);
    expect(r.err).toBe('');
    expect(r.out).toBe('shiro runs sqlite\n1,"x y"\n');
  }, 120_000);
});

describe('ninja and cmake (x86-64 in Blink) with clang', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await bootFiles(fs);
    const r = await sh(shell, 'pkg install llvm ninja make cmake');
    expect(r.err).toBe('');
    expect(r.exitCode).toBe(0);
  }, 300_000);

  it('ninja builds a C program with clang, incrementally, with depfiles', async () => {
    await fs.mkdir('/home/user/nj', { recursive: true });
    await fs.writeFile('/home/user/nj/build.ninja', [
      'cflags = -O2', 'rule cc', '  command = clang $cflags -MD -MF $out.d -c $in -o $out', '  depfile = $out.d', '  deps = gcc', '  description = CC $out',
      'rule link', '  command = clang $in -o $out', '  description = LINK $out',
      'build main.o: cc main.c', 'build util.o: cc util.c', 'build app: link main.o util.o', 'default app', ''].join('\n'));
    await fs.writeFile('/home/user/nj/util.h', '#define GREETING "hello"\nint twice(int);\n');
    await fs.writeFile('/home/user/nj/util.c', '#include "util.h"\nint twice(int x) { return 2 * x; }\n');
    await fs.writeFile('/home/user/nj/main.c', '#include <stdio.h>\n#include "util.h"\nint main(void) { printf("%s %d\\n", GREETING, twice(21)); return 0; }\n');
    let r = await sh(shell, 'cd /home/user/nj && ninja && ./app');
    expect(r.err).toBe('');
    expect(r.out).toMatch(/\[3\/3\] LINK app\nhello 42\n$/);
    r = await sh(shell, 'cd /home/user/nj && ninja');
    expect(r.out).toBe('ninja: no work to do.\n');
    // the header is a dependency through the depfile: both objects rebuild
    await fs.writeFile('/home/user/nj/util.h', '#define GREETING "hi"\nint twice(int);\n');
    r = await sh(shell, 'cd /home/user/nj && ninja && ./app');
    expect(r.out).toMatch(/\[3\/3\] LINK app\nhi 42\n$/);
    await fs.writeFile('/home/user/nj/util.c', 'int twice(int x) { return 2 * x }\n');
    r = await sh(shell, 'cd /home/user/nj && ninja');
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain('FAILED: util.o');
    expect(r.out).toMatch(/util\.c:1:32: error: expected ';' after return statement/);
  }, 300_000);

  it('cmake configures with clang and builds through ninja and make; ctest runs the tests', async () => {
    await fs.mkdir('/home/user/cm', { recursive: true });
    await fs.writeFile('/home/user/cm/CMakeLists.txt', [
      'cmake_minimum_required(VERSION 3.20)', 'project(hello C)', 'include(CheckIncludeFile)',
      'check_include_file(stdint.h HAVE_STDINT_H)', 'configure_file(config.h.in config.h)',
      'add_library(util STATIC util.c)', 'add_executable(app main.c)', 'target_include_directories(app PRIVATE ${CMAKE_CURRENT_BINARY_DIR})',
      'target_link_libraries(app util)', 'enable_testing()', 'add_test(NAME runs COMMAND app)',
      'set_tests_properties(runs PROPERTIES PASS_REGULAR_EXPRESSION "twice 42")', ''].join('\n'));
    await fs.writeFile('/home/user/cm/config.h.in', '#cmakedefine HAVE_STDINT_H 1\n');
    await fs.writeFile('/home/user/cm/util.c', 'int twice(int x) { return 2 * x; }\n');
    await fs.writeFile('/home/user/cm/main.c', '#include <stdio.h>\n#include "config.h"\nint twice(int);\nint main(void) {\n#ifdef HAVE_STDINT_H\n  printf("twice %d\\n", twice(21));\n#endif\n  return 0;\n}\n');
    let r = await sh(shell, 'cd /home/user/cm && cmake -S . -B build -G Ninja -DCMAKE_C_COMPILER=clang');
    expect(r.err).toBe('');
    expect(r.out).toContain('-- The C compiler identification is Clang 21.1.4\n');
    expect(r.out).toContain('-- Looking for stdint.h - found\n');
    expect(r.out).toContain('-- Build files have been written to: /home/user/cm/build\n');
    r = await sh(shell, 'cd /home/user/cm && cmake --build build && ./build/app && cd build && ctest 2>&1 | grep "tests passed"');
    expect(r.err).toBe('');
    expect(r.out).toMatch(/\[4\/4\] Linking C executable app\ntwice 42\n100% tests passed, 0 tests failed out of 1\n$/);
    r = await sh(shell, 'cd /home/user/cm && cmake -S . -B mk -DCMAKE_C_COMPILER=clang > /dev/null && cmake --build mk 2>&1 | tail -1 && ./mk/app');
    expect(r.out).toBe('[100%] Built target app\ntwice 42\n');
  }, 1_800_000);
});

describe('git (upstream, x86-64 in Blink)', () => {
  it('sh -c runs a simple command directly (the words it needs no shell for)', () => {
    expect(simpleCommandWords("git-upload-pack '/home/user/r/.git'")).toEqual(['git-upload-pack', '/home/user/r/.git']);
    expect(simpleCommandWords('exec prog "a b" c')).toEqual(['prog', 'a b', 'c']);
    for (const s of ['a | b', 'a > f', 'echo $HOME', 'a; b', 'ls *.c', 'a && b', "x 'open"]) expect(simpleCommandWords(s)).toBeNull();
  });

  let shell: Shell;
  let fs: FileSystem;
  const g = (cmd: string) => sh(shell, `export GIT_PAGER=cat GIT_EDITOR=true GIT_AUTHOR_DATE=2025-01-01T00:00:00Z GIT_COMMITTER_DATE=2025-01-01T00:00:00Z; ${cmd}`);
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await bootFiles(fs);
    const r = await sh(shell, 'pkg install git');
    expect(r.exitCode).toBe(0);
    await sh(shell, 'git config --global user.name Shiro && git config --global user.email shiro@example.com && git config --global init.defaultBranch main');
  }, 300_000);

  it('replaces the built-in git; commit, branch, merge, rebase, stash', async () => {
    let r = await g('git --version');
    expect(r.out).toBe('git version 2.56.0\n');
    r = await g('mkdir -p /home/user/r && cd /home/user/r && git init -q && printf "a\\nb\\nc\\n" > f.txt && git add . && git commit -qm init && git checkout -qb feat && sed -i s/c/C/ f.txt && git commit -qam feat && git checkout -q main && sed -i s/a/A/ f.txt && git commit -qam main && git merge -q feat -m merge && cat f.txt && git log --oneline --graph | wc -l');
    expect(r.err).toBe('');
    expect(r.out).toBe('Auto-merging f.txt\nA\nb\nC\n6\n');
    r = await g('cd /home/user/r && git checkout -qb topic HEAD~2 && echo z > z.txt && git add z.txt && git commit -qm z && git rebase -q main && git log --format=%s | head -3 && ls -1');
    expect(r.err).toBe('');
    expect(r.out).toBe('z\nmerge\nmain\nf.txt\nz.txt\n');
    r = await g('cd /home/user/r && echo dirty >> f.txt && git stash -q && git status --short && git stash pop -q && git diff --stat');
    expect(r.out).toBe(' f.txt | 1 +\n 1 file changed, 1 insertion(+)\n');
  }, 300_000);


  it('blame, tags, a pre-commit hook, clone and push (upload-pack/receive-pack over pipes)', async () => {
    let r = await g('cd /home/user/r && git checkout -q main && git checkout -q -- . && git tag v1.0 && git describe --tags && git blame -s f.txt | sed "s/^[^ ]* //"');
    expect(r.err).toBe('');
    expect(r.out).toBe('v1.0\n1) A\n2) b\n3) C\n');
    await fs.writeFile('/home/user/r/.git/hooks/pre-commit', '#!/bin/sh\nif git diff --cached | grep -q TODO; then echo "no TODOs" >&2; exit 1; fi\n');
    await fs.chmod?.('/home/user/r/.git/hooks/pre-commit', 0o755);
    r = await g('cd /home/user/r && echo TODO >> f.txt && git commit -qam todo; echo rc=$?; git checkout -q -- f.txt');
    expect(r.err).toContain('no TODOs');
    expect(r.out).toBe('rc=1\n');
    // clone runs `sh -c git-upload-pack ...` and talks to it both ways
    r = await g('cd /tmp && git clone -q file:///home/user/r r2 && cd r2 && git log --oneline | wc -l && echo n > n.txt && git add n.txt && git commit -qm n && git push -q origin HEAD:refs/heads/from-clone && cd /home/user/r && git log --format=%s -1 from-clone');
    expect(r.err).toBe('');
    expect(r.out).toBe('4\nn\n');
  }, 300_000);

  it('clone through a real shell script: --upload-pack that is not a simple command', async () => {
    // `sh -c 'true; git-upload-pack ...'` can't be exec'd directly: the shell
    // runs it as a kernel process and git-upload-pack gets its pipes
    // (src/shell-stdio.ts); before, sh read the request to EOF and deadlocked
    const r = await g(`cd /tmp && git clone -q --upload-pack='true; git-upload-pack' file:///home/user/r r3 && cd r3 && git log --oneline | wc -l && git ls-remote --upload-pack='read_nothing=1; git-upload-pack' origin refs/heads/main | wc -l`);
    expect(r.err).toBe('');
    expect(r.out).toBe('4\n1\n');
  }, 300_000);
});

import { iframeServer } from '@shiro/iframe-server';
import { WsClient } from '@shiro/browser/websocket';

describe('in-tab servers: streamed responses and WebSocket upgrades (what a preview window reaches)', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    const r = await sh(shell, 'mkdir -p /home/user/live && cd /home/user/live && npm init -y > /dev/null && npm install ws@8.18.0 socket.io@4.8.1 > /dev/null; echo $?');
    expect(r.out).toBe('0\n');
  }, 300_000);

  /** Talk RFC 6455 to `port` the way the preview's WebSocket does; resolve after `want` messages */
  const wsTalk = (port: number, path: string, onMessage: (m: string, send: (s: string) => void) => void, want: number) =>
    new Promise<string[]>((resolve, reject) => {
      const got: string[] = [];
      const c: WsClient = new WsClient(iframeServer.connect(port) as any, {
        open: () => onMessage('', (s) => void c.send(s)),
        message: (d) => { got.push(String(d)); onMessage(String(d), (s) => void c.send(s)); if (got.length >= want) { void c.close(); resolve(got); } },
        close: () => resolve(got),
        error: reject,
      });
      c.run(new URL(`ws://localhost:${port}${path}`), [], []).catch(reject);
      setTimeout(() => resolve(got), 10_000);
    });

  it('http.createServer is node-like: statusCode, headers, a streamed request body, bytes out, the request event', async () => {
    await fs.writeFile('/home/user/live/plain.js', `const http = require('http');
const srv = http.createServer();
srv.on('request', (req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const body = Buffer.concat(parts).toString();
    if (req.url === '/bytes') { res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from([0, 255, 1])); return; }
    res.statusCode = 201;
    res.setHeader('x-seen', [req.method, req.headers['x-in']].join(' '));
    res.write('got ');
    res.end(body + ' at ' + req.url + ' ' + res.headersSent);
  });
});
srv.listen(4801, () => console.log('up', srv.address().port, srv.listening));`);
    expect((await sh(shell, 'cd /home/user/live && node plain.js')).out).toContain('up 4801 true');
    const r = await iframeServer.fetch(4801, '/p?q=1', { method: 'POST', headers: { 'x-in': 'hi' }, body: 'payload' });
    expect([r.status, r.headers?.['x-seen'], r.body]).toEqual([201, 'POST hi', 'got payload at /p?q=1 false']);
    const b = await iframeServer.fetch(4801, '/bytes');
    expect(Array.from(b.body as Uint8Array)).toEqual([0, 255, 1]);
  }, 60_000);

  it('server-sent events stream: the head and each write arrive before the response ends', async () => {
    await fs.writeFile('/home/user/live/sse.js', `require('http').createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let n = 0;
  const t = setInterval(() => { res.write('event: tick\\ndata: ' + (++n) + '\\n\\n'); if (n === 3) { clearInterval(t); res.end(); } }, 100);
}).listen(4802);`);
    await sh(shell, 'cd /home/user/live && node sse.js');
    const t0 = Date.now();
    const r = await iframeServer.fetch(4802, '/events');
    expect(r.status).toBe(200);
    expect(r.headers?.['content-type']).toBe('text/event-stream');
    expect(r.body).toBeInstanceOf(ReadableStream);
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    // The first event comes after ~100 ms, not with the end of the response (~300 ms)
    expect(new TextDecoder().decode(first.value)).toBe('event: tick\ndata: 1\n\n');
    expect(Date.now() - t0).toBeLessThan(280);
    let rest = '';
    for (let x = await reader.read(); !x.done; x = await reader.read()) rest += new TextDecoder().decode(x.value);
    expect(rest).toBe('event: tick\ndata: 2\n\nevent: tick\ndata: 3\n\n');
  }, 60_000);

  it('the ws package: an upgrade handler on the http server echoes messages', async () => {
    await fs.writeFile('/home/user/live/ws.js', `const http = require('http'); const { WebSocketServer } = require('ws');
const srv = http.createServer((req, res) => res.end('not a socket'));
const wss = new WebSocketServer({ noServer: true });
srv.on('upgrade', (req, socket, head) => {
  if (req.url !== '/echo') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m, isBinary) => ws.send(isBinary ? 'bin:' + [...m].join(',') : 'echo:' + m)));
});
srv.listen(4803);`);
    await sh(shell, 'cd /home/user/live && node ws.js');
    const got = await wsTalk(4803, '/echo', (m, send) => { if (m === '') { send('a'); send('b'); } }, 2);
    expect(got).toEqual(['echo:a', 'echo:b']);
    // the same port still answers plain requests
    expect((await iframeServer.fetch(4803, '/')).body).toBe('not a socket');
  }, 60_000);

  it('Socket.IO: a WebSocket connection and the polling handshake reach the server; events echo', async () => {
    await fs.writeFile('/home/user/live/sio.js', `const { Server } = require('socket.io');
const io = new Server(4804);
io.on('connection', (s) => s.on('echo', (m) => s.emit('echo', m + '!')));`);
    await sh(shell, 'cd /home/user/live && node sio.js');
    const got = await wsTalk(4804, '/socket.io/?EIO=4&transport=websocket', (m, send) => {
      if (m.startsWith('0{')) send('40');
      else if (m.startsWith('40{')) send('42["echo","hi"]');
    }, 3);
    expect(got[0]).toMatch(/^0\{"sid":/);
    expect(got[1]).toMatch(/^40\{"sid":/);
    expect(got[2]).toBe('42["echo","hi!"]');
    const poll = await iframeServer.fetch(4804, '/socket.io/?EIO=4&transport=polling');
    expect(poll.status).toBe(200);
    expect(String(poll.body)).toMatch(/^0\{"sid":.*"upgrades":\["websocket"\]/);
  }, 60_000);

  it('a kernel listener (net.createServer) takes a raw connection: its own WebSocket handshake and frames', async () => {
    await fs.writeFile('/home/user/live/raw.js', `const net = require('net'); const crypto = require('crypto');
net.createServer((sock) => {
  let buf = Buffer.alloc(0), open = false;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!open) {
      const end = buf.indexOf('\\r\\n\\r\\n');
      if (end < 0) return;
      const key = /sec-websocket-key: *(\\S+)/i.exec(buf.slice(0, end).toString())[1];
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
      buf = buf.slice(end + 4); open = true;
    }
    if (buf.length < 6) return;
    const len = buf[1] & 127, mask = buf.slice(2, 6), text = Buffer.from(buf.slice(6, 6 + len).map((b, i) => b ^ mask[i & 3])).toString();
    buf = buf.slice(6 + len);
    const out = Buffer.from('kernel:' + text);
    sock.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
  });
}).listen(4805, () => console.log('raw up'));`);
    await sh(shell, 'cd /home/user/live && node raw.js');
    expect(await wsTalk(4805, '/', (m, send) => { if (m === '') send('ping'); }, 1)).toEqual(['kernel:ping']);
  }, 60_000);
});

import { buildTree, binDirOf, type PackageMetadata } from '@shiro/commands/npm-tree';
import { initializerPackage } from '@shiro/commands/npm';

describe('npm install: the node_modules tree (npm-tree.ts)', () => {
  /** A registry of name → { version → deps/extra fields } */
  const registry = (spec: Record<string, Record<string, any>>) => async (name: string): Promise<PackageMetadata> => {
    const vs = spec[name];
    if (!vs) throw new Error(`Package '${name}' not found`);
    const versions: Record<string, any> = {};
    for (const [v, extra] of Object.entries(vs)) versions[v] = { name, version: v, dist: { tarball: `https://r/${name}-${v}.tgz` }, ...extra };
    const latest = Object.keys(vs).pop()!;
    return { name, 'dist-tags': { latest, ...(vs.__tags as any ?? {}) }, versions };
  };
  const layout = (nodes: { dir: string; version: string; source: string }[]) =>
    Object.fromEntries(nodes.map((n) => [n.dir, n.source === n.dir.split('node_modules/').pop() ? n.version : `${n.source}@${n.version}`]));

  it('hoists what it can and nests a conflicting version under the package that needs it', async () => {
    const t = await buildTree([{ name: 'a', range: '^1.0.0' }, { name: 'b', range: '^1.0.0' }, { name: 'c', range: '^2.0.0' }], registry({
      a: { '1.0.0': { dependencies: { c: '^1.0.0', d: '^1.0.0' } } },
      b: { '1.0.0': { dependencies: { d: '^1.1.0' } } },
      c: { '1.0.0': {}, '2.0.0': {} },
      d: { '1.0.0': {}, '1.2.0': {} },
    }));
    expect(layout(t.nodes)).toEqual({
      'node_modules/a': '1.0.0', 'node_modules/b': '1.0.0', 'node_modules/c': '2.0.0',
      'node_modules/a/node_modules/c': '1.0.0', 'node_modules/d': '1.2.0',
    });
    expect(binDirOf(t.nodes.find((n) => n.dir === 'node_modules/a/node_modules/c')!)).toBe('node_modules/a/node_modules/.bin');
  });

  it("doesn't hide a version another package already uses", async () => {
    // x@1 is hoisted for p; q's x@2 can't go at the top, and r (under q) already uses the top x@1
    const t = await buildTree([{ name: 'p', range: '1' }, { name: 'q', range: '1' }], registry({
      p: { '1.0.0': { dependencies: { x: '1' } } },
      q: { '1.0.0': { dependencies: { r: '1', s: '1' } } },
      r: { '1.0.0': { dependencies: { x: '1' } } },
      s: { '1.0.0': { dependencies: { x: '2' } } },
      x: { '1.0.0': {}, '2.0.0': {} },
    }));
    const l = layout(t.nodes);
    expect(l['node_modules/x']).toBe('1.0.0');
    expect(l['node_modules/s/node_modules/x']).toBe('2.0.0');
  });

  it('installs peers, leaves out native builds but takes wasm32 ones, and the WebAssembly esbuild and rollup', async () => {
    const t = await buildTree([{ name: 'vite', range: '^5.0.0' }, { name: 'plugin', range: '1' }], registry({
      vite: { '5.4.10': { dependencies: { esbuild: '^0.21.3', rollup: '^4.20.0', lightningcss: '^1.33.0' }, optionalDependencies: { fsevents: '~2.3.3', '@x/binding-linux-x64-gnu': '1', '@x/binding-wasm32-wasi': '1' } } },
      '@x/binding-linux-x64-gnu': { '1.0.0': { os: ['linux'], cpu: ['x64'] } },
      '@x/binding-wasm32-wasi': { '1.0.0': { cpu: ['wasm32'] } },
      'esbuild-wasm': { '0.21.5': { bin: { esbuild: 'bin/esbuild' } } },
      '@rollup/wasm-node': { '4.24.0': { dependencies: { '@types/estree': '1.0.6' }, bin: { rollup: 'dist/bin/rollup' } } },
      '@types/estree': { '1.0.6': {} },
      'lightningcss-wasm': { '1.33.0': {} },
      fsevents: { '2.3.3': { os: ['darwin'] } },
      plugin: { '1.0.0': { peerDependencies: { vite: '^5.0.0', missing: '*' }, peerDependenciesMeta: { missing: { optional: true } } } },
    }));
    expect(layout(t.nodes)).toEqual({
      'node_modules/vite': '5.4.10', 'node_modules/plugin': '1.0.0',
      'node_modules/esbuild': 'esbuild-wasm@0.21.5', 'node_modules/rollup': '@rollup/wasm-node@4.24.0',
      'node_modules/@types/estree': '1.0.6', 'node_modules/@x/binding-wasm32-wasi': '1.0.0',
      'node_modules/lightningcss': 'lightningcss-wasm@1.33.0',
    });
    expect(t.skipped.sort()).toEqual(['@x/binding-linux-x64-gnu@1.0.0', 'fsevents@2.3.3']);
    expect(t.warnings).toEqual([]);
  });

  it('follows npm: aliases and dist-tags; npm create names the create- package', async () => {
    const t = await buildTree([{ name: 'old', range: 'npm:new@^2' }, { name: 'tagged', range: 'next' }], registry({
      new: { '2.1.0': {} },
      tagged: { '1.0.0': {}, '2.0.0-beta.1': {}, __tags: { next: '2.0.0-beta.1' } as any },
    }));
    expect(layout(t.nodes)).toEqual({ 'node_modules/old': 'new@2.1.0', 'node_modules/tagged': '2.0.0-beta.1' });
    expect(['vite@latest', 'vite', '@vue', '@vue@3', '@scope/app@1.2.0'].map(initializerPackage))
      .toEqual(['create-vite@latest', 'create-vite', '@vue/create', '@vue/create@3', '@scope/create-app@1.2.0']);
  });
});

import { transformESModules } from '@shiro/commands/jseval/module-transform';

describe('ES module transform: minified imports, and import text in strings left alone', () => {
  it('rewrites import{a as b}from"x", import t from"y", import i,{s as a}from"z", and keeps template text', () => {
    const src = 'import{createRequire as e}from"node:module";import t from"node:fs";import i,{styleText as a}from"node:util";import"./side.js";'
      + 'const tpl=`import react from \'@vitejs/plugin-react\'\nexport default defineConfig({})`;export{tpl as x,e};export{e as "module.exports"};export default 1;';
    const out = transformESModules(src);
    expect(out).toContain('const {createRequire: e} = __shiro_require("node:module");');
    expect(out).toContain('const t = __shiro_require("node:fs");');
    expect(out).toContain('const i = __shiro_require("node:util"); const {styleText: a} = __shiro_require("node:util");');
    expect(out).toContain('__shiro_require("./side.js");');
    expect(out).toContain("`import react from '@vitejs/plugin-react'\nexport default defineConfig({})`");
    expect(out).toContain('__shiro_module.exports.x = tpl; __shiro_module.exports.e = e;');
    expect(out).toContain('__shiro_module.exports = 1;');
    expect(out).toContain('__shiro_module.exports["module.exports"] = e;');
  });
});

import { liveEsbuildChunk } from '@shiro/commands/jseval/esm-live';

describe('live bindings for code-split chunks: an import named like a member keyword', () => {
  it("keeps `get name() {}` an accessor when `get` is an imported binding (vite 7's config chunk)", () => {
    const src = 'import { __toESM as t, get, set } from "./chunk.js";\n'
      + 'const o = { a: 1, get clients() { return get(1); }, set value(v) { set(v); }, get };\n'
      + 'class C { static get x() { return get; } get y() { return 1; } }\n';
    const out = liveEsbuildChunk(src);
    expect(out).toContain('get clients() { return (0, __shiro_live');
    expect(out).toContain('set value(v) { (0, __shiro_live');
    expect(out).toContain('static get x() { return __shiro_live');
    expect(out).toContain('get y() { return 1; }');
    expect(out).toMatch(/get: __shiro_live\d+\.get \}/);
  });
});
