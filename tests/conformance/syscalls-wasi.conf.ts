/**
 * Syscall conformance for WASM guests: the WebAssembly/wasi-testsuite
 * wasm32-wasip1 tests (prebuilt C, Rust and AssemblyScript modules, fetched
 * by scripts/conformance/fetch.sh into .cache/wasi-testsuite) run as Shiro
 * WASI processes (src/wasi, kernel processes on Worker threads, as on a
 * cross-origin isolated page), the way the suite's wasmtime adapter runs
 * them: the test's args and env only, its `root` directory (a fresh copy)
 * preopened as "/" and nothing else preopened, and the exit code (and
 * stdout, when given) compared. Wasmtime passes all of them on Linux, so all
 * are scored. Results: results/syscalls-wasi.json. WASI_LEGACY=1 runs the old
 * in-page runtime instead (results/syscalls-wasi-legacy.partial.json, not
 * scored).
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { createTestShell } from '../tests/shiro-vitest/helpers';
import { runWasiProgram } from '@shiro/wasi/run-command';
import { setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';

const SUITE = resolve(__dirname, '.cache/wasi-testsuite/tests');
const RESULTS = resolve(__dirname, 'results');
const TIMEOUT = 30_000;
const only = process.env.WASI_ONLY ? process.env.WASI_ONLY.split(',') : null;
/** WASI_LEGACY=1: the old in-page runtime (src/wasi-runtime.ts) instead of kernel processes. */
const legacy = !!process.env.WASI_LEGACY;

type Spec = { args?: string[]; env?: Record<string, string>; root?: string; exit_code?: number; stdout?: string };
type Failure = { name: string; reason?: string; timeout?: boolean };

/** Copy a host directory tree into Shiro's filesystem */
async function copyTree(fs: any, from: string, to: string) {
  await fs.mkdir(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (statSync(src).isDirectory()) await copyTree(fs, src, `${to}/${name}`);
    else await fs.writeFile(`${to}/${name}`, new Uint8Array(readFileSync(src)));
  }
}

describe.skipIf(!existsSync(SUITE))('wasi-testsuite (wasm32-wasip1) as Shiro WASI processes', () => {
  // Node has neither Worker nor JSPI, so without this runWasiProgram would
  // fall back to the legacy runtime: give it Worker threads (the browser's
  // SharedArrayBuffer path) like kernel-wasi.test.ts does.
  let tmp = '';
  beforeAll(async () => {
    if (legacy) return;
    tmp = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'shiro-wasi-conf-'));
    writeFileSync(join(tmp, 'entry.ts'), `
      import { parentPort } from 'node:worker_threads';
      import { guestMain } from ${JSON.stringify(resolve(__dirname, '../../src/wasi/guest-worker.ts'))};
      const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
      parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
      guestMain(port);
    `);
    await build({ entryPoints: [join(tmp, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'guest.mjs'), logLevel: 'error' });
    setGuestWorkerFactory(() => {
      const w = new Worker(join(tmp, 'guest.mjs'));
      return {
        postMessage: (m) => w.postMessage(m),
        terminate: () => w.terminate(),
        onMessage: (cb) => { w.on('message', cb); },
        onError: (cb) => { w.on('error', cb); },
      };
    });
    forceWasmProcessMode('sab');
  }, 120_000);
  afterAll(() => {
    if (legacy) return;
    forceWasmProcessMode(null);
    setGuestWorkerFactory(null);
    rmSync(tmp, { recursive: true, force: true });
  });
  it('runs', async () => {
    const { fs, shell } = await createTestShell();
    let spec: Spec = {};
    let root = '/';
    shell.commands.register({
      name: 'wasi-testsuite-run',
      description: 'conformance harness: run one wasi-testsuite module',
      async exec(ctx: any) {
        const file = ctx.args[0];
        const image = new Uint8Array(await ctx.fs.readFile(file) as Uint8Array);
        const module = await WebAssembly.compile(image);
        const env = { ...(spec.env ?? {}) };
        return runWasiProgram(ctx, {
          // Like the suite's wasmtime adapter: `--dir ROOT::/` only when the test has a root
          module, image, argv: [basename(file), ...(spec.args ?? [])], cwd: root, env,
          mounts: spec.root ? { '/': root } : {}, bare: true,
        });
      },
    } as any);

    const files: Record<string, { pass: number; total: number; failures: Failure[] }> = {};
    for (const lang of readdirSync(SUITE)) {
      const dir = join(SUITE, lang, 'testsuite', 'wasm32-wasip1');
      if (!existsSync(dir)) continue;
      const area = `${lang}`;
      const res = (files[area] ??= { pass: 0, total: 0, failures: [] });
      await copyTree(fs, dir, `/wasi/${lang}`);
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.wasm')).sort()) {
        const name = f.replace(/\.wasm$/, '');
        if (only && !only.includes(name) && !only.includes(lang)) continue;
        const specPath = join(dir, `${name}.json`);
        spec = existsSync(specPath) ? JSON.parse(readFileSync(specPath, 'utf8')) : {};
        // A fresh copy of the test's root directory each time
        root = `/tmp/wasi-run/${lang}-${name}`;
        if (spec.root) await copyTree(fs, join(dir, spec.root), root);
        else await fs.mkdir(root, { recursive: true });
        let out = '';
        let err = '';
        let timedOut = false;
        let timer: any;
        const status = await Promise.race([
          shell.execute(`wasi-testsuite-run /wasi/${lang}/${f}`, (s) => { out += s; }, (s) => { err += s; }, false, undefined, true)
            .catch((e: any) => { err += String(e?.message ?? e); return -1; }),
          new Promise<number>((r) => { timer = setTimeout(() => { timedOut = true; r(-2); }, TIMEOUT); }),
        ]);
        clearTimeout(timer);
        out = out.replace(/\r\n/g, '\n');
        const want = spec.exit_code ?? 0;
        const reasons: string[] = [];
        if (timedOut) reasons.push('timeout');
        else if (status !== want) reasons.push(`exit ${status}, expected ${want}`);
        if (!timedOut && spec.stdout !== undefined && out !== spec.stdout) reasons.push(`stdout ${JSON.stringify(out.slice(0, 80))}`);
        res.total++;
        if (!reasons.length) res.pass++;
        else res.failures.push({ name, reason: (reasons.join('; ') + (err ? ` — ${err.replace(/\s+/g, ' ').trim().slice(0, 400)}` : '')), ...(timedOut ? { timeout: true } : {}) });
      }
    }
    mkdirSync(RESULTS, { recursive: true });
    // (a legacy run isn't scored: it is named like a partial one)
    const outName = legacy ? 'syscalls-wasi-legacy.partial.json' : only ? 'syscalls-wasi.partial.json' : 'syscalls-wasi.json';
    writeFileSync(join(RESULTS, outName), JSON.stringify({
      suite: 'wasi-testsuite',
      title: 'Syscalls: wasi-testsuite (wasm32-wasip1)',
      note: 'WebAssembly/wasi-testsuite prebuilt wasip1 modules (C, Rust, AssemblyScript) run as tabcomputer WASI processes with their root directory preopened as "/", judged like the suite\'s own runner (exit code, stdout when given). Wasmtime passes all of them.',
      files,
    }, null, 1) + '\n');
  }, 1_800_000);
});
