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
