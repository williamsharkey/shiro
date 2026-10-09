#!/usr/bin/env node
// Debian storage footprint on a persistent (on-disk) profile, as real users
// have; headless incognito contexts keep IndexedDB in memory and report much
// more. Not a benchmark suite (takes minutes):
//   [FP_CONF='apt.conf line;;another'] [FP_PKGS=tree,bc,jq] [FP_BIG=1] node bench/footprint.mjs [PROFILE_DIR]
// After each step: navigator.storage usage, live FS bytes in IndexedDB, and
// the profile's IndexedDB directory on disk.
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { CHROMIUM } from './lib/harness.mjs';
import { startShiroServer } from './lib/servers.mjs';
const dir = process.argv[2] || '/tmp/fp-profile';
rmSync(dir, { recursive: true, force: true });
const server = await startShiroServer({ staticDir: join(process.cwd(), 'dist'), isolated: true });
const ctx = await chromium.launchPersistentContext(dir, { executablePath: CHROMIUM, args: ['--no-sandbox'] });
await ctx.addInitScript(readFileSync('bench/lib/inpage.js', 'utf8'));
let page;
const open = async () => { page = await ctx.newPage(); await page.goto(server.origin + '/'); await page.waitForFunction(() => window.__bench?.marks.firstPrompt, null, { timeout: 120000 }); };
await open();
const sh = async (c) => { const r = await page.evaluate(([c]) => window.__bench.shLimit(c, 1800000), [c]); return r; };
const MiB = (n) => (n / 1048576).toFixed(1);
const disk = () => { try { return execSync(`du -sb ${dir}/Default/IndexedDB 2>/dev/null | cut -f1`).toString().trim(); } catch { return '?'; } };
const live = () => page.evaluate(async () => {
  const db = await new Promise((r, j) => { const q = indexedDB.open('shiro-fs'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  return new Promise((r) => {
    let sum = 0, n = 0; const big = [];
    const c = db.transaction('files').objectStore('files').openCursor();
    c.onsuccess = () => { const cur = c.result; if (!cur) { db.close(); big.sort((a, b) => b[1] - a[1]); r({ sum, n, big: big.slice(0, 6) }); return; }
      const v = cur.value; const b = v.content?.byteLength ?? 0; sum += b; n++; big.push([v.path, b]); if (big.length > 50) { big.sort((a, b) => b[1] - a[1]); big.length = 20; } cur.continue(); };
  });
});
async function report(label) {
  await page.evaluate(() => window.__tabcomputer.fs.sync());
  const u = await page.evaluate(() => navigator.storage.estimate().then((e) => e.usage));
  const l = await live();
  console.log(`${label.padEnd(28)} usage ${MiB(u).padStart(7)} MiB  live ${MiB(l.sum).padStart(7)} MiB (${l.n} nodes)  disk ${MiB(+disk()).padStart(7)} MiB`);
  if (process.env.FP_BIG) console.log('   ', l.big.map(([p, b]) => `${p} ${MiB(b)}`).join(', '));
}
await sh('debian install'); await report('debian install');
if (process.env.FP_CONF) console.log('conf:', (await sh(`printf '%s\\n' ${process.env.FP_CONF.split(';;').map((l) => `'${l}'`).join(' ')} | sudo tee /etc/apt/apt.conf.d/50footprint`)).out.trim().replace(/\n/g, ' | '));
let r = await sh('sudo apt-get update >/dev/null 2>&1; echo $?'); await report(`apt-get update ${(r.ms / 1000).toFixed(1)} s (exit ${r.out.trim()})`);
for (const p of (process.env.FP_PKGS || 'tree,bc,jq').split(',')) { r = await sh(`sudo apt-get install -y ${p} >/dev/null 2>&1; echo $?`); await report(`install ${p} ${(r.ms / 1000).toFixed(1)} s (exit ${r.out.trim()})`); }
r = await sh('apt-cache policy jq >/dev/null 2>&1; echo $?'); console.log(`apt-cache policy ${(r.ms / 1000).toFixed(1)} s`);
r = await sh('sudo apt-get install -y tree >/dev/null 2>&1; echo $?'); console.log(`install (already installed) ${(r.ms / 1000).toFixed(1)} s`);
await ctx.close(); await server.close();
console.log('closed browser; disk', MiB(+disk()), 'MiB');
for (const f of readdirSync(join(dir, 'Default/IndexedDB'))) console.log('  ', f, MiB(+execSync(`du -sb "${join(dir, 'Default/IndexedDB', f)}" | cut -f1`).toString()), 'MiB');
