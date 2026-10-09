#!/usr/bin/env node
// Storage reliability check (not part of the benchmark suites; takes minutes):
//
//   node bench/crash-check.mjs [--only footprint,apt-crash,write-crash,quota] [--crash-at 4,12,25] [--pkgs jq,tree,bc]
//
// 1. Footprint: `debian install` from a fresh profile, then apt update and a
//    few installs: network bytes, time, navigator.storage usage after each.
// 2. Crash safety: kill the renderer (CDP Page.crash) partway through
//    `apt-get install` and through a large file write, boot again in the same
//    profile, and check the filesystem and dpkg's state (dpkg --audit,
//    dpkg --configure -a, apt-get check, then the install again).
// 3. Quota: a profile on a small disk (--small-dir), written until full: the
//    write fails with ENOSPC, the files written before stay intact across a
//    reload, and deleting frees it.
//
// Serves dist/ (npm run build first); apt's mirror is cached on disk.
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { Harness, CHROMIUM } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer, startTcpTestServer, hostAddress } from './lib/servers.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const only = opt('--only', 'footprint,apt-crash,write-crash,quota').split(',');
const crashAt = opt('--crash-at', '4,12,25').split(',').map(Number);
const PKGS = opt('--pkgs', 'jq,tree,bc').split(',');

const tcp = await startTcpTestServer();
const server = await startShiroServer({ staticDir: join(process.cwd(), 'dist'), isolated: true, tcpPorts: Object.values(tcp.ports), allowCidrs: [hostAddress() + '/32'] });
const h = new Harness({ mode: 'isolated', origin: server.origin, netcache: new NetCache('bench/.cache/net', {}), runs: 1, log: console.log, results: [] });
await h.launch();

const log = (m) => { if (process.env.CRASH_DEBUG) console.log(`  · ${m}`); };
const MiB = (n) => (n / 1048576).toFixed(1);
const results = [];
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function sh(cmd, ms = 1800000) {
  const r = await h.eval(([c, l]) => window.__bench.shLimit(c, l), [cmd, ms]);
  return { ...r, text: (r.out + r.err).trim() };
}
async function usage() { return h.eval(() => navigator.storage.estimate().then((e) => e.usage ?? 0)); }
async function step(label, cmd) {
  const b0 = h.net.bytes;
  const r = await sh(cmd);
  const u = await usage();
  results.push({ step: label, s: +(r.ms / 1000).toFixed(1), fetchedMiB: +MiB(h.net.bytes - b0), storageMiB: +MiB(u), code: r.code });
  console.log(`STEP ${label}: ${(r.ms / 1000).toFixed(1)} s, exit ${r.code}, fetched ${MiB(h.net.bytes - b0)} MiB, storage ${MiB(u)} MiB`);
  if (r.code !== 0) console.log(r.text.split('\n').slice(-8).map((l) => '    ' + l).join('\n'));
  return r;
}

/** Kill the renderer `afterMs` into `cmd`, then boot a new page in the same profile. */
async function crashDuring(cmd, afterMs) {
  const page = h.page, context = h.context;
  const running = h.eval(([c]) => window.__bench.shLimit(c, 1800000), [cmd]).catch((e) => ({ crashed: String(e).slice(0, 80) }));
  await page.waitForTimeout(afterMs);
  const pending = await h.eval(() => window.__tabcomputer?.fs?.pendingWrites ?? null).catch(() => null);
  log(`crashing ${afterMs} ms into ${cmd}`);
  const crashed = new Promise((r) => page.once('crash', r));
  void h.cdp.send('Page.crash').catch(() => {});
  await Promise.race([crashed, page.waitForTimeout(10000)]);
  const r = await Promise.race([running, new Promise((res) => setTimeout(() => res({ crashed: 'no answer' }), 5000))]);
  console.log(`  crashed ${afterMs} ms into \`${cmd}\` (${r.crashed ? 'mid-run' : `already done, exit ${r.code}`}; ${pending ?? '?'} writes pending)`);
  await Promise.race([page.close().catch(() => {}), new Promise((res) => setTimeout(res, 5000))]);
  log('booting again');
  await h.boot({ context });
  return !r.crashed;
}

const fresh = await h.boot({});
console.log(`boot: ${MiB(fresh.netBytes)} MiB fetched, storage ${MiB(await usage())} MiB`);

// ── 1. footprint ──────────────────────────────────────────────────────────
await step('debian install', 'debian install');
await step('first bash', '/usr/bin/bash -c true');
if (only.includes('footprint') || only.includes('apt-crash')) await step('apt-get update', 'sudo apt-get update');
if (only.includes('footprint')) {
  for (const p of PKGS.slice(1)) await step(`apt-get install ${p}`, `sudo apt-get install -y ${p}`);
}

// ── 2. crash safety ───────────────────────────────────────────────────────
async function dpkgConsistent(label) {
  const audit = await sh('dpkg --audit; echo "audit-exit=$?"');
  const clean = /audit-exit=0/.test(audit.text) && !/not (fully )?installed|half|unpacked/i.test(audit.text.replace(/audit-exit=\d+/, ''));
  console.log(`  dpkg --audit after ${label}: ${clean ? 'clean' : audit.text.split('\n').slice(0, 6).join(' | ')}`);
  if (!clean) {
    const conf = await sh('sudo dpkg --configure -a; echo "configure-exit=$?"');
    console.log(`  dpkg --configure -a: ${conf.text.split('\n').slice(-3).join(' | ')}`);
    const again = await sh('dpkg --audit; echo "audit-exit=$?"');
    check(/audit-exit=0/.test(again.text) && again.text.replace(/audit-exit=\d+/, '').trim() === '', `${label}: dpkg --configure -a recovers (audit clean)`);
  } else check(true, `${label}: dpkg --audit clean`);
  const chk = await sh('sudo apt-get check 2>&1; echo "check-exit=$?"');
  if (!/check-exit=0/.test(chk.text)) {
    const fix = await sh('sudo apt-get install -f -y 2>&1 | tail -3; echo "fix-exit=$?"');
    console.log(`  apt-get install -f: ${fix.text.split('\n').slice(-2).join(' | ')}`);
  }
  const chk2 = await sh('sudo apt-get check 2>&1; echo "check-exit=$?"');
  check(/check-exit=0/.test(chk2.text), `${label}: apt-get check`);
}

if (only.includes('apt-crash')) {
  const pkg = PKGS[0];
  for (const ms of crashAt) {
    await sh(`sudo dpkg --purge ${pkg} >/dev/null 2>&1; true`);
    const finished = await crashDuring(`sudo apt-get install -y ${pkg}`, ms * 1000);
    await dpkgConsistent(`crash ${ms}s into apt-get install ${pkg}${finished ? ' (finished first)' : ''}`);
    const re = await sh(`sudo apt-get install -y ${pkg} >/dev/null 2>&1; ${pkg} --version 2>&1 | head -1; echo "exit=$?"`);
    check(/exit=0/.test(re.text) && !/not found/i.test(re.text), `reinstall ${pkg} after the crash: ${re.text.split('\n')[0]}`);
  }
}

// a large write: a synced file stays intact, the big one is whole or absent/prefix
if (only.includes('write-crash')) {
await sh('mkdir -p /tmp/cc && printf keep > /tmp/cc/keep && sync');
await crashDuring('head -c 200000000 /dev/zero > /tmp/cc/big; echo done', 1500);
const big = await sh('cat /tmp/cc/keep; echo; wc -c < /tmp/cc/big 2>/dev/null || echo absent; ls /tmp/cc');
console.log(`  after crash in a 200 MB write: ${big.text.replace(/\n/g, ' | ')}`);
check(big.text.startsWith('keep'), 'synced file survives a crash during a large write');
const w = await sh('echo after > /tmp/cc/after && cat /tmp/cc/after && rm -f /tmp/cc/big && sync && echo synced');
check(/after\s+synced/.test(w.text), 'filesystem writable after the crash');
}

// ── 3. quota ──────────────────────────────────────────────────────────────
// Chromium doesn't enforce Storage.overrideQuotaForOrigin on IndexedDB, so
// this needs a real small disk: a persistent profile on a small tmpfs, whose
// quota is 60% of it (`mount -t tmpfs -o size=120m tmpfs /tmp/small`).
if (only.includes('quota')) {
  const dir = opt('--small-dir', null);
  if (!dir) console.log('quota: skipped (needs --small-dir on a small tmpfs, see the comment)');
  else {
    rmSync(join(dir, 'profile'), { recursive: true, force: true });
    const ctx = await chromium.launchPersistentContext(join(dir, 'profile'), { executablePath: CHROMIUM, args: ['--no-sandbox'] });
    await ctx.addInitScript(readFileSync('bench/lib/inpage.js', 'utf8'));
    const open = async () => {
      const page = await ctx.newPage();
      await page.goto(server.origin + '/');
      await page.waitForFunction(() => window.__bench?.marks.firstPrompt, null, { timeout: 120000 });
      return page;
    };
    let page = await open();
    const psh = async (c) => { const r = await page.evaluate(([c]) => window.__bench.shLimit(c, 600000), [c]); return (r.out + r.err).trim(); };
    const est = () => page.evaluate(() => navigator.storage.estimate().then((e) => `${(e.usage / 1048576).toFixed(1)} of ${(e.quota / 1048576).toFixed(1)} MiB`));
    console.log(`quota: ${await est()}`);
    await psh('mkdir -p /tmp/cc && printf before > /tmp/cc/before && sync');
    // incompressible data, 8 MiB per file, synced one by one, until it fails
    const fill = await psh('i=0; while [ $i -lt 30 ]; do dd if=/dev/urandom of=/tmp/cc/fill$i bs=1048576 count=8 2>/dev/null || break; sync || break; i=$((i+1)); done; echo "wrote=$i"; echo x > /tmp/cc/new; echo "new-exit=$?"; dpkg --audit >/dev/null 2>&1; ls /tmp/cc | wc -l');
    console.log(`  fill (${await est()}): ${fill.split('\n').slice(-5).join(' | ')}`);
    check(/No space left on device/i.test(fill), 'running out of storage reports ENOSPC');
    check(/new-exit=[1-9]/.test(fill), 'new files are refused while full');
    check(await page.evaluate(() => window.__tabcomputer.fs.storageFull) === true, 'FileSystem.storageFull is set');
    const freed = await psh('rm -f /tmp/cc/fill*; sync; echo "sync-exit=$?"; echo x > /tmp/cc/new; echo "new-exit=$?"; sync');
    check(/sync-exit=0/.test(freed) && /new-exit=0/.test(freed), `deleting frees it: ${freed.replace(/\n/g, ' | ')}`);
    await page.close();
    page = await open();
    const after = await psh('cat /tmp/cc/before /tmp/cc/new; ls /tmp/cc');
    check(/^beforex/.test(after), `after a reload the files written before and after are intact: ${after.replace(/\n/g, ' | ')}`);
    await ctx.close();
  }
}

console.log('\nfootprint:');
console.table(results);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await h.close(); await server.close(); await tcp.close();
process.exit(failures ? 1 : 0);
