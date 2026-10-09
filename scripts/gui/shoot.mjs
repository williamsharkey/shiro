// Run Debian GUI apps on Shiro's desktop in headless Chromium, time them and
// take screenshots (docs/GUI.md, docs/BENCHMARKS.md).
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node scripts/gui/shoot.mjs http://localhost:5299/ --out docs/screenshots xterm l3afpad
// Per app: first install (network), launch → window mapped → first frame,
// then a warm launch (installed), and a reinstall from the browser cache.
// Options: --keep (leave windows open for a final desktop shot), --shot NAME.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); if (i < 0) return def; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const out = opt('--out', 'docs/screenshots');
const finalShot = opt('--shot', '');
const keep = flag('--keep');
const jsonOut = opt('--json', '/tmp/gui-timings.json');
const noWarm = flag('--no-warm');
const waitMs = +opt('--timeout', '300') * 1000;
const at = {};
for (let t = opt('--at', null); t; t = opt('--at', null)) { const [a, xy] = t.split('='); at[a] = xy.split(',').map(Number); }
const types = {};
for (let t = opt('--type', null); t; t = opt('--type', null)) { const i = t.indexOf('='); types[t.slice(0, i)] = t.slice(i + 1); }
// APP or APP:arg1,arg2 (arguments for the app)
const [url = 'http://localhost:5299/', ...specs] = argv;
const apps = specs.map((s) => s.split(':')[0]);
const appArgs = Object.fromEntries(specs.map((s) => [s.split(':')[0], (s.split(':')[1] || '').split(',').filter(Boolean).join(' ')]));
mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { const t = m.text(); if (/\[gui\]|\[Xshiro\]|Gtk-|Qt|error/i.test(t)) console.log('[console]', t.slice(0, 600)); });
await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
await page.waitForFunction(() => window.__shiro && window.__shiro.shell && window.__shiro.desktop, null, { timeout: 90000 });
console.log('crossOriginIsolated =', await page.evaluate(() => crossOriginIsolated));

const sh = (cmd) => page.evaluate(async (cmd) => {
  let o = '';
  const s = window.__guiShell ??= Object.assign(window.__shiro.shell.fork(), { terminal: null });
  const t0 = performance.now();
  const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  return { code, out: o, ms: Math.round(performance.now() - t0) };
}, cmd);

/** Launch and wait for a desktop window of the app whose canvas has drawn something. */
const diag = () => page.evaluate(() => {
  const k = window.__shiro.kernel;
  const x = window.__shiroX;
  const procs = k ? [...(k.procs?.values?.() ?? [])].map((p) => `${p.pid}:${p.comm}:${p.state}:sys=${p.syscalls}:in=${p.inSyscall}`) : [];
  return { procs, desk: window.__shiro.desktop.windows().map((w) => w.appId + ':' + !!w.surface), xclients: x?.server.clients.size, windows: x?.rootless?.windows(), last: window.__guiLast?.output().slice(-300) };
});

async function launch(app) {
  const t0 = Date.now();
  const r = await sh(`gui ${app} ${appArgs[app] || ''}`);
  if (r.code) throw new Error(r.out);
  const timer = setInterval(async () => console.log('[diag]', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(await diag().catch((e) => String(e)))), 15000);
  try { return await waitApp(app, t0); } finally { clearInterval(timer); }
}

async function waitApp(app, t0) {
  const mapped = await page.waitForFunction((app) => window.__shiro.desktop.windows().some((w) => w.appId === app && w.surface), app, { timeout: waitMs, polling: 100 }).then(() => Date.now() - t0);
  const drawn = await page.waitForFunction((app) => {
    const w = window.__shiro.desktop.windows().find((w) => w.appId === app && w.surface);
    if (!w) return false;
    const c = w.surface.canvas, ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let first = null;
    for (let i = 0; i < d.length; i += 4 * 97) {
      const v = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2] | (d[i + 3] << 24)) >>> 0;
      if (first === null) first = v; else if (v !== first) return true;
    }
    return false;
  }, app, { timeout: waitMs, polling: 200 }).then(() => Date.now() - t0);
  return { mapped, drawn };
}

async function closeApp(app) {
  await page.evaluate((app) => { for (const w of window.__shiro.desktop.windows()) if (w.appId === app) w.close(); }, app);
  await page.waitForFunction((app) => !window.__shiro.desktop.windows().some((w) => w.appId === app), app, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
}

const results = {};
for (const app of apps) {
  const inst = await sh(`gui install ${app}`);
  console.log(`=== gui install ${app}  exit=${inst.code}  ${inst.ms}ms\n${inst.out.replace(/\r/g, '\n').split('\n').filter(Boolean).slice(-4).join('\n')}`);
  const first = await launch(app);
  await page.waitForTimeout(2500);
  if (types[app]) {
    const box = await page.evaluate((app) => { const w = window.__shiro.desktop.windows().find((w) => w.appId === app && w.surface); const r = w.surface.canvas.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, app);
    await page.mouse.click(box.x, box.y);
    const t0 = Date.now();
    await page.keyboard.type(types[app].replace(/\\n/g, '\n'), { delay: 30 });
    console.log(`=== ${app}: typed ${types[app].length} chars in ${Date.now() - t0} ms`);
    await page.waitForTimeout(4000);
  }
  await page.screenshot({ path: `${out}/gui-${app}.png` });
  console.log(`=== ${app}: first launch window ${first.mapped} ms, first frame ${first.drawn} ms; screenshot ${out}/gui-${app}.png`);
  results[app] = { installMs: inst.ms, installOut: inst.out.trim().split('\n').pop(), first };
  if (!noWarm) {
    await closeApp(app);
    const warm = await launch(app);
    console.log(`=== ${app}: warm launch window ${warm.mapped} ms, first frame ${warm.drawn} ms`);
    results[app].warm = warm;
    await sh('rm -f /var/lib/shiro-gui/status.json');
    const cached = await sh(`gui install ${app}`);
    console.log(`=== ${app}: reinstall from browser cache ${cached.ms} ms: ${cached.out.trim().split('\n').pop()}`);
    results[app].reinstallFromCacheMs = cached.ms;
  }
  if (!keep) await closeApp(app);
}
if (finalShot) {
  // --at APP=x,y places windows (frame, work-area coordinates) for the final shot, in argument order
  for (const [app, [x, y]] of Object.entries(at)) {
    await page.evaluate(([app, x, y]) => { const w = window.__shiro.desktop.windows().filter((w) => w.appId === app).pop(); if (w) { w.move(x, y); w.focus(); } }, [app, x, y]);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${finalShot}.png` });
}
writeFileSync(jsonOut, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
await browser.close();
