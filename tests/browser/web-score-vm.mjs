// Baseline for docs/WEB_SCORE.md: the Linux GUI browsers unix/gui runs in the
// VM (NetSurf, Dillo: Debian binaries in Blink, X11 on the desktop, TCP through
// the relay, OpenSSL in the guest). Per site: loads = the window's title
// becomes the page's within the time limit; renders = the window shows more
// than a blank page (distinct colours, non-background pixels).
//
//   node tests/browser/web-score-vm.mjs [--app http://localhost:5299] [--apps netsurf,dillo]
//        [--sites example,wikipedia,...] [--json out.json] [--shots DIR] [--extra-roots PEM]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
for (const m of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright-core', '/opt/node-tools/node_modules/playwright']) {
  try { ({ chromium } = require(m)); break; } catch { /* next */ }
}
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const APP = opt('--app', 'http://localhost:5299').replace(/\/$/, '');
const APPS = opt('--apps', 'netsurf,dillo').split(',');
const JSON_OUT = opt('--json', '');
const SHOTS = opt('--shots', '');
const ROOTS = opt('--extra-roots', existsSync('/root/.ccr/ca-bundle.crt') ? '/root/.ccr/ca-bundle.crt' : '');
const LIMIT = Number(opt('--timeout', '120')) * 1000;
const SITES = {
  example: 'https://example.com/',
  wikipedia: 'https://en.wikipedia.org/wiki/Web_browser',
  hackernews: 'https://news.ycombinator.com/',
  debian: 'https://www.debian.org/',
  google: 'https://www.google.com/',
  github: 'https://github.com/',
  bbc: 'https://www.bbc.com/',
  craigslist: 'https://sfbay.craigslist.org/',
  mdn: 'https://developer.mozilla.org/en-US/',
  w3schools: 'https://www.w3schools.com/',
};
const only = opt('--sites', '');
const sites = Object.entries(SITES).filter(([id]) => !only || only.split(',').includes(id));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(`${APP}/?ui=desktop`);
await page.waitForFunction(() => window.__tabcomputer?.shell && window.__tabcomputer.desktop, null, { timeout: 90000 });

const sh = (cmd) => page.evaluate(async (cmd) => {
  let o = '';
  const s = window.__vmShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  return { code, out: o };
}, cmd);

/** Trust extra roots in the guest the way update-ca-certificates would: the bundle, plus HASH.0 links. */
async function trustRoots() {
  if (!ROOTS) return;
  const pem = readFileSync(ROOTS, 'utf8');
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const files = certs.map((c) => {
    let hash = '';
    try { hash = execFileSync('openssl', ['x509', '-hash', '-noout'], { input: c }).toString().trim(); } catch { /* no openssl */ }
    return { hash, pem: c + '\n' };
  });
  await page.evaluate(async (files) => {
    const fs = window.__tabcomputer.fs;
    const bundle = '/etc/ssl/certs/ca-certificates.crt';
    let cur = '';
    try { cur = await fs.readFile(bundle, 'utf8'); } catch { /* none yet */ }
    const add = files.map((f) => f.pem).filter((p) => !cur.includes(p.trim())).join('');
    if (add) await fs.writeFile(bundle, cur + add);
    for (const f of files) if (f.hash) { try { await fs.writeFile(`/etc/ssl/certs/${f.hash}.0`, f.pem); } catch { /* dir missing */ } }
  }, files);
}

const shotOf = (app) => page.evaluate((app) => {
  const w = window.__tabcomputer.desktop.windows().filter((w) => w.appId === app && w.surface).pop();
  if (!w) return null;
  const c = w.surface.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const counts = new Map();
  for (let i = 0; i < d.length; i += 4 * 7) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
  const total = Math.ceil(d.length / 28);
  const bg = Math.max(...counts.values());
  return { title: w.title, colors: counts.size, ink: 1 - bg / total };
}, app);

const results = { date: new Date().toISOString(), apps: {} };
for (const app of APPS) {
  const t0 = Date.now();
  const inst = await sh(`gui install ${app}`);
  console.log(`${app}: install exit ${inst.code} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await trustRoots();
  const rows = results.apps[app] = [];
  for (const [id, url] of sites) {
    const t1 = Date.now();
    await sh(`gui ${app} ${url}`);
    let loaded = null, last = null;
    for (;;) {
      last = await shotOf(app);
      const t = (last?.title || '').trim();
      // Both set the window title to the page's once it is parsed (NetSurf: "Title", Dillo: "Dillo: Title")
      if (t && !/^(netsurf|dillo)$/i.test(t) && !/loading|^dillo:?\s*$/i.test(t)) { loaded = Date.now() - t1; break; }
      if (Date.now() - t1 > LIMIT) break;
      await page.waitForTimeout(500);
    }
    if (loaded !== null) await page.waitForTimeout(5000);
    const s = await shotOf(app);
    const renders = !!s && s.colors >= 16 && s.ink >= 0.05;
    const row = { id, url, loads: loaded !== null, loadMs: loaded, renders: loaded !== null && renders, title: s?.title, colors: s?.colors, ink: s ? Number(s.ink.toFixed(3)) : null };
    rows.push(row);
    console.log(`${app.padEnd(8)} ${id.padEnd(12)} load ${row.loads ? '✓' : '✗'} render ${row.renders ? '✓' : '✗'} ${loaded ? (loaded / 1000).toFixed(1) + ' s' : ''} "${(s?.title || '').slice(0, 50)}" colors=${s?.colors} ink=${row.ink}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vm-${app}-${id}.png` });
    await page.evaluate((app) => { for (const w of window.__tabcomputer.desktop.windows()) if (w.appId === app) w.close(); }, app);
    await page.waitForFunction((app) => !window.__tabcomputer.desktop.windows().some((w) => w.appId === app), app, { timeout: 20000 }).catch(() => {});
    await sh(`pkill -f ${app} 2>/dev/null; true`);
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
  }
  const n = (k) => rows.filter((r) => r[k]).length;
  console.log(`${app}: loads ${n('loads')}/${rows.length}, renders ${n('renders')}/${rows.length}`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
await browser.close();
