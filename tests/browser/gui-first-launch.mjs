// First launch of Debian GUI apps (docs/GUI.md): click-to-window from a fresh
// browser profile, as on tabcomputer.com. Each app gets its own fresh profile
// (empty Cache Storage and filesystem), is opened the way a dock or Apps click
// opens it (desktop.openApp), and is timed until its X window is mapped and
// has drawn something. A second launch in the same profile gives the warm time.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/gui-first-launch.mjs [URL] [--json FILE] [--no-warm] [--debs URL] [APP...]
//
// Default apps: l3afpad mousepad ristretto gimp. The server's shared .deb cache
// (SHIRO_DEBIAN_CACHE) is whatever it is: run twice to see cold vs warm server.
// Exits 1 if any app fails. Needs playwright (NODE_PATH=/opt/node-tools/node_modules
// in the cloud containers) and Chromium (CHROMIUM, default the pre-installed one).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const jsonOut = opt('--json');
const noWarm = flag('--no-warm');
const debs = opt('--debs'); // e.g. https://tabcomputer.com/debian/: the .debs from there (a real network), the rest local
const url = args[0]?.includes('://') ? args.shift() : 'http://localhost:5299/';
const apps = args.length ? args : ['l3afpad', 'mousepad', 'ristretto', 'gimp'];
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIMIT = Number(process.env.GUI_LAUNCH_LIMIT_MS || 600_000);

/** Apps whose first window is a splash: the title of the window that means "ready" */
const READY = { gimp: 'GNU Image Manipulation Program' };

/** ms from `t0` until the app has a mapped X window, then until it has drawn (two pixel values), then its READY window */
async function waitWindow(page, app, t0) {
  const mapped = await page.waitForFunction((app) => window.__shiro.desktop.windows().some((w) => w.appId === app && w.surface), app, { timeout: LIMIT, polling: 50 }).then(() => Date.now() - t0);
  const drawn = await page.waitForFunction((app) => {
    const w = window.__shiro.desktop.windows().find((w) => w.appId === app && w.surface);
    if (!w) return false;
    const c = w.surface.canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let first = null;
    for (let i = 0; i < d.length; i += 4 * 97) {
      const v = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2] | (d[i + 3] << 24)) >>> 0;
      if (first === null) first = v; else if (v !== first) return true;
    }
    return false;
  }, app, { timeout: LIMIT, polling: 100 }).then(() => Date.now() - t0);
  if (!READY[app]) return { mapped, drawn };
  const ready = await page.waitForFunction(([app, title]) => window.__shiro.desktop.windows().some((w) => w.appId === app && w.surface && w.title.includes(title)), [app, READY[app]], { timeout: LIMIT, polling: 200 }).then(() => Date.now() - t0);
  return { mapped, drawn, ready };
}

const closeApp = (page, app) => page.evaluate(async (app) => {
  for (const w of window.__shiro.desktop.windows()) if (w.appId === app) w.close();
  for (let i = 0; i < 300 && window.__shiro.desktop.windows().some((w) => w.appId === app); i++) await new Promise((r) => setTimeout(r, 100));
}, app);

const proxy = /^https:/.test(url) && process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
const results = {};
let failed = 0;
for (const app of apps) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: !!proxy }); // a fresh profile
  const page = await context.newPage();
  let bytes = 0, requests = 0, routed = 0;
  if (debs) await page.route('**/debian/pool/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*?\/debian\//, '');
    const response = await route.fetch({ url: new URL(path, debs).href });
    if (response.ok()) routed++;
    route.fulfill({ response });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfinished', async (r) => { if (/\/debian\/pool\//.test(r.url())) { requests++; bytes += (await r.sizes().catch(() => null))?.responseBodySize ?? 0; } });
  try {
    await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
    await page.waitForFunction(() => window.__shiro?.desktop && window.__shiro.kernel, null, { timeout: 90_000 });
    await page.waitForFunction((app) => window.__shiro.desktop.apps().some((a) => a.id === app), app, { timeout: 30_000 }); // registered when the page is idle
    await page.waitForTimeout(500);
    const t0 = Date.now();
    await page.evaluate((app) => { void window.__shiro.desktop.openApp(app); }, app);
    const first = await waitWindow(page, app, t0);
    const install = await page.evaluate(() => window.__guiInstall ?? null);
    const r = { first, install: install && { ms: install.ms, packages: install.packages, fetched: install.fetched, cached: install.cached, bytes: install.bytes }, requests, mb: +(bytes / 1e6).toFixed(1) };
    if (!noWarm) {
      await closeApp(page, app);
      await page.waitForTimeout(500);
      const t1 = Date.now();
      await page.evaluate((app) => { void window.__shiro.desktop.openApp(app); }, app);
      r.warm = await waitWindow(page, app, t1);
    }
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    results[app] = r;
    const i = r.install?.ms;
    console.log(`ok   ${app}  window ${first.mapped} ms, drawn ${first.drawn} ms` + (first.ready ? `, main window ${first.ready} ms` : '') +
      (i ? `  (install ${i.total}: wait-fetch ${i.fetch}, unpack ${i.unpack}, triggers ${i.triggers}; ${r.install.packages} pkgs, ${r.requests} requests${debs ? ` (${routed} from ${debs})` : ''}, ${r.mb} MB)` : '') +
      (r.warm ? `  warm: window ${r.warm.mapped}, drawn ${r.warm.drawn}` + (r.warm.ready ? `, main window ${r.warm.ready}` : '') + ' ms' : ''));
  } catch (e) {
    failed++;
    results[app] = { error: String(e.message) };
    console.log(`FAIL ${app}  ${String(e.message).split('\n')[0]}`);
  }
  await context.close();
}
await browser.close();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
process.exit(failed ? 1 : 0);
