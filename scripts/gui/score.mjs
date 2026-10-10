#!/usr/bin/env node
// GUI app scoreboard (docs/GUI_SCORE.md): install Debian GUI apps from the
// streaming manifest (public/gui/apps.json) in the built app, in headless
// Chromium, and check each one: installs, a window appears, it renders
// something, it reacts to input, and the DOM text layer sees its text.
//
//   npm run build && npm run gui-score -- [--only a,b] [--rescore] [--report-only] [--url URL]
//
// A fresh browser profile per app (as on a first visit: nothing cached in the
// browser; the server's .deb cache is warm after the first run), text mode
// `overlay`. Results are cached per app and manifest version in
// .gui-score/results.json; screenshots go to .gui-score/shots/. Uses the
// pre-installed Chromium (/opt/pw-browsers); never `playwright install`.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);
const ONLY = opt('--only', '') ? opt('--only', '').split(',') : null;
const PORT = Number(opt('--port', '5398'));
const INSTALL_S = Number(opt('--install-timeout', '900'));
const WINDOW_S = Number(opt('--window-timeout', '420'));
const OUT_DIR = join(ROOT, '.gui-score');
const SHOTS = join(OUT_DIR, 'shots');
const RESULTS = join(OUT_DIR, 'results.json');
const REPORT = join(ROOT, 'docs/GUI_SCORE.md');
mkdirSync(SHOTS, { recursive: true });

/** The scoreboard's apps, in report order: [manifest id, group]. */
const APPS = [
  ['mousepad', 'Editors & viewers'], ['gedit', 'Editors & viewers'], ['l3afpad', 'Editors & viewers'],
  ['evince', 'Editors & viewers'], ['eog', 'Editors & viewers'], ['ristretto', 'Editors & viewers'], ['gpicview', 'Editors & viewers'],
  ['gimp', 'Graphics'], ['inkscape', 'Graphics'], ['krita', 'Graphics'], ['blender', 'Graphics'],
  ['pcmanfm', 'Desktop'], ['thunar', 'Desktop'], ['xterm', 'Desktop'], ['galculator', 'Desktop'],
  ['gnumeric', 'Office'], ['abiword', 'Office'], ['libreoffice-writer', 'Office'],
  ['firefox-esr', 'Internet & media'], ['netsurf', 'Internet & media'], ['dillo', 'Internet & media'],
  ['vlc', 'Internet & media'], ['audacity', 'Internet & media'],
  ['featherpad', 'Qt'], ['qterminal', 'Qt'], ['qpdfview', 'Qt'], ['keepassxc', 'Qt'], ['kcalc', 'Qt'], ['lximage-qt', 'Qt'],
];

const manifest = JSON.parse(readFileSync(join(ROOT, 'public/gui/apps.json'), 'utf8'));
const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
// (renders: not one flat colour; results from before that rule are re-derived)
/** A window titled like an error ("Fatal error", "Startup Failure"): the app opened only to say it can't run */
const errorWindow = (titles = []) => titles.find((t) => /\b(fatal|failure|error)\b/i.test(t));
for (const r of Object.values(results)) {
  if (r.colors !== undefined) r.rendered = r.colors >= 2;
  if (errorWindow(r.windows)) { r.window = false; r.note = `error window: “${errorWindow(r.windows)}”`; }
}
const save = () => writeFileSync(RESULTS, JSON.stringify(results, null, 1));
/** A result is current while the app's package set is unchanged */
const version = (id) => (manifest.apps[id]?.packages ?? []).map((n) => `${n}=${manifest.packages[n]?.version}`).join(' ');

// ── The app ──────────────────────────────────────────────────────────────
function startServer() {
  if (!existsSync(join(ROOT, 'dist/index.html'))) {
    console.log('building the app (npm run build) ...');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  }
  return spawn('node', ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PORT: String(PORT), STATIC_DIR: join(ROOT, 'dist') } });
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
try { ({ chromium } = require('playwright-core')); } catch { try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); } }

const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out after ${Math.round(ms / 1000)} s`)), ms))]);

/** Everything the page can tell about an app's windows (the main one: the largest) */
const windowsOf = (page, id) => page.evaluate((id) => window.__tabcomputer.desktop.windows().filter((w) => w.appId === id && w.surface).map((w) => {
  const c = w.surface.canvas, r = c.getBoundingClientRect();
  const layer = c.parentElement?.querySelector('.shiro-x11-text');
  return { title: w.title, x: r.x, y: r.y, width: r.width, height: r.height, bw: c.width, bh: c.height, spans: layer ? layer.children.length : 0 };
}).sort((a, b) => b.width * b.height - a.width * a.height), id);

/** Distinct colours on a coarse grid of the app's largest window, and a hash of them */
const sample = (page, id) => page.evaluate((id) => {
  const w = window.__tabcomputer.desktop.windows().filter((w) => w.appId === id && w.surface).sort((a, b) => b.surface.canvas.width * b.surface.canvas.height - a.surface.canvas.width * a.surface.canvas.height)[0];
  if (!w) return null;
  const c = w.surface.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const colors = new Set();
  let hash = 0;
  for (let y = 0; y < c.height; y += 3) for (let x = 0; x < c.width; x += 3) {
    const i = (y * c.width + x) * 4, v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    colors.add(v);
    hash = (Math.imul(hash, 31) + v) | 0;
  }
  return { colors: colors.size, hash };
}, id);

async function scoreApp(browser, base, id) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); } catch { /* none */ } });
  const app = manifest.apps[id];
  const r = { id, toolkit: app.toolkit, mb: +(app.size / 1e6).toFixed(1), packages: app.packages.length, version: version(id), when: new Date().toISOString() };
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(base + '/?ui=desktop&xtext=overlay');
    await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 120000 });
    const sh = (cmd) => page.evaluate(async (cmd) => {
      const s = window.__scoreShell ??= window.__tabcomputer.shell.fork();
      let o = '';
      const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
      return { code, out: o };
    }, cmd);
    // 1. installs
    let t = Date.now();
    const inst = await timeout(sh(`gui install ${id}`), INSTALL_S * 1000, 'install');
    r.installMs = Date.now() - t;
    r.installed = inst.code === 0;
    r.installNote = inst.out.replace(/\r/g, '\n').trim().split('\n').pop()?.slice(0, 200);
    if (!r.installed) throw new Error(`install: ${r.installNote}`);
    // 2. a window appears
    t = Date.now();
    const run = await sh(`gui ${id}`);
    if (run.code) throw new Error(`launch: ${run.out.trim().slice(-200)}`);
    // (the app may exit instead: a missing library, a crash)
    await page.evaluate(() => { window.__guiExited = null; window.__guiLast?.exited.then((s) => { window.__guiExited = s; }); });
    const how = await page.waitForFunction((id) => window.__tabcomputer.desktop.windows().some((w) => w.appId === id && w.surface) ? 'window' : window.__guiExited !== null ? 'exited' : false,
      id, { timeout: WINDOW_S * 1000, polling: 250 }).then((h) => h.jsonValue()).catch(() => 'timeout');
    if (how !== 'window') {
      r.window = false;
      r.note = how === 'exited' ? `exited (status ${await page.evaluate(() => window.__guiExited)}) before a window` : 'no window in ' + WINDOW_S + ' s';
      return r;
    }
    r.windowMs = Date.now() - t;
    r.window = true;
    // let it finish its first paint (and splash screens give way)
    await page.waitForTimeout(8000);
    // 3. renders something
    const s0 = await sample(page, id);
    r.colors = s0?.colors ?? 0;
    r.rendered = r.colors >= 2;
    // 4. reacts to input: click into the main window, type, compare pixels
    const [main] = await windowsOf(page, id);
    r.windows = (await windowsOf(page, id)).map((w) => w.title).slice(0, 3);
    if (errorWindow(r.windows)) { r.window = false; r.note = `error window: “${errorWindow(r.windows)}”`; }
    if (main) {
      // focus it the way the desktop does (no click: a click can land on a menu or a dropdown)
      await page.evaluate((id) => {
        const w = window.__tabcomputer.desktop.windows().filter((w) => w.appId === id && w.surface).sort((a, b) => b.surface.canvas.width * b.surface.canvas.height - a.surface.canvas.width * a.surface.canvas.height)[0];
        w.focus(); w.surface.canvas.focus();
      }, id);
      await page.waitForTimeout(500);
      await page.keyboard.type('abc 123', { delay: 60 });
      await page.waitForTimeout(4000);
      const s1 = await sample(page, id);
      r.input = !!s1 && s1.hash !== s0?.hash;
      if (!r.input) {
        // the focus may need to be in a text field: click into the window, type again
        await page.mouse.click(main.x + main.width / 2, main.y + main.height / 2);
        await page.keyboard.type('abc 123', { delay: 60 });
        await page.waitForTimeout(4000);
        const s1b = await sample(page, id);
        r.input = !!s1b && s1b.hash !== s1?.hash;
        if (r.input) r.inputVia = 'click and type';
        else await page.keyboard.press('Escape');
      }
      if (!r.input) {
        // nothing to type into (viewers): the usual Open shortcut should change something
        const before = (await windowsOf(page, id)).length;
        await page.keyboard.press('Control+o');
        await page.waitForTimeout(6000);
        const s2 = await sample(page, id);
        r.input = (await windowsOf(page, id)).length > before || (!!s2 && s2.hash !== s1?.hash);
        if (r.input) r.inputVia = 'Ctrl+O';
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1500);
      }

    }
    // 5. the text layer sees its text
    const after = await windowsOf(page, id);
    r.spans = after.reduce((n, w) => n + w.spans, 0);
    r.textLayer = r.spans > 0;
    await page.screenshot({ path: join(SHOTS, `${id}.png`) });
  } catch (e) {
    r.error = String(e.message).split('\n')[0].slice(0, 300);
  } finally {
    // what the app said (warnings, the reason it exited)
    r.output = await page.evaluate(() => window.__guiLast?.output().slice(-1500)).catch(() => '') || '';
    if (errors.length) r.pageErrors = errors.slice(0, 3);
    await context.close().catch(() => {});
  }
  return r;
}

// ── Report ───────────────────────────────────────────────────────────────
/** Known causes, shown with a row's own note (see "Failures and fixes" in the report) */
const KNOWN = {
  blender: 'past OpenCV\'s CPU check (engine fix); now glibc aborts on PI-mutex futex ops (EINVAL in the x86 engine, reported)',
  'libreoffice-writer': 'loads now (ELF .bin, libcups); an uncaught UNO RuntimeException at startup, then it hangs (not diagnosed)',
  'firefox-esr': 'past the getaddrinfo abort (fixed): its window opens after minutes, still blank; content processes crash (SIGSEGV)',
  vlc: 'quits at once: sigwait() is ENOSYS in the x86 engine (reported)',
  audacity: 'SysV semaphores aren\'t forwarded by the x86 engine yet (shared memory is)',
  eog: 'input: a viewer with nothing open: typing changes nothing',
  ristretto: 'input: a viewer with nothing open: typing changes nothing',
  gpicview: 'input: a viewer with nothing open: typing changes nothing',
  'lximage-qt': 'input: a viewer with nothing open: typing changes nothing',
  krita: 'input: its start screen has nothing to type into (passed in one run of three)',
  dillo: 'FLTK draws its text as pixels',
};

const yes = (v) => v === true ? '✓' : v === false ? '✗' : '–';
const secs = (ms) => ms === undefined ? '–' : ms < 10000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms / 1000) + ' s';

const MARKER = '<!-- notes: everything below is kept when the tables are regenerated -->';

function report() {
  const rows = APPS.filter(([id]) => results[id]);
  const n = rows.length;
  const count = (k) => rows.filter(([id]) => results[id][k] && (k === 'installed' || results[id].window)).length;
  let md = `# GUI app scoreboard\n\n` +
    `Debian 12 GUI apps installed from the streaming manifest (\`public/gui/apps.json\`, docs/GUI.md) in the built app, ` +
    `in headless Chromium (4 vCPUs), by \`scripts/gui/score.mjs\` (\`npm run gui-score\`). Each app in a fresh browser profile ` +
    `(nothing cached in the browser; the local server's .deb cache warm); text mode \`overlay\` (docs/DOM-RENDERING.md).\n\n` +
    `Columns: **installs**; **window**: a desktop window appears, with the time from launch (installed) to it; ` +
    `**renders**: its largest window isn't one flat colour after 8 s; **input**: focusing it and typing \`abc 123\` changes its pixels ` +
    `(or, if not, clicking into its middle and typing does, or Ctrl+O opens a window or changes them); ` +
    `**text**: the DOM text layer has spans for it (GTK via libshiro-text-hook.so, core X text; Qt and others draw pixels only).\n\n` +
    `**${count('installed')}/${n} install, ${count('window')}/${n} open a window, ${count('rendered')}/${n} render, ` +
    `${count('input')}/${n} react to input, ${count('textLayer')}/${n} have DOM text.**\n\n`;
  let group = '';
  for (const [id, g] of rows) {
    const r = results[id];
    if (g !== group) {
      md += `\n### ${g}\n\n| App | Toolkit | Download | Install | Window | First window | Renders | Input | Text | Notes |\n|---|---|---:|---:|:-:|---:|:-:|:-:|:-:|---|\n`;
      group = g;
    }
    const note = [r.note || r.error, KNOWN[id]].filter(Boolean).join('; ').replace(/\|/g, '\\|');
    md += `| ${id} | ${r.toolkit} | ${r.mb} MB | ${r.installed ? secs(r.installMs) : '✗'} | ${yes(r.window)} | ${r.window ? secs(r.windowMs) : '–'} | ${r.window ? yes(r.rendered) : '–'} | ${r.window ? yes(r.input) : '–'} | ${r.window ? yes(r.textLayer) : '–'}${r.window && r.spans ? ` (${r.spans})` : ''} | ${note} |\n`;
  }
  md += `\n${new Date().toISOString().slice(0, 10)}; per-app details (output tails, window titles) in .gui-score/results.json.\n`;
  // the hand-written part of the report (after the marker) is kept
  let kept = '';
  try { const old = readFileSync(REPORT, 'utf8'); const i = old.indexOf(MARKER); if (i >= 0) kept = old.slice(i); } catch { /* first report */ }
  return md + '\n' + (kept || MARKER + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────
if (flag('--report-only')) {
  writeFileSync(REPORT, report());
  console.log(`wrote ${REPORT}`);
  process.exit(0);
}
let srv = null;
let base = opt('--url', '');
if (!base) { srv = startServer(); base = `http://localhost:${PORT}`; }
await waitFor(base + '/gui/apps.json');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  for (const [id] of APPS) {
    if (ONLY && !ONLY.includes(id)) continue;
    if (!manifest.apps[id]) { console.log(`${id}: not in the manifest`); continue; }
    if (!flag('--rescore') && results[id]?.version === version(id) && !ONLY) { console.log(`${id}: cached`); continue; }
    const t0 = Date.now();
    const r = await scoreApp(browser, base, id);
    results[id] = r;
    save();
    writeFileSync(REPORT, report());
    console.log(`${id}: install ${yes(r.installed)} ${secs(r.installMs)}, window ${yes(r.window)} ${secs(r.windowMs)}, renders ${yes(r.rendered)}, input ${yes(r.input)}, text ${yes(r.textLayer)}${r.error ? ` — ${r.error}` : r.note ? ` — ${r.note}` : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
} finally {
  await browser.close();
  srv?.kill();
}
