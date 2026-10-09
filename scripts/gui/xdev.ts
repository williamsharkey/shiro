/**
 * Development harness: run Shiro's in-page X server (src/x11) under Node on
 * a real Unix socket so native X clients can be tried against it quickly.
 *
 *   node_modules/.bin/esbuild scripts/gui/xdev.ts --bundle --platform=node --format=esm --outfile=/tmp/xdev.mjs
 *   node /tmp/xdev.mjs 9 &           # DISPLAY=:9
 *   DISPLAY=:9 xeyes
 *
 * Commands on stdin, one JSON per line:
 *   {"shot": "/tmp/out.png"}      every mapped toplevel side by side, as PNG
 *   {"move": [x, y]}  {"button": [1, true]}  {"key": "KeyA"}  {"type": "hello\n"}
 *   {"list": true}                toplevels with titles
 */
import { createServer } from 'node:net';
import { unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { XServer, type XWindow } from '../../src/x11/server';
import { composeTop } from '../../src/x11/compose';
import { installRender } from '../../src/x11/render';

const display = process.argv[2] ?? '9';
const path = `/tmp/.X11-unix/X${display}`;
mkdirSync('/tmp/.X11-unix', { recursive: true });
try { unlinkSync(path); } catch { /* none */ }

const server = new XServer({ width: 1280, height: 800 });
installRender(server);
server.log = (s) => console.error(s);
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
}).listen(path, () => console.error(`listening on ${path}`));

function title(w: XWindow): string {
  const p = server.prop(w, '_NET_WM_NAME') ?? server.prop(w, 'WM_NAME');
  return p ? Buffer.from(p.data).toString('utf8') : '';
}

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
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function shot(file: string): void {
  const list = [...tops].filter((w) => w.mapped);
  const W = Math.max(1, list.reduce((a, w) => a + w.width + 8, 0)), H = Math.max(1, ...list.map((w) => w.height));
  const all = new Uint8Array(W * H * 4).fill(0x40);
  let x0 = 0;
  for (const w of list) {
    const buf = { data: new Uint8ClampedArray(w.width * w.height * 4), width: w.width, height: w.height };
    composeTop(w, buf, { x: 0, y: 0, w: w.width, h: w.height });
    for (let y = 0; y < w.height; y++) all.set(buf.data.subarray(y * w.width * 4, (y + 1) * w.width * 4), (y * W + x0) * 4);
    x0 += w.width + 8;
  }
  writeFileSync(file, png(W, H, all));
  console.error(`shot ${file} ${W}x${H}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let cmd: any;
  try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.shot) shot(cmd.shot);
  if (cmd.list) for (const w of tops) console.error(`0x${w.id.toString(16)} ${w.x},${w.y} ${w.width}x${w.height} mapped=${w.mapped} "${title(w)}"`);
  if (cmd.move) server.movePointer(cmd.move[0], cmd.move[1]);
  if (cmd.button) server.button(cmd.button[1], cmd.button[0]);
  if (cmd.key) { const kc = server.keymap.keycodeForCode(cmd.key); server.key(true, kc); server.key(false, kc); }
  if (cmd.type) for (const ch of cmd.type as string) {
    const k = server.keymap.keycodeForChar(ch);
    if (k.remapped) server.mappingNotify(1, k.keycode, 1);
    if (k.shift) server.key(true, 50);
    server.key(true, k.keycode); server.key(false, k.keycode);
    if (k.shift) server.key(false, 50);
  }
});
