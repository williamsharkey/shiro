// GL surfaces in the real desktop (src/x11/gl-surface.ts, docs/GUI.md): a
// canvas over an X window, the way glshiro shows WebGL2 frames. Opens xeyes,
// takes a surface for its window, paints it, and checks the screen: the
// paint shows exactly over the X window's content (not the title bar), it
// follows a resize, and releasing it shows the X pixels again. GLX stays off
// (no glshiro on this branch).
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/gl-surface.mjs [URL]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const url = process.argv[2] ?? 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

try {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__tabcomputer.desktop.apps().some((a) => a.id === 'xeyes'), null, { timeout: 60_000 });
  await page.evaluate(() => { void window.__tabcomputer.desktop.openApp('xeyes'); });
  await page.waitForFunction(() => window.__shiroX?.rootless?.windows().some((w) => w.mapped), null, { timeout: 300_000, polling: 200 });
  await page.waitForTimeout(1500);

  check(await page.evaluate(() => !window.__shiroX.server.extensions.has('GLX')), 'GLX is off without glshiro');

  const info = await page.evaluate(() => {
    const { server, rootless } = window.__shiroX;
    const top = rootless.windows().find((w) => w.mapped);
    const s = server.glSurface(top.id);
    window.__glTest = s;
    const ctx = s.canvas.getContext('2d');
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, s.width, s.height);
    const r = s.canvas.getBoundingClientRect();
    const body = s.canvas.parentElement.getBoundingClientRect();
    return { id: top.id, w: s.width, h: s.height, visible: s.visible, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, body: { x: body.x, y: body.y, w: body.width, h: body.height }, dpr: devicePixelRatio };
  });
  check(info.visible, `surface for 0x${info.id.toString(16)} is visible (${info.w}×${info.h})`);
  check(Math.abs(info.rect.x - info.body.x) < 1 && Math.abs(info.rect.y - info.body.y) < 1, `canvas at the content origin (${info.rect.x},${info.rect.y} vs body ${info.body.x},${info.body.y})`);
  check(Math.abs(info.rect.w - info.w / info.dpr) < 1 && Math.abs(info.rect.h - info.h / info.dpr) < 1, `canvas is the window's size (${info.rect.w}×${info.rect.h} CSS px)`);

  const pixel = async (x, y) => {
    const shot = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
    return page.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }, shot.toString('base64'));
  };
  const magenta = (p) => p[0] > 240 && p[1] < 16 && p[2] > 240;
  const mid = { x: info.rect.x + info.rect.w / 2, y: info.rect.y + info.rect.h / 2 };
  check(magenta(await pixel(mid.x, mid.y)), 'the paint shows over the window');
  check(!magenta(await pixel(info.body.x + 5, info.body.y - 10)), 'the title bar is not covered');

  // the app resizes its window: the surface follows
  const after = await page.evaluate(async (id) => {
    const { server } = window.__shiroX;
    const s = window.__glTest;
    let changed = 0;
    s.onChange(() => changed++);
    server.configure(server.winOrNull(id), { width: s.width + 40, height: s.height + 20 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = s.canvas.getBoundingClientRect();
    return { changed, w: s.width, h: s.height, cw: s.canvas.width, ch: s.canvas.height, css: r.width * devicePixelRatio };
  }, info.id);
  check(after.changed >= 1 && after.cw === after.w && after.ch === after.h && Math.abs(after.css - after.w) < 1, `follows a resize (${after.w}×${after.h}, ${after.changed} change)`);

  await page.evaluate(() => window.__glTest.release());
  await page.waitForTimeout(300);
  check(await page.evaluate(() => !document.querySelector('canvas[data-gl-surface]')), 'release removes the canvas');
  check(!magenta(await pixel(mid.x, mid.y)), 'the X pixels show again');

  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message).split('\n')[0]}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
