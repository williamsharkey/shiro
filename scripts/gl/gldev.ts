/**
 * Development harness for GL forwarding without the browser app: Xshiro on
 * a real Unix socket (like scripts/gui/xdev.ts), glshiro's socket for
 * libGLX_tabcomputer, and the executor (src/gl/exec.ts) on WebGL2 in headless
 * Chromium. Native GL clients (glxinfo, glxgears) can then be run against it.
 *
 *   node_modules/.bin/esbuild scripts/gl/gldev.ts --bundle --platform=node --format=esm \
 *     --external:playwright-core --external:esbuild --outfile=/tmp/gldev.mjs
 *   node /tmp/gldev.mjs 9 /tmp/tcgl.sock &
 *   DISPLAY=:9 TABCOMPUTER_GL_SOCKET=/tmp/tcgl.sock __GLX_VENDOR_LIBRARY_NAME=tabcomputer \
 *     LD_LIBRARY_PATH=DIR_WITH_libGLX_tabcomputer.so.0 glxgears
 *
 * Commands on stdin, one JSON per line: {"shot": "/tmp/out.png"}, {"list": true}, {"stats": true}.
 */
import { createServer } from 'node:net';
import { unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XServer, type XWindow } from '../../src/x11/server';
import { installGLX } from '../../src/gl/glx-ext';
import { composeTop } from '../../src/x11/compose';
import { installRender } from '../../src/x11/render';
import { drawIntoWindow } from '../../src/gl/present';

const display = process.argv[2] ?? '9';
const glPath = process.argv[3] ?? '/tmp/tcgl.sock';
const root = process.env.TABCOMPUTER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '../..');
const xPath = `/tmp/.X11-unix/X${display}`;
mkdirSync('/tmp/.X11-unix', { recursive: true });
for (const p of [xPath, glPath]) { try { unlinkSync(p); } catch { /* none */ } }

const server = new XServer({ width: 1280, height: 800 });
installRender(server);
server.log = (s) => console.error(s);
installGLX(server);
const tops = new Set<XWindow>();
server.hooks = {
  topMapped: (w) => { tops.add(w); console.error(`map 0x${w.id.toString(16)} ${w.width}x${w.height}`); },
  topUnmapped: (w) => tops.delete(w),
  topDestroyed: (w) => tops.delete(w),
};
createServer((sock) => {
  const c = server.connect({ write: (d) => sock.write(d), close: () => sock.end() });
  sock.on('data', (d) => c.receive(new Uint8Array(d.buffer, d.byteOffset, d.length)));
  sock.on('close', () => server.disconnect(c));
  sock.on('error', () => server.disconnect(c));
}).listen(xPath, () => console.error(`X on ${xPath}`));

// ── the executor in Chromium ──
const { chromium } = await import('playwright-core');
const esbuild = await import('esbuild');
const bundle = await esbuild.build({
  stdin: {
    contents: `
      import { Executor } from './src/gl/exec';
      const conns = new Map();
      const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
      const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      globalThis.glOpen = (id) => {
        const st = { out: [], frames: [], sizes: {} };
        const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
        st.ex = new Executor(gl, {
          presentMode: 'pixels',
          send: (d) => st.out.push(b64(d)),
          drawableSize: (xid) => st.sizes[xid] ?? null,
          present: (xid, f) => st.frames.push({ xid, width: f.width, height: f.height, pixels: b64(f.pixels) }),
          log: (m) => console.log(m),
        });
        conns.set(id, st);
      };
      globalThis.glRun = (id, bytes, sizes) => {
        const st = conns.get(id);
        st.sizes = sizes;
        const t0 = performance.now();
        const ok = st.ex.run(unb64(bytes).buffer);
        const r = { ok, out: st.out, frames: st.frames, ms: performance.now() - t0, executed: st.ex.executed };
        st.out = []; st.frames = [];
        return r;
      };
    `,
    resolveDir: root, loader: 'ts',
  },
  bundle: true, write: false, format: 'iife', target: 'es2022',
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', (m) => console.error(`[page] ${m.text()}`));
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: bundle.outputFiles[0].text });
console.error(`GL on ${glPath}`);

let nextConn = 1;
const stats = { batches: 0, bytes: 0, frames: 0, pageMs: 0, executed: 0 };
createServer((sock) => {
  const id = nextConn++;
  let queue = Promise.resolve();
  let pending = Buffer.alloc(0);
  void page.evaluate((i) => (globalThis as unknown as { glOpen(i: number): void }).glOpen(i), id);
  sock.on('data', (d) => {
    pending = Buffer.concat([pending, d]);
    let off = 0;
    while (pending.length - off >= 12) {
      const len = pending.readUInt32LE(off + 8);
      if (pending.length - off < len) break;
      off += len;
    }
    if (!off) return;
    const chunk = pending.subarray(0, off);
    pending = pending.subarray(off);
    queue = queue.then(async () => {
      const sizes: Record<number, { width: number; height: number }> = {};
      for (const [rid, r] of (server as unknown as { resources: Map<number, { kind: string; value: unknown }> }).resources) {
        if (r.kind === 'window') { const w = r.value as XWindow; sizes[rid] = { width: w.width, height: w.height }; }
      }
      const r = await page.evaluate(([i, b, s]) => (globalThis as unknown as { glRun(i: number, b: string, s: unknown): unknown }).glRun(i as number, b as string, s), [id, chunk.toString('base64'), sizes] as const) as
        { ok: boolean; out: string[]; frames: { xid: number; width: number; height: number; pixels: string }[]; ms: number; executed: number };
      stats.batches++; stats.bytes += chunk.length; stats.pageMs += r.ms; stats.frames += r.frames.length; stats.executed = r.executed;
      for (const f of r.frames) drawIntoWindow(server, f.xid, { width: f.width, height: f.height, pixels: new Uint8Array(Buffer.from(f.pixels, 'base64')) });
      for (const o of r.out) sock.write(Buffer.from(o, 'base64'));
      if (!r.ok) sock.destroy();
    });
  });
  sock.on('error', () => {});
}).listen(glPath);

function png(width: number, height: number, rgba: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let cmd: Record<string, unknown>;
  try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.shot) {
    const list = [...tops];
    if (!list.length) { console.error('no windows'); return; }
    const w = list[list.length - 1];
    const buf = { data: new Uint8ClampedArray(w.width * w.height * 4), width: w.width, height: w.height };
    composeTop(w, buf, { x: 0, y: 0, w: w.width, h: w.height });
    writeFileSync(String(cmd.shot), png(w.width, w.height, new Uint8Array(buf.data.buffer)));
    console.error(`shot ${w.width}x${w.height} → ${cmd.shot}`);
  }
  if (cmd.list) for (const w of tops) console.error(`0x${w.id.toString(16)} ${w.width}x${w.height}`);
  if (cmd.stats) console.error(JSON.stringify(stats));
});
