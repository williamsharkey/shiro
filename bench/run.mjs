#!/usr/bin/env node
// Shiro benchmark runner. See bench/README.md.
//   npm run bench                 full run, both modes, writes bench/results/ and docs/BENCHMARKS.md
//   npm run bench -- --quick      key metrics only (~3 min)
//   node bench/run.mjs --suites shell,kernel --modes isolated --runs 7 --no-build
//   node bench/run.mjs --src ../other-checkout ...   measure another tree's build with this harness (bench/ab.mjs)
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness, CHROMIUM } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer, startTcpTestServer, hostAddress } from './lib/servers.mjs';
import { prepareFixtures, prepareGh } from './lib/fixtures.mjs';
import { writeReport } from './report.mjs';
import { machineFor } from './lib/machine.mjs';
import { startGitDaemon } from './lib/gitserver.mjs';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BENCH, '..');
const ALL_SUITES = ['boot', 'shell', 'kernel', 'wasm', 'x86', 'net', 'node', 'hygiene', 'workloads', 'workflows'];
// Only when asked for (--suites debian): apt runs take minutes
const OPTIONAL_SUITES = ['debian', 'x86first', 'workloads-slow', 'toolchains'];
const NONISOLATED_SUITES = ['boot', 'shell', 'kernel', 'wasm', 'x86', 'hygiene'];
// --quick: everything isolated, plus the kernel fallback paths (JSPI) not isolated
const QUICK_NONISOLATED_SUITES = ['kernel'];

function parseArgs(argv) {
  const a = { quick: false, runs: null, build: true, modes: ['isolated', 'nonisolated'], suites: null, only: null, skip: null, offline: false, out: null, docs: null, gh: true, src: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--quick') a.quick = true;
    else if (k === '--runs') a.runs = Number(v());
    else if (k === '--no-build') a.build = false;
    else if (k === '--modes') a.modes = v().split(',');
    else if (k === '--suites') a.suites = v().split(',');
    else if (k === '--only') a.only = v().split(',').map((s) => new RegExp(s));
    else if (k === '--skip') a.skip = v().split(',').map((s) => new RegExp(s));
    else if (k === '--offline') a.offline = true;
    else if (k === '--out') a.out = v();
    else if (k === '--no-docs') a.docs = false;
    else if (k === '--docs') a.docs = true;
    else if (k === '--no-gh') a.gh = false;
    else if (k === '--src') a.src = v();
    else if (k === '-h' || k === '--help') { console.log(readFileSync(join(BENCH, 'README.md'), 'utf8')); process.exit(0); }
    else throw new Error(`unknown option ${k}`);
  }
  a.runs ??= 5;
  if (a.quick) a.gh = false;
  // Partial runs (and other trees' builds) don't overwrite the committed table unless asked
  a.docs ??= !a.suites && !a.only && !a.quick && !a.src;
  return a;
}

/** The tree being measured: this checkout, or --src (its dist/ and git state; the harness is always this one) */
let SRC = ROOT;

function sh(cmd) { try { return execSync(cmd, { cwd: SRC, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }

function environment(args, chromiumVersion) {
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    git: { sha: sh('git rev-parse HEAD'), short: sh('git rev-parse --short HEAD'), branch: sh('git rev-parse --abbrev-ref HEAD'), dirty: !!sh('git status --porcelain -- src server.mjs index.html vite.config.ts') },
    node: process.version,
    chromium: chromiumVersion,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: { model: cpus[0]?.model, count: cpus.length },
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10,
    quick: args.quick,
    runs: args.runs,
  };
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.src) SRC = resolve(args.src);
  const t0 = Date.now();
  const log = (s) => console.log(s);
  const cacheDir = join(BENCH, '.cache');
  const dist = join(SRC, 'dist');
  if (args.build || !existsSync(join(dist, 'index.html'))) {
    log('[bench] vite build');
    execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: SRC, stdio: 'inherit' });
  }
  const publish = join(dist, '__bench');
  const fixtures = prepareFixtures({ cacheDir, publishDir: publish, log });
  const suites = (args.suites || ALL_SUITES).filter((s) => ALL_SUITES.includes(s) || OPTIONAL_SUITES.includes(s));
  if (args.gh && (suites.includes('x86') || suites.includes('x86first'))) {
    const gh = await prepareGh({ cacheDir, publishDir: publish, log });
    if (gh) fixtures.gh = gh;
  }
  log(`[bench] fixtures: ${Object.keys(fixtures).join(' ')}`);

  const hostAddr = hostAddress();
  const tcp = await startTcpTestServer('0.0.0.0');
  // git:// server for workloads-slow's clone over the relay
  const gitd = suites.includes('workloads-slow') ? await startGitDaemon({ cacheDir, log }) : null;
  const netcache = new NetCache(join(cacheDir, 'net'), { offline: args.offline, log });
  const results = [];
  let chromiumVersion = null;
  for (const mode of args.modes) {
    const server = await startShiroServer({
      staticDir: dist, isolated: mode === 'isolated',
      tcpPorts: [...Object.values(tcp.ports), ...(gitd ? [gitd.port] : [])], allowCidrs: hostAddr ? [`${hostAddr}/32`] : [],
      log: process.env.BENCH_SERVER_LOG ? (l) => log(`[server] ${l}`) : null,
    });
    const h = new Harness({
      mode, origin: server.origin, netcache, runs: args.runs, quick: args.quick, log, results,
      testServer: { host: hostAddr, ports: tcp.ports }, hostAddr, only: args.only, skipRe: args.skip,
    });
    h.gitServer = gitd ? { host: hostAddr, port: gitd.port, repo: gitd.repo } : null;
    h.fixtures = fixtures;
    await h.launch();
    chromiumVersion ??= h.browser.version();
    const modeSuites = suites.filter((s) => mode === 'isolated' || (args.quick ? QUICK_NONISOLATED_SUITES : NONISOLATED_SUITES).includes(s));
    log(`\n[bench] ${mode} (${server.origin}) suites: ${modeSuites.join(', ')}`);
    try {
      for (const s of modeSuites) {
        const mod = await import(`./suites/${s}.mjs`);
        const ts = Date.now();
        log(`[bench] ── ${s}`);
        h.suite = s;
        try {
          if (s !== 'boot' && !mod.ownPages) await ensureWorkPage(h);
          await mod.run(h);
        } catch (e) {
          log(`[bench] suite ${s} failed: ${e.stack || e}`);
          h.skip(`${s}.suite`, '', 'suite failed: ' + String(e.message || e).split('\n')[0].slice(0, 200));
          await h.page?.context().close().catch(() => {});
          h.page = null;
        }
        // Fresh page per suite: one suite's leaks (Workers, wasm memories) must not fail the next
        await h.page?.context().close().catch(() => {});
        h.page = null;
        log(`[bench] ── ${s} done in ${((Date.now() - ts) / 1000).toFixed(1)} s`);
      }
    } finally {
      await h.close();
      await server.close();
    }
  }
  await tcp.close();
  await gitd?.close();

  const env = environment(args, chromiumVersion);
  env.machine = machineFor(env);
  env.durationSec = Math.round((Date.now() - t0) / 1000);
  env.netcache = netcache.stats;
  const out = { format: 1, env, results };
  mkdirSync(join(BENCH, 'results'), { recursive: true });
  const file = args.out || join(BENCH, 'results', `${env.date.slice(0, 10)}-${env.git.short}${args.quick ? '-quick' : ''}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  log(`\n[bench] wrote ${relative(ROOT, file)} (${results.length} metrics, ${env.durationSec} s)`);
  if (args.docs) {
    writeReport(out, join(ROOT, 'docs/BENCHMARKS.md'), relative(ROOT, file));
    log('[bench] regenerated docs/BENCHMARKS.md');
  }
}

/** A booted page for the non-boot suites: fresh context, settled (background install done). */
async function ensureWorkPage(h) {
  if (h.page && !h.page.isClosed()) return;
  const t0 = Date.now();
  await h.boot({ waitSettled: true });
  h.log(`[bench] work page booted and settled in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
