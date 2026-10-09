#!/usr/bin/env node
// Debian scoreboard (docs/DEBIAN_SCORE.md): install popcon's most-installed
// packages with apt inside Shiro (headless Chromium, the built app, Debian
// mode) and smoke-test each one.
//
//   npm run build && npm run debian-score -- --top 100 [--workers 3] [--only a,b] [--rescore] [--report-only]
//
// Results are cached per package and version in .debian-build/score/results.json,
// so a rerun only does what is new or asked for; .debs and indexes are cached
// by the mirror (SHIRO_DEBIAN_CACHE=.debian-build/mirror-cache). Uses the
// pre-installed Chromium (/opt/pw-browsers/chromium); never `playwright install`.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);
const TOP = Number(opt('--top', '100'));
const WORKERS = Number(opt('--workers', '2'));
const ONLY = opt('--only', '') ? opt('--only', '').split(',') : null;
const PORT = Number(opt('--port', '5397'));
const INSTALL_TIMEOUT_S = Number(opt('--timeout', '1200'));
// --tag NAME: a variant run (its own results and report), e.g. with --env
// BLINK_SAME_INSTANCE_FORK=1 (extra environment for every command, comma-separated)
const TAG = opt('--tag', '');
const EXTRA_ENV = Object.fromEntries(opt('--env', '').split(',').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
const OUT_DIR = join(ROOT, '.debian-build/score' + (TAG ? '-' + TAG : ''));
const RESULTS = join(OUT_DIR, 'results.json');
const REPORT = TAG ? join(OUT_DIR, 'DEBIAN_SCORE.md') : join(ROOT, 'docs/DEBIAN_SCORE.md');
mkdirSync(OUT_DIR, { recursive: true });

const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
const save = () => writeFileSync(RESULTS, JSON.stringify(results, null, 1));

// ── The popcon snapshot ──────────────────────────────────────────────────
const popcon = readFileSync(join(ROOT, 'scripts/debian/popcon-top1000.txt'), 'utf8').split('\n')
  .filter((l) => l && !l.startsWith('#')).map((l) => { const [rank, name, inst] = l.split(/\s+/); return { rank: +rank, name, inst: +inst }; });
const wanted = (ONLY ? popcon.filter((p) => ONLY.includes(p.name)) : popcon.slice(0, TOP));

// ── Failure categories (first match wins) ────────────────────────────────
const CATEGORIES = [
  ['blink-lchown', /error setting ownership of symlink/],
  ['not-in-trixie', /Unable to locate package|has no installation candidate|is not available, but is referred to/],
  ['timeout', /^SCORE-TIMEOUT/m],
  ['engine-crash', /terminating due to SIG|Segmentation fault|Illegal instruction|Bus error|core dumped|returned error exit status 1[34]\d\b|SIGSEGV|SIGILL|SIGBUS/],
  ['missing-syscall', /Function not implemented|ENOSYS|missing syscall|Operation not supported/],
  ['download', /Failed to fetch|Hash Sum mismatch|Could not connect to the package mirror/],
  ['dependencies', /unmet dependencies|Unable to correct problems|held broken packages/],
  ['maintainer-script', /installed (?:\S+ )?(?:package )?(?:post-installation|pre-installation|pre-removal|post-removal) script subprocess returned error|subprocess .* returned error exit status/],
  ['dpkg', /dpkg: error|E: Sub-process \/usr\/bin\/dpkg returned an error/],
];
function categorize(text) {
  for (const [cat, re] of CATEGORIES) if (re.test(text)) return cat;
  return 'other';
}
const firstError = (text) => (text.split('\n').find((l) => /^ (error|unable|cannot|trying to overwrite)/.test(l))?.trim() || text.split('\n').find((l) => /^(E:|dpkg: error|.*(error|Error|ERROR|failed|not found|No such file))/.test(l)) || text.trim().split('\n').pop() || '').slice(0, 160);

// ── Archive facts: which popcon names exist in trixie amd64 ─────────────
async function archivePackages(base) {
  const names = new Map();
  for (const suite of ['trixie', 'trixie-updates']) {
    const r = await fetch(`${base}/debian/mirror/deb.debian.org/debian/dists/${suite}/main/binary-amd64/Packages.xz`);
    if (!r.ok) continue;
    const text = execFileSync('xz', ['-dc'], { input: Buffer.from(await r.arrayBuffer()), maxBuffer: 1 << 30 }).toString();
    for (const st of text.split('\n\n')) {
      const p = /^Package: (.+)$/m.exec(st)?.[1];
      if (p) names.set(p, { version: /^Version: (.+)$/m.exec(st)?.[1], section: /^Section: (.+)$/m.exec(st)?.[1] ?? '' });
    }
  }
  return names;
}

// ── The app ──────────────────────────────────────────────────────────────
function startServer() {
  if (!existsSync(join(ROOT, 'dist/index.html'))) {
    console.log('building the app (npm run build) ...');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  }
  const srv = spawn('node', ['server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), STATIC_DIR: join(ROOT, 'dist'), SHIRO_DEBIAN_CACHE: process.env.SHIRO_DEBIAN_CACHE || join(ROOT, '.debian-build/mirror-cache') },
  });
  return srv;
}

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${url} did not come up`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

/** One Shiro page in Debian mode with fresh storage. */
async function newMachine(browser, base, log) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  await page.goto(base + '/');
  await page.waitForFunction(() => window.__shiro && window.__shiro.shell, null, { timeout: 120000 });
  const run = async (cmd, timeoutS = 600) => page.evaluate(async ({ cmd, timeoutS, extraEnv }) => {
    let out = '';
    const t0 = performance.now();
    // A root shell (as `sudo -s` gives): kernel programs' output streams into
    // `out`, so a command that times out still leaves its log (sudo, a
    // builtin, hands its output over only when it returns)
    const sh = window.__scoreShell ??= (() => {
      const f = Object.assign(window.__shiro.shell.fork(), { terminal: null, uid: 0 });
      Object.assign(f.env, { USER: 'root', LOGNAME: 'root', HOME: '/root', DEBIAN_FRONTEND: 'noninteractive' }, extraEnv);
      return f;
    })();
    let timer;
    const timedOut = new Promise((r) => { timer = setTimeout(() => r('timeout'), timeoutS * 1000); });
    const code = await Promise.race([sh.execute(cmd, (s) => { out += s; }, (s) => { out += s; }), timedOut]);
    clearTimeout(timer);
    if (code === 'timeout') { sh.abortController?.abort(); out += '\nSCORE-TIMEOUT\n'; }
    return { code: code === 'timeout' ? 124 : code, out: out.replace(/\r\n/g, '\n'), ms: Math.round(performance.now() - t0) };
  }, { cmd, timeoutS, extraEnv: EXTRA_ENV });
  const t0 = Date.now();
  const inst = await run('debian install');
  if (inst.code) throw new Error('debian install failed: ' + inst.out);
  const upd = await run('apt-get update', 1800);
  log(`machine ready: install ${inst.ms} ms, apt-get update ${upd.ms} ms (exit ${upd.code})`);
  if (upd.code) throw new Error('apt-get update failed: ' + upd.out.slice(-2000));
  return { context, page, run, bootMs: Date.now() - t0, updateMs: upd.ms };
}

/** Smoke-test an installed package: its programs, libraries, modules. */
async function smoke(m, pkg) {
  const list = (await m.run(`dpkg -L ${pkg} 2>/dev/null`)).out.split('\n').filter(Boolean);
  const diverted = (await m.run(`dpkg-divert --list 2>/dev/null`)).out;
  const bins = list.filter((f) => /^\/(?:usr\/)?s?bin\/[^/]+$/.test(f) && !diverted.includes(`of ${f} `));
  // The program named like the package first, then the rest
  bins.sort((a, b) => (b.endsWith('/' + pkg) ? 1 : 0) - (a.endsWith('/' + pkg) ? 1 : 0));
  const tried = [];
  // Shells have no --version (dash): run a command instead
  const shell = bins.find((b) => /\/(?:da|ba|z|k|mk|c|tc|fi)?sh$/.test(b));
  if (shell) {
    const r = await m.run(`timeout 120 ${shell} -c 'echo smoke-ok' </dev/null 2>&1`, 180);
    if (r.code === 0 && r.out.includes('smoke-ok')) return { ok: true, how: `${shell} -c 'echo smoke-ok'`, ms: r.ms };
  }
  for (const bin of bins.slice(0, 3)) {
    for (const flagArg of ['--version', '--help', '-V', '-h']) {
      const r = await m.run(`timeout 120 ${bin} ${flagArg} </dev/null 2>&1`, 180);
      const crashed = /terminating due to SIG|Segmentation fault|Illegal instruction|SCORE-TIMEOUT/.test(r.out) || r.code >= 128 || r.code === 124;
      tried.push(`${bin} ${flagArg}: exit ${r.code}`);
      if (r.code === 0 && r.out.trim()) return { ok: true, how: `${bin} ${flagArg}`, ms: r.ms, sample: r.out.trim().split('\n')[0].slice(0, 100) };
      // Tools without --version print their usage and exit 1 or 2: it ran, which is what we check
      const broken = /error while loading shared libraries|Exec format error|cannot execute|not found|Can't locate|No such file/i.test(r.out);
      if (r.code > 0 && r.code < 126 && !broken && /usage|version|options|--help/i.test(r.out)) return { ok: true, how: `${bin} ${flagArg} (usage, exit ${r.code})`, ms: r.ms, sample: r.out.trim().split('\n')[0].slice(0, 100) };
      if (crashed) return { ok: false, how: `${bin} ${flagArg}`, category: r.code === 124 ? 'timeout' : 'engine-crash', error: firstError(r.out) || `exit ${r.code}` };
    }
  }
  if (bins.length) return { ok: false, how: tried.join('; '), category: 'smoke-failed', error: tried[0] };
  const libs = list.filter((f) => /^\/usr\/lib\/x86_64-linux-gnu\/(?:[\w.+-]+\/)?[^/]+\.so(\.\d+)*$/.test(f));
  if (libs.length) {
    const r = await m.run(`/lib64/ld-linux-x86-64.so.2 --list ${libs[0]} 2>&1`, 180);
    return r.code === 0 ? { ok: true, how: `ld.so --list ${libs[0]}`, ms: r.ms }
      : { ok: false, how: `ld.so --list ${libs[0]}`, category: categorize(r.out) === 'other' ? 'smoke-failed' : categorize(r.out), error: firstError(r.out) };
  }
  const py = list.map((f) => /^\/usr\/lib\/python3\/dist-packages\/([A-Za-z_][\w]*)(?:\/__init__\.py|\.py)$/.exec(f)?.[1]).find(Boolean);
  if (py) {
    const r = await m.run(`python3 -c 'import ${py}' 2>&1`, 300);
    return r.code === 0 ? { ok: true, how: `python3 -c 'import ${py}'`, ms: r.ms } : { ok: false, how: `import ${py}`, category: 'smoke-failed', error: firstError(r.out) };
  }
  const pm = list.map((f) => /^\/usr\/share\/perl5\/(.+)\.pm$/.exec(f)?.[1]).find(Boolean);
  if (pm) {
    const mod = pm.replace(/\//g, '::');
    const r = await m.run(`perl -e 'use ${mod}' 2>&1`, 300);
    return r.code === 0 ? { ok: true, how: `perl -e 'use ${mod}'`, ms: r.ms } : { ok: false, how: `use ${mod}`, category: 'smoke-failed', error: firstError(r.out) };
  }
  return { ok: true, how: 'installed (data/config only)', ms: 0 };
}

const installedStatus = async (m, names) => {
  const out = (await m.run(`dpkg-query -W -f='\${Package} \${Status}\\n' ${names.join(' ')} 2>/dev/null`)).out;
  const ok = new Set();
  for (const l of out.split('\n')) { const [n, ...st] = l.trim().split(' '); if (st.join(' ') === 'install ok installed') ok.add(n.replace(/:.*$/, '')); }
  return ok;
};

/**
 * Install a batch with one apt run (most of the cost is apt loading its cache
 * and dpkg reading its database); a failed batch is retried one package at a
 * time so each failure lands on the right package. Then smoke each.
 */
/**
 * After a failed install: purge what dpkg left half-installed or unconfigured
 * (its failure is recorded already), so the next package starts from a
 * consistent system instead of failing on "Unmet dependencies".
 */
async function recover(m) {
  const out = (await m.run(`dpkg-query -W -f='\${Package} \${db:Status-Abbrev}\\n' 2>/dev/null`)).out;
  const bad = out.split('\n').map((l) => l.trim().split(/\s+/)).filter(([n, st]) => n && st && /^[a-z][UHF]/.test(st)) /* unpacked, half-installed, half-configured; not trigger-pending (it, iW) */.map(([n]) => n);
  if (bad.length) await m.run(`dpkg --purge --force-all ${bad.join(' ')} 2>&1`, 600);
  return bad;
}

async function scoreBatch(m, batch, onResult) {
  const names = batch.map((b) => b.p.name);
  const before = await installedStatus(m, names);
  const todo = batch.filter((b) => !before.has(b.p.name));
  const logs = new Map();
  const timing = new Map();
  if (todo.length) {
    const r = await m.run(`apt-get install -y ${todo.map((b) => b.p.name).join(' ')} 2>&1`, INSTALL_TIMEOUT_S);
    writeFileSync(join(OUT_DIR, `batch-${todo[0].p.name}.log`), `exit ${r.code} after ${r.ms} ms\n` + r.out);
    for (const b of todo) { logs.set(b.p.name, r.out); timing.set(b.p.name, Math.round(r.ms / todo.length)); }
    if (r.code !== 0 && todo.length > 1) {
      await recover(m);
      for (const b of todo) {
        if ((await installedStatus(m, [b.p.name])).has(b.p.name)) continue;
        const one = await m.run(`apt-get install -y ${b.p.name} 2>&1`, INSTALL_TIMEOUT_S);
        logs.set(b.p.name, one.out); timing.set(b.p.name, one.ms);
        if (one.code !== 0) await recover(m);
      }
    }
  }
  const after = await installedStatus(m, names);
  // A shell that answers nothing (a hung command killed by the timeout) can't score anything
  if (!(await installedStatus(m, ['dpkg'])).has('dpkg')) throw new Error('the machine stopped answering (dpkg-query sees no dpkg)');
  let broken = false;
  for (const { p, info } of batch) {
    const t0 = Date.now();
    const r = { name: p.name, rank: p.rank, version: info?.version, installMs: timing.get(p.name) ?? 0, already: before.has(p.name), at: new Date().toISOString() };
    if (!after.has(p.name)) {
      const log = logs.get(p.name) ?? '';
      Object.assign(r, { result: 'fail', stage: 'install', category: categorize(log), error: firstError(log) });
      writeFileSync(join(OUT_DIR, `${p.name}.log`), log);
      broken = true;
    } else {
      const sm = await smoke(m, p.name);
      Object.assign(r, { result: sm.ok ? 'pass' : 'fail', stage: 'smoke', smoke: sm.how, smokeMs: sm.ms, sample: sm.sample });
      if (!sm.ok) Object.assign(r, { category: sm.category, error: sm.error });
    }
    r.totalMs = Date.now() - t0 + r.installMs;
    onResult(r);
  }
  return broken;
}

async function main() {
  if (flag('--report-only')) return report();
  const srv = startServer();
  const base = `http://localhost:${PORT}`;
  try {
    await waitFor(base + '/health');
    const archive = await archivePackages(base);
    console.log(`archive: ${archive.size} packages in trixie + trixie-updates amd64`);
    const queue = [];
    for (const p of wanted) {
      const info = archive.get(p.name);
      if (!info) { results[p.name] = { name: p.name, rank: p.rank, result: 'skip', category: 'not-in-trixie', error: 'no such binary package in trixie amd64 (popcon counts every release and architecture)' }; continue; }
      const prev = results[p.name];
      if (prev && prev.version === info.version && prev.result !== 'error' && !flag('--rescore')) continue;
      queue.push({ p, info });
    }
    save();
    console.log(`${queue.length} packages to score with ${WORKERS} workers`);
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--js-flags=--max-old-space-size=8192'] });
    const BATCH = Number(opt('--batch', '8'));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, async (_, w) => {
      const log = (s) => console.log(`[w${w}] ${s}`);
      let m = null;
      while (next < queue.length) {
        const batch = queue.slice(next, next + BATCH);
        next += batch.length;
        try {
          // A dpkg left half-configured by an earlier failure fails everything after it
          if (m && (await m.run('dpkg --audit 2>&1')).out.trim()) {
            log('dpkg --audit reports problems; new machine');
            await m.context.close().catch(() => {});
            m = null;
          }
          m ??= await newMachine(browser, base, log);
          const broken = await scoreBatch(m, batch, (r) => {
            results[r.name] = r;
            save();
            log(`#${r.rank} ${r.name}: ${r.result}${r.category ? ` [${r.category}] ${r.error ?? ''}` : ` (${r.smoke})`} ${Math.round(r.totalMs / 1000)}s`);
          });
          // A dpkg that can't recover would fail everything after it: start over
          if (broken) await recover(m);
        } catch (e) {
          for (const { p, info } of batch) {
            if (results[p.name]?.at && results[p.name].version === info.version && results[p.name].result !== 'error') continue;
            results[p.name] = { name: p.name, rank: p.rank, version: info.version, result: 'error', category: 'harness', error: String(e?.message ?? e).slice(0, 300) };
          }
          save();
          log(`batch ${batch[0].p.name}..: harness error ${e?.message ?? e}`);
          if (m) await m.context.close().catch(() => {});
          m = null;
        }
      }
      if (m) await m.context.close().catch(() => {});
    }));
    await browser.close();
  } finally {
    srv.kill();
  }
  report();
}

function report() {
  const rows = popcon.filter((p) => results[p.name]).map((p) => results[p.name]);
  const scored = rows.filter((r) => r.result === 'pass' || r.result === 'fail');
  const pass = rows.filter((r) => r.result === 'pass');
  const byCat = {};
  for (const r of rows) if (r.result !== 'pass') byCat[r.category ?? 'other'] = (byCat[r.category ?? 'other'] ?? 0) + 1;
  const ranks = rows.map((r) => r.rank);
  const lines = [
    '# Debian scoreboard',
    '',
    'Debian 13 "trixie" amd64 packages, by [popcon](https://popcon.debian.org/) install count',
    '(snapshot `scripts/debian/popcon-top1000.txt`), installed with `apt-get install -y` as root (a root shell, as `sudo -s` gives) inside',
    'Shiro (headless Chromium, the built app, `debian install`) and smoke-tested: the package\'s',
    'programs with `--version`/`--help`, otherwise its first shared library loaded by `ld.so --list`,',
    'a Python or Perl module import, or nothing for data-only packages. Generated by',
    '`npm run debian-score` (scripts/debian/score.mjs); see [DEBIAN.md](DEBIAN.md).',
    '',
    `Scored: popcon ranks ${Math.min(...ranks)}–${Math.max(...ranks)}: **${pass.length} pass**, ${scored.length - pass.length} fail, ${rows.length - scored.length} skipped or harness errors (of ${rows.length}). Pass rate of scored packages: ${scored.length ? Math.round((100 * pass.length) / scored.length) : 0}%.`,
    '',
    '## Failure causes',
    '',
    '| Category | Packages | Meaning |',
    '| --- | --- | --- |',
    ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `| ${c} | ${n} | ${CAT_MEANING[c] ?? ''} |`),
    '',
    '## Packages',
    '',
    '| # | Package | Version | Result | How / failure | Install |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.rank} | ${r.name} | ${r.version ?? ''} | ${r.result === 'pass' ? 'pass' : r.result === 'skip' ? 'skip' : `**${r.result}**`}${r.category ? ` (${r.category})` : ''} | ${(r.result === 'pass' ? r.smoke : r.error ?? '').replace(/\|/g, '\\|').replace(/`/g, "'")} | ${r.installMs ? `${(r.installMs / 1000).toFixed(0)} s${r.already ? ' (base)' : ''}` : ''} |`),
    '',
  ];
  writeFileSync(REPORT, lines.join('\n'));
  console.log(`wrote ${REPORT}: ${pass.length} pass / ${scored.length} scored / ${rows.length} total`);
}

const CAT_MEANING = {
  'blink-lchown': "Blink's lchown follows symlinks, so dpkg can't set the owner of a symlink whose target isn't unpacked yet (reported to unix/perf-blink)",
  'not-in-trixie': 'popcon counts every release and architecture; no such amd64 package in trixie',
  'engine-crash': 'a program died of a signal in Blink (an unimplemented instruction or an emulation bug)',
  'missing-syscall': 'a system call Shiro or Blink does not implement',
  'maintainer-script': "a package's postinst/preinst failed",
  'dpkg': 'dpkg failed for another reason',
  dependencies: 'apt could not resolve dependencies',
  download: 'fetching from the mirror failed',
  timeout: 'install or smoke test exceeded its time limit',
  'smoke-failed': 'installed, but the smoke test failed',
  harness: 'the scoring harness itself failed (page crash, boot timeout)',
  other: 'unclassified; see the error column',
};

main().catch((e) => { console.error(e); process.exit(1); });
