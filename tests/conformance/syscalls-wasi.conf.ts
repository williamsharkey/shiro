/**
 * Syscall conformance for WASM guests: the WebAssembly/wasi-testsuite
 * wasm32-wasip1 tests (prebuilt C, Rust and AssemblyScript modules, fetched
 * by scripts/conformance/fetch.sh into .cache/wasi-testsuite) run as Shiro
 * WASI processes (src/wasi, through the kernel), the way the suite's
 * wasmtime adapter runs them: the test's args and env only, its `root`
 * directory (a fresh copy) preopened as "/", and the exit code (and stdout,
 * when given) compared. Wasmtime passes all of them on Linux, so all are
 * scored. Results: results/syscalls-wasi.json.
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createTestShell } from '../tests/shiro-vitest/helpers';
import { runWasiProgram } from '@shiro/wasi/run-command';

const SUITE = resolve(__dirname, '.cache/wasi-testsuite/tests');
const RESULTS = resolve(__dirname, 'results');
const TIMEOUT = 30_000;
const only = process.env.WASI_ONLY ? process.env.WASI_ONLY.split(',') : null;

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
          module, image, argv: [basename(file), ...(spec.args ?? [])], cwd: root, env, mounts: { '/': root },
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
    const outName = only ? 'syscalls-wasi.partial.json' : 'syscalls-wasi.json';
    writeFileSync(join(RESULTS, outName), JSON.stringify({
      suite: 'wasi-testsuite',
      title: 'Syscalls: wasi-testsuite (wasm32-wasip1)',
      note: 'WebAssembly/wasi-testsuite prebuilt wasip1 modules (C, Rust, AssemblyScript) run as Shiro WASI processes with their root directory preopened as "/", judged like the suite\'s own runner (exit code, stdout when given). Wasmtime passes all of them.',
      files,
    }, null, 1) + '\n');
  }, 1_800_000);
});
