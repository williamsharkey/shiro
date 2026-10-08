// Files the benchmark loads into Shiro, published by server.mjs under
// /__bench/ (copied into the static dir). x86 programs are built here with
// go/gcc when available and cached in bench/.cache/fixtures.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(BENCH, '..');
const X86_SRC = join(ROOT, 'tests/tests/shiro-vitest/fixtures/x86');
const GH_VERSION = '2.62.0';

function have(cmd) {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

function goBuild(src, out, log) {
  if (existsSync(out)) return true;
  if (!have('go')) return false;
  log?.(`[fixtures] go build ${src}`);
  const dir = dirname(src);
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, src], {
    cwd: dir, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GO111MODULE: 'off', GOFLAGS: '' }, stdio: 'pipe',
  });
  return true;
}

/** Returns { name: absolutePath } of every fixture available, and copies them to `publishDir`. */
export function prepareFixtures({ cacheDir, publishDir, netcache, log, withGh = true }) {
  const fx = join(cacheDir, 'fixtures');
  mkdirSync(fx, { recursive: true });
  mkdirSync(publishDir, { recursive: true });
  const out = {};
  out['kbench.wasm'] = join(BENCH, 'fixtures/kbench.wasm');
  out['cat.wasm'] = join(ROOT, 'tests/tests/shiro-vitest/fixtures/wasi/cat.wasm');
  out['hello-musl'] = join(X86_SRC, 'hello-musl');
  const tries = [
    ['hello-go', () => goBuild(join(X86_SRC, 'hello.go'), join(fx, 'hello-go'), log)],
    ['nethttp', () => goBuild(join(X86_SRC, 'nethttp.go'), join(fx, 'nethttp'), log)],
    ['cpuloop', () => goBuild(join(ROOT, 'vendor/blink/bench/cpuloop.go'), join(fx, 'cpuloop'), log)],
    ['hello-glibc', () => {
      const o = join(fx, 'hello-glibc');
      if (existsSync(o)) return true;
      if (!have('gcc')) return false;
      log?.('[fixtures] gcc -static hello.c');
      execFileSync('gcc', ['-O2', '-static', '-o', o, join(X86_SRC, 'hello.c')], { stdio: 'pipe' });
      return true;
    }],
  ];
  for (const [name, build] of tries) {
    try { if (build()) out[name] = join(fx, name); } catch (e) { log?.(`[fixtures] ${name}: ${String(e.stderr || e.message).slice(0, 300)}`); }
  }
  for (const [name, path] of Object.entries(out)) {
    if (existsSync(path)) copyFileSync(path, join(publishDir, name));
    else delete out[name];
  }
  return out;
}

/** Download the GitHub CLI release binary (59 MB static Go) for the x86 `gh --version` benchmark. */
export async function prepareGh({ cacheDir, publishDir, log }) {
  const fx = join(cacheDir, 'fixtures');
  const bin = join(fx, 'gh');
  if (!existsSync(bin)) {
    const tgz = join(fx, `gh_${GH_VERSION}.tar.gz`);
    const url = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz`;
    log?.(`[fixtures] download ${url}`);
    try {
      execFileSync('curl', ['-sSLf', '--max-time', '600', '-o', tgz, url], { stdio: 'pipe' });
      execFileSync('tar', ['-xzf', tgz, '-C', fx, '--strip-components=2', `gh_${GH_VERSION}_linux_amd64/bin/gh`], { stdio: 'pipe' });
    } catch (e) { log?.(`[fixtures] gh: ${String(e.stderr || e.message).slice(0, 200)}`); return null; }
  }
  copyFileSync(bin, join(publishDir, 'gh'));
  return bin;
}

/** Synthetic trees written inside Shiro by the suites (described here so the numbers are reproducible). */
export const TREE = { files: 10000, dirs: 100, bytes: 200 };
