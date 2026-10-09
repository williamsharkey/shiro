// One draw at load (docs/DESKTOP.md "Loading"): the desktop's first painted
// frame is its final layout, and hovering the dock never moves a neighbour.
//
// For each case (desktop 1280×800 and iPhone 15 Pro, light and dark, each a
// fresh profile) it loads the page and checks, in Chromium:
//   - cumulative layout shift is 0 (PerformanceObserver 'layout-shift');
//   - no element of the menu bar, dock or windows changes its bounding box
//     between the first frame the desktop is visible and the settled page
//     (rects sampled every animation frame; the clock is left out: its text
//     changes with the time);
//   - (desktop size) hovering each dock icon leaves every other icon's rect
//     unchanged.
// --shots DIR writes a strip of screencast frames per case (load-frames-*.png).
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/no-reflow.mjs [URL] [--shots DIR] [--only NAME]
//
// Exits 1 if any check fails. Needs playwright (NODE_PATH=/opt/node-tools/node_modules
// in the cloud containers) and Chromium (CHROMIUM, default the pre-installed one).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch {
  try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright-core'); }
}
const { chromium, devices } = pw;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const only = opt('--only');
const url = args[0] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const SETTLE_MS = Number(process.env.NO_REFLOW_SETTLE_MS || 4000);
if (shots) mkdirSync(shots, { recursive: true });

const CASES = [
  { name: 'desktop-dark', ctx: { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' }, hover: true },
  { name: 'desktop-light', ctx: { viewport: { width: 1280, height: 800 }, colorScheme: 'light' }, hover: true },
  { name: 'iphone-dark', ctx: { ...devices['iPhone 15 Pro'], colorScheme: 'dark' } },
  { name: 'iphone-light', ctx: { ...devices['iPhone 15 Pro'], colorScheme: 'light' } },
].filter(c => !only || c.name === only);

/** In the page, before any script: layout shifts and per-frame rects of the desktop's parts */
function recorder() {
  const rec = window.__reflow = { cls: 0, shifts: [], first: null, firstAt: 0, last: null, frames: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        rec.cls += e.value;
        rec.shifts.push({ t: Math.round(e.startTime), value: e.value, nodes: (e.sources || []).map(s => s.node?.className || s.node?.nodeName || '?') });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  const SEL = '.sd-menubar, .sd-menubar > *, .sd-dock, .sd-dock > *, .sd-win, .sd-win .sd-titlebar, .sd-win .sd-title, .sd-win .sd-body, .sd-keybar, .sd-key';
  const snap = () => {
    const out = {};
    const seen = new Map();
    for (const el of document.querySelectorAll(SEL)) {
      if (el.classList.contains('sd-mb-clock')) continue;
      // A stable key: the element's id/data-app or classes, numbered among equals
      const base = el.id || el.dataset.app || el.dataset.group || el.getAttribute('aria-label') || el.className;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const r = el.getBoundingClientRect();
      out[`${base}#${n}`] = [r.x, r.y, r.width, r.height].map(v => Math.round(v * 10) / 10);
    }
    return out;
  };
  const tick = () => {
    const root = document.getElementById('shiro-desktop');
    if (root && !root.classList.contains('sd-booting') && getComputedStyle(root).visibility === 'visible') {
      const s = snap();
      if (!rec.first) { rec.first = s; rec.firstAt = Math.round(performance.now()); }
      rec.last = s;
      rec.frames++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function diff(a, b) {
  const out = [];
  for (const k of Object.keys(a)) {
    if (!(k in b)) { out.push(`${k}: gone`); continue; }
    if (a[k].some((v, i) => Math.abs(v - b[k][i]) > 0.5)) out.push(`${k}: [${a[k]}] → [${b[k]}]`);
  }
  return out;
}

/** Lay screencast frames side by side in one PNG (drawn by the browser) */
async function strip(browser, frames, file, title) {
  const pick = frames.length <= 8 ? frames : Array.from({ length: 8 }, (_, i) => frames[Math.round(i * (frames.length - 1) / 7)]);
  const page = await browser.newPage({ viewport: { width: 1600, height: 400 } });
  await page.setContent(`<body style="margin:0;background:#222;font:12px sans-serif;color:#ccc">
    <div style="padding:6px 10px">${title}</div>
    <div style="display:flex;gap:6px;padding:0 10px 10px;align-items:flex-start">${pick.map(f =>
      `<figure style="margin:0"><img src="data:image/jpeg;base64,${f.data}" style="height:300px;display:block;border:1px solid #444"><figcaption style="text-align:center">${f.t} ms</figcaption></figure>`).join('')}</div></body>`);
  await page.waitForTimeout(200);
  const box = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
  await page.setViewportSize({ width: Math.min(box.w, 4000), height: box.h });
  writeFileSync(file, await page.screenshot());
  await page.close();
}

const browser = await chromium.launch({ executablePath: exe });
let failed = 0;
for (const c of CASES) {
  const problems = [];
  const ctx = await browser.newContext(c.ctx);
  const page = await ctx.newPage();
  await page.addInitScript(recorder);
  // The tour card is an overlay that appears later by design; keep it out of the frames
  await page.addInitScript(() => { try { localStorage.setItem('shiro-desktop-tour', '1'); } catch {} });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let t0 = 0;
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ data: f.data, t: Math.round(f.metadata.timestamp * 1000 - t0) });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 });
  t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__reflow?.first && window.__shiro?.terminal, null, { timeout: 60_000 });
  await page.waitForTimeout(SETTLE_MS);
  await cdp.send('Page.stopScreencast').catch(() => {});
  const r = await page.evaluate(() => window.__reflow);
  // The page itself is never faded (a class on <html> once matched the traffic lights' .sd-light)
  const faded = await page.evaluate(() => [document.documentElement, document.body, document.getElementById('shiro-desktop')]
    .filter(e => e && getComputedStyle(e).opacity !== '1').map(e => e.tagName + (e.id ? '#' + e.id : '')));
  if (faded.length) problems.push(`not opaque: ${faded.join(', ')}`);
  if (r.cls > 0) problems.push(`layout shift ${r.cls.toFixed(4)}: ${JSON.stringify(r.shifts)}`);
  const moved = diff(r.first, r.last);
  if (moved.length) problems.push(`moved after the first visible frame (${r.firstAt} ms):\n      ${moved.join('\n      ')}`);
  const tracked = Object.keys(r.first).length;

  let hovered = 0;
  if (c.hover) {
    const items = await page.$$('.sd-dock > .sd-dock-item');
    for (let i = 0; i < items.length; i++) {
      const rects = () => page.$$eval('.sd-dock > *', els => els.map(e => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(v => Math.round(v * 10) / 10); }));
      await page.mouse.move(640, 300);
      await page.waitForTimeout(300);
      const before = await rects();
      const idx = await items[i].evaluate(e => [...e.parentElement.children].indexOf(e));
      await items[i].hover();
      await page.waitForTimeout(350);
      const after = await rects();
      const bad = before.map((b, j) => j !== idx && b.some((v, k) => Math.abs(v - after[j][k]) > 0.5) ? j : -1).filter(j => j >= 0);
      if (bad.length) problems.push(`hovering dock item ${idx} moved items ${bad.join(', ')}`);
      hovered++;
    }
  }
  if (shots && frames.length) await strip(browser, frames, join(shots, `load-frames-${c.name}.png`), `${c.name}: screencast frames from navigation (first visible desktop frame at ${r.firstAt} ms)`);
  await ctx.close();
  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: CLS ${r.cls.toFixed(4)}, ${tracked} elements stable over ${r.frames} frames${c.hover ? `, ${hovered} dock hovers` : ''}, ${frames.length} screencast frames`);
  for (const p of problems) console.log(`    ${p}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
