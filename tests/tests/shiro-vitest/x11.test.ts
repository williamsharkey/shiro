/**
 * In-page X server (src/x11, docs/GUI.md).
 *
 * 1. Protocol: a small TS client talks to XServer over an in-memory pipe:
 *    setup, windows, drawing, fonts, properties, input events, resize,
 *    selections, SHAPE, RENDER.
 * 2. Kernel path: a static x86-64 client (fixtures/x86/xclient.c, built with
 *    gcc in beforeAll) runs in Blink, connects to Xshiro :0 over the
 *    kernel's AF_UNIX socket, draws, gets a button press, resizes itself.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { XServer, type XWindow } from '@shiro/x11/server';
import { installRender } from '@shiro/x11/render';
import { composeTop } from '@shiro/x11/compose';
import { Writer, Reader, pad4 } from '@shiro/x11/proto';
import { lookupColor } from '@shiro/x11/colors';
import { openFont, listFonts } from '@shiro/x11/fonts';
import { createTestShell } from './helpers';

/** A raw-protocol client over an in-memory transport. */
class TC {
  seq = 0;
  inbox: Uint8Array[] = [];
  buf = new Uint8Array(0);
  base = 0;
  root = 0;
  private c;
  constructor(readonly server: XServer) {
    this.c = server.connect({ write: (d) => this.feed(d), close: () => {} });
  }
  private feed(d: Uint8Array) {
    const b = new Uint8Array(this.buf.length + d.length);
    b.set(this.buf); b.set(d, this.buf.length);
    this.buf = b;
  }
  async flush() { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); this.c.flush(); }
  async setup() {
    this.c.receive(new Uint8Array([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    await this.flush();
    const r = new Reader(this.buf);
    expect(r.u8()).toBe(1);
    r.skip(5);
    const extra = r.u16() * 4;
    const s = new Reader(this.buf.subarray(8, 8 + extra));
    s.skip(4); this.base = s.u32(); s.skip(8);
    const vlen = s.u16(); s.skip(2); s.u8(); const nf = s.u8();
    s.pos = 32 + pad4(vlen) + 8 * nf;
    this.root = s.u32();
    this.buf = this.buf.subarray(8 + extra);
    return this;
  }
  id(n: number) { return this.base | n; }
  /** Send a request: opcode, data byte, body words written by fill. */
  send(op: number, data: number, fill: (w: Writer) => void = () => {}) {
    const w = new Writer(64);
    w.u8(op).u8(data).u16(0);
    fill(w);
    w.pad();
    const out = w.done();
    new DataView(out.buffer).setUint16(2, out.length / 4, true);
    this.c.receive(out);
    this.seq++;
  }
  /** Pull all complete messages (replies, events, errors). */
  async messages(): Promise<Uint8Array[]> {
    await this.flush();
    const out: Uint8Array[] = [];
    let b = this.buf;
    while (b.length >= 32) {
      const len = b[0] === 1 ? 32 + new DataView(b.buffer, b.byteOffset).getUint32(4, true) * 4 : 32;
      if (b.length < len) break;
      out.push(b.slice(0, len));
      b = b.subarray(len);
    }
    this.buf = b;
    return out;
  }
  async reply(): Promise<Reader> {
    for (let i = 0; i < 10; i++) {
      const ms = await this.messages();
      const err = ms.find((m) => m[0] === 0);
      if (err) throw new Error(`X error ${err[1]} major ${err[10]}`);
      const rep = ms.find((m) => m[0] === 1);
      this.inbox.push(...ms.filter((m) => m[0] > 1));
      if (rep) return new Reader(rep);
    }
    throw new Error('no reply');
  }
  async events(code?: number): Promise<Uint8Array[]> {
    const ms = await this.messages();
    const all = [...this.inbox, ...ms.filter((m) => m[0] !== 1)];
    this.inbox = [];
    return code === undefined ? all : all.filter((m) => (m[0] & 0x7f) === code);
  }
}

function pixelAt(top: XWindow, x: number, y: number): number {
  const out = { data: new Uint8ClampedArray(top.width * top.height * 4), width: top.width, height: top.height };
  composeTop(top, out, { x: 0, y: 0, w: top.width, h: top.height });
  const i = (y * top.width + x) * 4;
  return (out.data[i] << 16) | (out.data[i + 1] << 8) | out.data[i + 2];
}

async function newServer() {
  const server = new XServer({ width: 1024, height: 768 });
  installRender(server);
  const tops: XWindow[] = [];
  server.hooks = { topMapped: (w) => tops.push(w) };
  const c = await new TC(server).setup();
  return { server, c, tops };
}

/** CreateWindow (InputOutput, white background, given event mask) and map it. */
function createWindow(c: TC, wid: number, x: number, y: number, w: number, h: number, mask: number) {
  c.send(1, 0, (q) => q.u32(wid).u32(c.root).i16(x).i16(y).u16(w).u16(h).u16(0).u16(1).u32(0).u32(0x2 | 0x800).u32(0xffffff).u32(mask));
}

describe('X11 protocol', () => {
  it('sets up a connection with one TrueColor screen', async () => {
    const { c } = await newServer();
    expect(c.root).toBe(0x100);
    expect(c.base).toBe(1 << 21);
    c.send(98, 0, (w) => w.u16(6).u16(0).str('RENDER'));        // QueryExtension
    const r = await c.reply();
    r.skip(8);
    expect(r.u8()).toBe(1);
  });

  it('maps a window, sends Expose, draws, and composes the pixels', async () => {
    const { c, tops } = await newServer();
    const wid = c.id(1), gc = c.id(2);
    createWindow(c, wid, 30, 40, 120, 80, 1 << 15);
    c.send(8, 0, (w) => w.u32(wid));
    const ex = await c.events(12);
    expect(ex.length).toBe(1);
    expect(new DataView(ex[0].buffer).getUint32(4, true)).toBe(wid);
    expect(tops.map((t) => t.id)).toEqual([wid]);
    c.send(55, 0, (w) => w.u32(gc).u32(wid).u32(0x4).u32(0x00ff00));            // CreateGC fg green
    c.send(70, 0, (w) => w.u32(wid).u32(gc).i16(10).i16(10).u16(20).u16(20));  // PolyFillRectangle
    c.send(43, 0);
    await c.reply();
    expect(pixelAt(tops[0], 15, 15)).toBe(0x00ff00);
    expect(pixelAt(tops[0], 5, 5)).toBe(0xffffff);
    expect(pixelAt(tops[0], 30, 30)).toBe(0xffffff);
  });

  it('round-trips PutImage/GetImage and copies areas', async () => {
    const { c } = await newServer();
    const pm = c.id(5), gc = c.id(6);
    c.send(53, 24, (w) => w.u32(pm).u32(c.root).u16(4).u16(2));               // CreatePixmap 4x2 depth 24
    c.send(55, 0, (w) => w.u32(gc).u32(pm).u32(0));
    const px = [0x112233, 0x445566, 0x778899, 0xaabbcc, 0x010203, 0x040506, 0x070809, 0x0a0b0c];
    c.send(72, 2, (w) => { w.u32(pm).u32(gc).u16(4).u16(2).i16(0).i16(0).u8(0).u8(24).u16(0); for (const p of px) w.u32(p); });
    c.send(62, 0, (w) => w.u32(pm).u32(pm).u32(gc).i16(0).i16(0).i16(2).i16(1).u16(2).u16(1)); // CopyArea row 0 cols 0-1 → (2,1)
    c.send(73, 2, (w) => w.u32(pm).i16(0).i16(0).u16(4).u16(2).u32(0xffffffff));
    const r = await c.reply();
    r.skip(32);
    const got = Array.from({ length: 8 }, () => r.u32() & 0xffffff);
    expect(got).toEqual([0x112233, 0x445566, 0x778899, 0xaabbcc, 0x010203, 0x040506, 0x112233, 0x445566]);
  });

  it('interns atoms, stores properties and notifies', async () => {
    const { c } = await newServer();
    const wid = c.id(1);
    createWindow(c, wid, 0, 0, 10, 10, 1 << 22);
    c.send(16, 0, (w) => w.u16(8).u16(0).str('_MY_PROP'));
    const atom = (await c.reply()).skip(8).u32();
    expect(atom).toBeGreaterThan(68);
    c.send(18, 0, (w) => w.u32(wid).u32(atom).u32(31).u8(8).zero(3).u32(5).str('hello'));
    c.send(18, 2, (w) => w.u32(wid).u32(atom).u32(31).u8(8).zero(3).u32(3).str(' xy'));
    c.send(20, 0, (w) => w.u32(wid).u32(atom).u32(0).u32(0).u32(100));
    const r = await c.reply();
    r.skip(8);
    expect(r.u32()).toBe(31);
    r.skip(4);
    const n = r.u32();
    r.skip(12);
    expect(r.str(n)).toBe('hello xy');
    expect((await c.events(28)).length).toBe(2);
  });

  it('delivers pointer and key events with coordinates, and implicit grabs', async () => {
    const { server, c, tops } = await newServer();
    const wid = c.id(1);
    createWindow(c, wid, 100, 50, 200, 100, (1 << 2) | (1 << 3) | (1 << 6) | (1 << 0) | (1 << 4));
    c.send(8, 0, (w) => w.u32(wid));
    c.send(42, 1, (w) => w.u32(wid).u32(0));        // SetInputFocus
    await c.events();
    server.movePointer(110, 70, tops[0]);
    server.button(true, 1);
    server.movePointer(400, 400, tops[0]);         // outside: still ours (implicit grab)
    server.button(false, 1);
    server.key(true, server.keymap.keycodeForCode('KeyA'));
    const evs = await c.events();
    const codes = evs.map((e) => e[0] & 0x7f);
    expect(codes).toContain(7);                    // EnterNotify
    const press = evs.find((e) => e[0] === 4)!;
    const dv = new DataView(press.buffer);
    expect(press[1]).toBe(1);
    expect([dv.getInt16(24, true), dv.getInt16(26, true)]).toEqual([10, 20]);
    const release = evs.find((e) => e[0] === 5)!;
    expect(new DataView(release.buffer).getInt16(24, true)).toBe(300);
    const key = evs.find((e) => e[0] === 2)!;
    expect(key[1]).toBe(38);                       // evdev KEY_A + 8
  });

  it('resizes with ConfigureWindow: ConfigureNotify, Expose, keeps NorthWest contents', async () => {
    const { c, tops } = await newServer();
    const wid = c.id(1), gc = c.id(2);
    createWindow(c, wid, 0, 0, 50, 50, (1 << 15) | (1 << 17));
    c.send(2, 0, (w) => w.u32(wid).u32(0x10).u32(1));   // bit gravity NorthWest
    c.send(8, 0, (w) => w.u32(wid));
    c.send(55, 0, (w) => w.u32(gc).u32(wid).u32(0x4).u32(0x0000ff));
    c.send(70, 0, (w) => w.u32(wid).u32(gc).i16(0).i16(0).u16(10).u16(10));
    c.send(12, 0, (w) => w.u32(wid).u16(0x0c).u16(0).u32(120).u32(90));
    const evs = await c.events();
    const conf = evs.find((e) => e[0] === 22)!;
    const dv = new DataView(conf.buffer);
    expect([dv.getUint16(20, true), dv.getUint16(22, true)]).toEqual([120, 90]);
    expect(evs.filter((e) => e[0] === 12).length).toBe(2);
    expect(tops[0].width).toBe(120);
    expect(pixelAt(tops[0], 5, 5)).toBe(0x0000ff);
    expect(pixelAt(tops[0], 100, 80)).toBe(0xffffff);
  });

  it('opens core fonts, answers QueryFont and draws ImageText8', async () => {
    expect(listFonts('fixed', 10)).toContain('fixed');
    expect(listFonts('-misc-fixed-medium-r-*--13-*-iso8859-1', 10).length).toBeGreaterThan(0);
    const f = openFont('fixed')!;
    expect(f.ascent + f.descent).toBe(13);
    const { c, tops } = await newServer();
    const wid = c.id(1), gc = c.id(2), fid = c.id(3);
    createWindow(c, wid, 0, 0, 100, 30, 0);
    c.send(8, 0, (w) => w.u32(wid));
    c.send(45, 0, (w) => w.u32(fid).u16(5).u16(0).str('fixed'));
    c.send(47, 0, (w) => w.u32(fid));
    const q = await c.reply();
    q.skip(8 + 12 + 4 + 12 + 4);
    expect(q.u16()).toBe(32);                      // min char
    c.send(55, 0, (w) => w.u32(gc).u32(wid).u32(0x4 | 0x8 | 0x4000).u32(0).u32(0xffffff).u32(fid));
    c.send(76, 2, (w) => w.u32(wid).u32(gc).i16(2).i16(15).str('Hi'));
    c.send(43, 0);
    await c.reply();
    let black = 0;
    for (let x = 2; x < 14; x++) for (let y = 4; y < 17; y++) if (pixelAt(tops[0], x, y) === 0) black++;
    expect(black).toBeGreaterThan(10);
  });

  it('transfers a selection between two clients', async () => {
    const { server, c } = await newServer();
    const c2 = await new TC(server).setup();
    const w1 = c.id(1), w2 = c2.id(1);
    createWindow(c, w1, 0, 0, 10, 10, 0);
    createWindow(c2, w2, 0, 0, 10, 10, 0);
    c.send(22, 0, (w) => w.u32(w1).u32(1).u32(0));                  // own PRIMARY
    c2.send(24, 0, (w) => w.u32(w2).u32(1).u32(31).u32(31).u32(0));  // convert to STRING
    const req = (await c.events(30))[0];
    expect(new DataView(req.buffer).getUint32(12, true)).toBe(w2);
  });

  it('shapes windows (SHAPE Rectangles) and clips composition', async () => {
    const { c, tops, server } = await newServer();
    const wid = c.id(1);
    createWindow(c, wid, 0, 0, 40, 40, 0);
    c.send(8, 0, (w) => w.u32(wid));
    const shape = server.extensions.get('SHAPE')!;
    c.send(shape.major, 1, (w) => w.u8(0).u8(0).u8(0).u8(0).u32(wid).i16(0).i16(0).i16(0).i16(0).u16(20).u16(20));
    await c.events();
    const out = { data: new Uint8ClampedArray(40 * 40 * 4), width: 40, height: 40 };
    composeTop(tops[0], out, { x: 0, y: 0, w: 40, h: 40 });
    expect(out.data[(5 * 40 + 5) * 4 + 3]).toBe(255);
    expect(out.data[(30 * 40 + 30) * 4 + 3]).toBe(0);
  });

  it('RENDER: fills, composites through an a8 mask, draws glyphs and trapezoids', async () => {
    const { c, tops, server } = await newServer();
    const R = server.extensions.get('RENDER')!.major;
    const wid = c.id(1), pic = c.id(2), gs = c.id(3), solid = c.id(4);
    createWindow(c, wid, 0, 0, 64, 64, 0);
    c.send(8, 0, (w) => w.u32(wid));
    c.send(R, 4, (w) => w.u32(pic).u32(wid).u32(0x31).u32(0));                       // CreatePicture x8r8g8b8
    c.send(R, 26, (w) => w.u8(1).zero(3).u32(pic).u16(0xffff).u16(0).u16(0).u16(0xffff).i16(0).i16(0).u16(8).u16(8)); // Src red
    c.send(R, 33, (w) => w.u32(solid).u16(0).u16(0).u16(0xffff).u16(0xffff));         // solid blue
    c.send(R, 17, (w) => w.u32(gs).u32(0x32));                                         // glyph set a8
    // one 4x2 glyph, fully opaque, origin at its top-left
    c.send(R, 20, (w) => w.u32(gs).u32(1).u32(65).u16(4).u16(2).i16(0).i16(0).i16(5).i16(0).bytes(new Uint8Array(8).fill(255)));
    c.send(R, 23, (w) => w.u8(3).zero(3).u32(solid).u32(pic).u32(0).u32(gs).i16(0).i16(0).u8(1).zero(3).i16(20).i16(20).u8(65).zero(3));
    // a 10x10 square as one trapezoid (16.16 fixed), half-transparent green
    const fx = (v: number) => v * 65536;
    const green = c.id(5);
    c.send(R, 33, (w) => w.u32(green).u16(0).u16(0x8000).u16(0).u16(0x8000));
    c.send(R, 10, (w) => w.u8(3).zero(3).u32(green).u32(pic).u32(0x32).i16(0).i16(0)
      .i32(fx(40)).i32(fx(50)).i32(fx(40)).i32(fx(40)).i32(fx(40)).i32(fx(50)).i32(fx(50)).i32(fx(40)).i32(fx(50)).i32(fx(50)));
    c.send(43, 0);
    await c.reply();
    expect(pixelAt(tops[0], 3, 3)).toBe(0xff0000);
    expect(pixelAt(tops[0], 21, 20)).toBe(0x0000ff);
    expect(pixelAt(tops[0], 30, 30)).toBe(0xffffff);
    const g = pixelAt(tops[0], 45, 45);
    expect(g >> 16).toBeGreaterThan(100);           // white at half under 50% green
    expect((g >> 8) & 0xff).toBe(255);
  });

  it('maps browser keys: physical codes, Shift synthesized for shifted characters, other layouts by character', async () => {
    const { Rootless } = await import('@shiro/x11/rootless');
    const { server, c } = await newServer();
    const rootless = new Rootless(server, { name: 'test', createCanvasWindow: () => { throw new Error('unused'); }, desktopSize: () => ({ width: 1024, height: 768 }) });
    const wid = c.id(1);
    createWindow(c, wid, 0, 0, 50, 50, 1 | 2);
    c.send(8, 0, (w) => w.u32(wid));
    c.send(42, 1, (w) => w.u32(wid).u32(0));
    await c.events();
    const keys = async () => (await c.events()).filter((e) => e[0] === 2 || e[0] === 3).map((e) => `${e[0] === 2 ? '+' : '-'}${e[1]}`);
    rootless.keyEvent(true, { code: 'KeyA', key: 'a' });
    rootless.keyEvent(false, { code: 'KeyA', key: 'a' });
    expect(await keys()).toEqual(['+38', '-38']);
    rootless.keyEvent(true, { code: 'Backslash', key: '|' });   // no Shift keydown came first
    rootless.keyEvent(false, { code: 'Backslash', key: '|' });
    expect(await keys()).toEqual(['+50', '+51', '-51', '-50']);
    rootless.keyEvent(true, { code: 'KeyY', key: 'z' });         // German layout: the char wins
    expect(await keys()).toEqual(['+52', '-52']);
    rootless.keyEvent(true, { code: '', key: 'é' });             // not on the keymap: a spare keycode
    const evs = await c.events();
    expect(evs.some((e) => e[0] === 34)).toBe(true);              // MappingNotify
    expect(server.keymap.keysyms(evs.find((e) => e[0] === 2)![1])[0]).toBe(0xe9);
  });

  it('bridges CLIPBOARD with the browser clipboard, both ways', async () => {
    const { ClipboardBridge } = await import('@shiro/x11/clipboard');
    const { server, c } = await newServer();
    let browser = 'from the browser ✓';
    const bridge = new ClipboardBridge(server, { readText: async () => browser, writeText: async (t) => { browser = t; } });
    server.hooks.selectionOwned = (sel, owner) => bridge.selectionOwned(sel, owner);
    const wid = c.id(1);
    createWindow(c, wid, 0, 0, 10, 10, 0);
    const atom = async (name: string) => { c.send(16, 0, (w) => w.u16(name.length).u16(0).str(name)); return (await c.reply()).skip(8).u32(); };
    const CLIPBOARD = await atom('CLIPBOARD'), UTF8 = await atom('UTF8_STRING'), PROP = await atom('MY_PASTE');

    // browser → X: the bridge owns CLIPBOARD after an X window gets focus; the app converts it
    bridge.focusIn();
    c.send(24, 0, (w) => w.u32(wid).u32(CLIPBOARD).u32(UTF8).u32(PROP).u32(0));
    for (let i = 0; i < 20 && !(await c.events(31).then((e) => (c.inbox.push(...e), e.length))); i++) await new Promise((r) => setTimeout(r, 5));
    c.inbox = [];
    c.send(20, 0, (w) => w.u32(wid).u32(PROP).u32(0).u32(0).u32(100));
    const r = await c.reply();
    r.skip(8); expect(r.u32()).toBe(UTF8); r.skip(4); const n = r.u32(); r.skip(12);
    expect(new TextDecoder().decode(r.bytes(n))).toBe('from the browser ✓');

    // X → browser: the app copies; it answers the bridge's SelectionRequest like any owner
    c.send(22, 0, (w) => w.u32(wid).u32(CLIPBOARD).u32(0));
    const pulled = bridge.pull();
    let req: Uint8Array | undefined;
    for (let i = 0; i < 50 && !req; i++) { req = (await c.events(30))[0]; if (!req) await new Promise((res) => setTimeout(res, 5)); }
    const dv = new DataView(req!.buffer);
    const requestor = dv.getUint32(12, true), prop = dv.getUint32(24, true);
    const text = new TextEncoder().encode('copied in an X app');
    c.send(18, 0, (w) => w.u32(requestor).u32(prop).u32(UTF8).u8(8).zero(3).u32(text.length).bytes(text));
    c.send(25, 0, (w) => w.u32(requestor).u32(0).u8(31).u8(0).u16(0).u32(0).u32(requestor).u32(CLIPBOARD).u32(UTF8).u32(prop).zero(8));
    expect(await pulled).toBe('copied in an X app');
    expect(browser).toBe('copied in an X app');
  });

  it('looks up X color names', () => {
    expect(lookupColor('red')).toBe(0xff0000);
    expect(lookupColor('Light Steel Blue')).toBe(0xb0c4de);
    expect(lookupColor('#123')).toBe(0x112233);
    expect(lookupColor('rgb:ff/80/00')).toBe(0xff8000);
    expect(lookupColor('nosuchcolor')).toBeNull();
  });
});

const FIX = resolve(__dirname, 'fixtures/x86');
const out = mkdtempSync(join(tmpdir(), 'shiro-x11-'));
const xclientBin = join(out, 'xclient');
let haveClient = false;
try {
  execFileSync('gcc', ['-static', '-O1', '-o', xclientBin, join(FIX, 'xclient.c')], { stdio: 'pipe', timeout: 120_000 });
  haveClient = true;
} catch { /* no gcc: skip the kernel path */ }

describe.skipIf(!haveClient)('X11 over the kernel: x86-64 client in Blink', () => {
  beforeAll(async () => {
    const { configureXSession } = await import('@shiro/x11/session');
    configureXSession({ headless: true, width: 1024, height: 768 });
  });

  it('connects to Xshiro :0, draws, receives a button press and resizes', async () => {
    const { fs } = await createTestShell();
    await fs.mkdir('/home/user/x', { recursive: true });
    await fs.writeFile('/home/user/x/xclient', readFileSync(xclientBin), { mode: 0o755 });
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { BufferFile } = await import('@shiro/kernel/fd');
    const { registerBlinkLoader } = await import('@shiro/x86-engine/blink');
    const { startDisplay } = await import('@shiro/x11/display');
    const { getXSession, resetXSession } = await import('@shiro/x11/session');
    resetXSession(0);
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    registerBlinkLoader(kernel);
    const display = await startDisplay(kernel, 0);
    expect(await fs.exists('/tmp/.X11-unix/X0')).toBe(true);
    const sess = await getXSession(0);
    const mapped: XWindow[] = [];
    sess.server.hooks = { topMapped: (w) => mapped.push(w) };
    const stdout = new BufferFile(null);
    const p = kernel.spawn({ path: '/home/user/x/xclient', argv: ['xclient'], cwd: '/home/user/x', env: { DISPLAY: ':0' }, fds: { 0: new BufferFile(''), 1: stdout, 2: stdout } });
    const until = async (cond: () => boolean, ms = 30_000) => {
      const t0 = Date.now();
      while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout; output: ' + stdout.text()); await new Promise((r) => setTimeout(r, 20)); }
    };
    await until(() => stdout.text().includes('drawn'));
    expect(mapped.length).toBe(1);
    const top = mapped[0];
    expect([top.width, top.height]).toEqual([200, 100]);
    expect(sess.server.prop(top, 'WM_NAME') && new TextDecoder().decode(sess.server.prop(top, 'WM_NAME')!.data)).toBe('xclient-test');
    expect(pixelAt(top, 20, 20)).toBe(0xff0000);
    expect(pixelAt(top, 100, 80)).toBe(0xffffff);
    sess.server.movePointer(top.x + 33, top.y + 44, top);
    sess.server.button(true, 1);
    sess.server.button(false, 1);
    expect(await p.wait()).toBe(0);
    expect(stdout.text()).toContain('button 1 at 33,44');
    expect(stdout.text()).toContain('configure 300x150');
    expect([top.width, top.height]).toEqual([300, 150]);
    display.stop();
  }, 120_000);
});
