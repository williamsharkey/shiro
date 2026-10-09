// Dock icon sets (docs/DESKTOP.md "Icon sets"), in Chromium:
//   default     a fresh profile gets Drafting, every dock tile a glyph tile
//   zero-cost   with a static set (also with Settings → Dock & Icons open):
//               no live-set or three.js chunk loaded, no WebGL context, no
//               animation frames requested, no pointer listeners on the dock
//   swap        every set in turn: no layout shift, the dock's box unchanged,
//               no long animation frame during the crossfade
//   live        Pearl, Holo foil, Liquid glass draw (WebGL contexts, frames);
//               hidden tab and reduced motion stop their frames; switching
//               back to a static set loses every context and stops every loop
//   persist     the choice survives a reload
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/icon-sets.mjs [URL] [--shots DIR]
//
// Exits 1 if any check fails. Needs playwright (NODE_PATH=/opt/node-tools/node_modules
// in the cloud containers) and Chromium (CHROMIUM, default the pre-installed one).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch {
  try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright-core'); }
}
const { chromium } = pw;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
if (shots) mkdirSync(shots, { recursive: true });

const STATIC = ['drafting', 'classic', 'vapor', 'aurora', 'clay', 'swiss', 'brutal', 'riso', 'pixel', 'paper'];
const LIVE = ['pearl', 'foil', 'glass'];
const LIVE_CHUNK = /\/assets\/(iconset-gl|iconset-glass|three)-[\w-]+\.js/;

/** Before any page script: count WebGL contexts, animation frames, layout shifts, long frames, dock pointer listeners */
function probes() {
  const P = window.__probe = { gl: [], raf: 0, cls: 0, loaf: [], dockPointer: 0 };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const c = getContext.call(this, type, ...rest);
    if (c && /webgl/.test(type) && !P.gl.includes(c)) P.gl.push(c);
    return c;
  };
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { P.raf++; return raf.call(window, cb); };
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const isDock = (t) => t instanceof Element && t.classList.contains('sd-dock');
  EventTarget.prototype.addEventListener = function (type, ...rest) { if (isDock(this) && /^pointer(move|leave)$/.test(type)) P.dockPointer++; return add.call(this, type, ...rest); };
  EventTarget.prototype.removeEventListener = function (type, ...rest) { if (isDock(this) && /^pointer(move|leave)$/.test(type)) P.dockPointer--; return remove.call(this, type, ...rest); };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.loaf.push({ start: e.startTime, end: e.startTime + e.duration, duration: e.duration }); }).observe({ type: 'long-animation-frame', buffered: true }); } catch {}
}

const state = (page) => page.evaluate((re) => {
  const P = window.__probe;
  return {
    set: document.querySelector('.sd-dock')?.dataset.iconset,
    liveGl: P.gl.filter(c => !c.isContextLost()).length,
    allGl: P.gl.length,
    dockPointer: P.dockPointer,
    chunks: performance.getEntriesByType('resource').map(r => r.name).filter(n => new RegExp(re).test(n)).map(n => n.split('/').pop()),
  };
}, LIVE_CHUNK.source);

/** Animation frames requested over `ms` with nothing else going on */
const rafOver = async (page, ms = 1000) => {
  const a = await page.evaluate(() => window.__probe.raf);
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => window.__probe.raf)) - a;
};

const dockBox = (page) => page.$eval('.sd-dock', (d) => { const r = d.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => Math.round(v * 10) / 10); });

async function swapTo(page, id) {
  return page.evaluate(async (id) => {
    const P = window.__probe;
    const cls0 = P.cls;
    const t0 = performance.now();
    await window.__shiroDesktopCtx.setIconSet(id);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = performance.getEntriesByName('shiro:iconset:swap-start').pop()?.startTime ?? 0;
    const e = performance.getEntriesByName('shiro:iconset:swap-end').pop()?.startTime ?? performance.now();
    // During the crossfade: frames that start once it has begun. Before it, a live set
    // loads its chunk and compiles its shaders (reported, not judged: no GPU here)
    const long = P.loaf.filter(f => f.start >= s && f.start < e && f.duration > 50).map(f => Math.round(f.duration));
    const prep = P.loaf.filter(f => f.start >= t0 && f.start < s && f.duration > 50).map(f => Math.round(f.duration));
    return { cls: P.cls - cls0, long, prep, ms: Math.round(e - s) };
  }, id);
}

async function boot(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  await page.addInitScript(probes);
  await page.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); } catch {} });
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.terminal && window.__shiroDesktopCtx && !document.querySelector('.sd-booting'), null, { timeout: 60_000 });
  await page.waitForTimeout(1500); // boot settles (fonts, restore, first idle work)
  return { ctx, page };
}

// WebGL through SwiftShader where there is no GPU, but the page composited as usual:
// --use-angle=swiftshader would composite through software GL too, where even a
// dock hover takes 100–270 ms frames and no long-frame check means anything
const browser = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

// ── default + zero cost ──
{
  const { ctx, page } = await boot(browser);
  let s = await state(page);
  const tiles = await page.$$eval('.sd-dock > .sd-dock-item', els => els.map(e => !!e.querySelector(':scope > .sd-ic')));
  check('default is Drafting', s.set === 'drafting' && tiles.length > 0 && tiles.every(Boolean), `set ${s.set}, ${tiles.filter(Boolean).length}/${tiles.length} glyph tiles`);
  const idleRaf = await rafOver(page);
  check('static set: no live chunk, no WebGL, no frames, no dock pointer listeners', !s.chunks.length && !s.allGl && !idleRaf && !s.dockPointer,
    `chunks [${s.chunks}], contexts ${s.allGl}, frames ${idleRaf}/s, listeners ${s.dockPointer}`);
  await page.evaluate(() => window.__shiroDesktop.openApp('settings', { pane: 'dock' }));
  await page.waitForSelector('.sd-iconset-card[data-set=glass]');
  await page.waitForTimeout(600);
  s = await state(page);
  check('Settings → Dock & Icons previews are stills', !s.chunks.length && !s.allGl, `chunks [${s.chunks}], contexts ${s.allGl}`);
  await page.keyboard.press('Alt+Shift+W').catch(() => {});
  await ctx.close();
}

// ── swap through every set ──
{
  const { ctx, page } = await boot(browser);
  const box0 = await dockBox(page);
  for (const id of [...STATIC.slice(1), ...LIVE, 'drafting']) {
    const r = await swapTo(page, id);
    const box = await dockBox(page);
    const same = box.every((v, i) => Math.abs(v - box0[i]) <= .5);
    // A live set's every frame is shaded on the CPU without a GPU (SwiftShader): the swap
    // may not add frames longer than that set's own steady frames (none, on a GPU)
    let budget = 50, steady = [];
    if (LIVE.includes(id)) {
      steady = await page.evaluate(async () => {
        const t0 = performance.now();
        await new Promise(r => setTimeout(r, 1000));
        return window.__probe.loaf.filter(f => f.start > t0).map(f => Math.round(f.duration));
      });
      budget = Math.max(50, ...steady) * 1.25;
    }
    const over = r.long.filter(d => d > budget);
    check(`swap to ${id}`, r.cls === 0 && same && !over.length,
      `CLS ${r.cls.toFixed(4)}, dock ${same ? 'unchanged' : `[${box0}] → [${box}]`}, long frames [${r.long}]${steady.length ? ` (steady [${steady}])` : ''}, ${r.ms} ms${r.prep.length ? `; preparing: [${r.prep}]` : ''}`);
  }
  await ctx.close();
}

// ── live sets: they animate, pause, and leave nothing behind ──
{
  const { ctx, page } = await boot(browser);
  for (const id of LIVE) {
    await swapTo(page, id);
    let s = await state(page);
    const frames = await rafOver(page, 800);
    const drawn = await page.$$eval('.sd-dock canvas.sd-ic-live', cs => cs.length);
    // Holo foil and Liquid glass follow the pointer; Pearl doesn't listen. Software GL draws glass slowly.
    const wantPointer = id !== 'pearl';
    check(`${id} is live`, s.liveGl === 1 && frames > 3 && drawn > 0 && (s.dockPointer > 0) === wantPointer, `contexts ${s.liveGl}, frames ${frames}/0.8s, canvases ${drawn}, pointer listeners ${s.dockPointer}`);
    // A hidden tab stops the loop
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenFrames = await rafOver(page, 600);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    check(`${id} pauses while the tab is hidden`, hiddenFrames <= 1, `${hiddenFrames} frames`);
    if (shots) await (await page.$('.sd-dock')).screenshot({ path: join(shots, `iconsets-dock-${id}.png`) });
    await swapTo(page, 'drafting');
    s = await state(page);
    const after = await rafOver(page);
    check(`leaving ${id} tears it down`, s.liveGl === 0 && after === 0 && s.dockPointer === 0 && !(await page.$('.sd-dock canvas')), `live contexts ${s.liveGl}, frames ${after}/s, listeners ${s.dockPointer}`);
  }
  await ctx.close();
}

// ── reduced motion: a live set draws one still frame ──
{
  const { ctx, page } = await boot(browser, { reducedMotion: 'reduce' });
  await swapTo(page, 'pearl');
  const frames = await rafOver(page, 800);
  const drawn = await page.$$eval('.sd-dock canvas.sd-ic-live', cs => cs.length);
  check('reduced motion: Pearl is a still', frames <= 1 && drawn > 0, `${frames} frames, canvases ${drawn}`);
  await ctx.close();
}

// ── persistence ──
{
  const { ctx, page } = await boot(browser);
  await swapTo(page, 'swiss');
  await page.reload();
  await page.waitForFunction(() => window.__shiroDesktopCtx && !document.querySelector('.sd-booting'), null, { timeout: 60_000 });
  const s = await state(page);
  check('the choice persists', s.set === 'swiss' && !s.chunks.length, `after reload: ${s.set}`);
  await ctx.close();
}

// ── Drafting in light and dark (screenshots) ──
if (shots) {
  for (const scheme of ['light', 'dark']) {
    const { ctx, page } = await boot(browser, { colorScheme: scheme, deviceScaleFactor: 2 });
    await (await page.$('.sd-dock')).screenshot({ path: join(shots, `iconsets-dock-drafting-${scheme}.png`) });
    await ctx.close();
  }
}

await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
