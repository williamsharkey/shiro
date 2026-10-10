// GL in the page (docs/research/GL.md): glxgears through Blink, libGLX_tabcomputer,
// glshiro and WebGL2, into an Xshiro window on the desktop. Prints glxgears' FPS,
// glshiro's frame and command rates, and checks the window shows gears; then stops
// animation frames (what a hidden tab does) and checks the app stops rendering.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   GL_PROBE_ROOT=DIR node tests/browser/gl-glxgears.mjs [URL] [--seconds N] [--json FILE]
//
// GL_PROBE_ROOT is an x86-64 rootfs with mesa-utils' glxgears and libglvnd
// (libGL.so.1, libGLX.so.0, libGLdispatch.so.0) and their libraries, without
// Mesa's vendor library: see tests/tests/shiro-vitest/gl-guest.test.ts. The page
// gets libGLX_tabcomputer itself (src/gl/setup.ts). Chromium runs WebGL2 on
// SwiftShader here, so the FPS is a CPU renderer's. Exits 1 on failure.
import { createRequire } from 'node:module';
import { readdirSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
for (const m of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright']) { try { ({ chromium } = require(m)); break; } catch { /* next */ } }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const seconds = Number(opt('--seconds') ?? 12);
const jsonOut = opt('--json');
const url = args[0] ?? 'http://localhost:5299/';
const root = process.env.GL_PROBE_ROOT;
if (!root) { console.error('GL_PROBE_ROOT is not set'); process.exit(2); }
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** The rootfs as [path, base64 | {link}] without docs, locales and gconv */
function collect(host, guest, out) {
  for (const n of readdirSync(host)) {
    const h = join(host, n), g = `${guest}/${n}`;
    if (/^\/(lib|lib64|bin)$/.test(g)) continue; // usrmerge links: the page has its own
    if (/^\/usr\/share\/(man|doc|locale|info|lintian|bug)|\/gconv$/.test(g)) continue;
    const st = lstatSync(h);
    if (st.isSymbolicLink()) out.push([g, { link: readlinkSync(h) }]);
    else if (st.isDirectory()) collect(h, g, out);
    else out.push([g, readFileSync(h).toString('base64'), st.mode & 0o777]);
  }
  return out;
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const result = {};
try {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.kernel && window.__tabcomputer.desktop, null, { timeout: 90_000 });
  check(await page.evaluate(() => !!new OffscreenCanvas(1, 1).getContext('webgl2')), 'the page has WebGL2');

  // the rootfs, a few files per call; /lib and /lib64 as real directories (the page's may exist)
  const files = collect(root, '', []).map(([p, d, m]) => [p.replace(/^\/(lib|lib64|bin)\//, '/usr/$1/'), d, m]);
  const t0 = Date.now();
  for (let i = 0; i < files.length; i += 40) {
    await page.evaluate(async (batch) => {
      const fs = window.__tabcomputer.fs;
      for (const [p, d, mode] of batch) {
        await fs.mkdir(p.slice(0, p.lastIndexOf('/')) || '/', { recursive: true }).catch(() => {});
        if (typeof d === 'object') { await fs.symlink(d.link, p).catch(() => {}); continue; }
        await fs.writeFile(p, Uint8Array.from(atob(d), (c) => c.charCodeAt(0)), { mode });
      }
    }, files.slice(i, i + 40));
  }
  await page.evaluate(async () => {
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/lib64', { recursive: true }).catch(() => {});
    if (!(await fs.exists('/lib64/ld-linux-x86-64.so.2'))) await fs.writeFile('/lib64/ld-linux-x86-64.so.2', await fs.readFile('/usr/lib64/ld-linux-x86-64.so.2'), { mode: 0o755 });
  });
  console.log(`rootfs: ${files.length} files in ${Date.now() - t0} ms`);

  // glxgears from a shell, in the background; its output collects in the page
  await page.evaluate((cmd) => {
    window.__glOut = '';
    const s = window.__tabcomputer.shell.fork();
    s.cwd = '/';
    window.__glDone = s.execute(cmd, (x) => { window.__glOut += x; }, (x) => { window.__glOut += x; });
  }, process.env.GL_CMD ?? '/usr/bin/glxgears.x86_64-linux-gnu');
  const tStart = Date.now();
  await page.waitForFunction(() => window.__tabcomputer.desktop.windows().some((w) => /gears/i.test(w.title) && w.surface) || /Error/.test(window.__glOut), null, { timeout: 180_000 });
  result.windowMs = Date.now() - tStart;
  console.log(`glxgears window after ${result.windowMs} ms`);
  check(await page.evaluate(() => window.__tabcomputer.gl()?.clients.size === 1), 'glshiro has one GL client');
  const stats = () => page.evaluate(() => { const c = [...window.__tabcomputer.gl().clients][0]; return { frames: c?.frames() ?? 0, commands: c?.commands() ?? 0, t: performance.now() }; });
  await page.waitForTimeout(2000);
  const a = await stats();
  await page.waitForTimeout(seconds * 1000);
  const b = await stats();
  const dt = (b.t - a.t) / 1000;
  result.fps = (b.frames - a.frames) / dt;
  result.commandsPerSecond = (b.commands - a.commands) / dt;
  const out = await page.evaluate(() => window.__glOut);
  result.glxgears = [...out.matchAll(/= ([\d.]+) FPS/g)].map((m) => Number(m[1]));
  console.log(`glshiro: ${result.fps.toFixed(1)} frames/s, ${Math.round(result.commandsPerSecond)} commands/s; glxgears says ${result.glxgears.join(', ') || '(nothing yet)'} FPS`);
  check(result.fps > 5, 'frames keep coming');

  // the window shows the three gears: red, green and blue pixels
  const colors = await page.evaluate(() => {
    const w = window.__tabcomputer.desktop.windows().find((w) => /gears/i.test(w.title) && w.surface);
    const c = w.surface.canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const n = { red: 0, green: 0, blue: 0 };
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (r > 100 && g < 60 && b < 60) n.red++; else if (g > 100 && r < 60 && b < 60) n.green++; else if (b > 100 && r < 60 && g < 60) n.blue++;
    }
    // glxgears clears to black: the frame covers the whole window
    const at = (x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
    return { ...n, size: [c.width, c.height], corners: [at(1, 1), at(c.width - 2, 1), at(1, c.height - 2), at(c.width - 2, c.height - 2)] };
  });
  console.log(`window pixels: ${JSON.stringify(colors)}`);
  check(colors.corners.every((p) => p.every((v) => v < 30)), 'the frame fills the window');
  check(colors.red > 100 && colors.green > 100 && colors.blue > 100, 'the window shows red, green and blue gears');
  await page.screenshot({ path: process.env.GL_SHOT ?? '/tmp/gl-glxgears.png' });

  // no animation frames (a hidden tab): the app stops at its swap within a few frames
  // like a hidden tab: callbacks wait, and run once frames come back
  await page.evaluate(() => { window.__raf = window.requestAnimationFrame; window.__held = []; window.requestAnimationFrame = (cb) => { window.__held.push(cb); return 0; }; });
  await page.waitForTimeout(1000);
  const h1 = await stats();
  await page.waitForTimeout(3000);
  const h2 = await stats();
  result.hiddenFrames = h2.frames - h1.frames;
  console.log(`without animation frames: ${result.hiddenFrames} frames in 3 s`);
  check(result.hiddenFrames <= 3, 'no frames pile up without animation frames');
  await page.evaluate(() => { window.requestAnimationFrame = window.__raf; for (const cb of window.__held) window.__raf(cb); });
  await page.waitForTimeout(2000);
  const r1 = await stats();
  await page.waitForTimeout(2000);
  const r2 = await stats();
  check(r2.frames - r1.frames > 5, 'frames resume with animation frames');
} catch (e) {
  console.log(`FAIL ${e.message}`);
  failed++;
} finally {
  if (errors.length) console.log(`page errors: ${errors.slice(0, 5).join(' | ')}`);
  const out = await page.evaluate(() => window.__glOut).catch(() => '');
  if (failed) {
    console.log(`glxgears output:\n${out}`);
    const diag = await page.evaluate(async () => ({
      glx: window.__shiroX ? window.__shiroX.server.extensions.has('GLX') : 'no X session',
      vendorLibrary: await window.__tabcomputer.fs.exists('/usr/lib/x86_64-linux-gnu/libGLX_tabcomputer.so.0'),
      glshiro: window.__tabcomputer.gl() ? window.__tabcomputer.gl().connections : 'not running',
    })).catch((e) => e.message);
    console.log(`diagnostics: ${JSON.stringify(diag)}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));
  await browser.close();
}
process.exit(failed ? 1 : 0);
