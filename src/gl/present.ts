/**
 * A glshiro connection's backend: a WebGL2 context, the executor, and how
 * frames reach the X window. Until Xshiro offers a canvas over a GL window,
 * frames are read back and drawn into the window's pixels (like PutImage),
 * so Xshiro composes them with everything else.
 */
import { Executor, type ExecHost, type Present } from './exec';
import type { Backend } from './server';
import { MSG_FRAME } from './wire';
import { peekXSession } from '../x11/session';
import type { XServer } from '../x11/server';
import { Painter, defaultGC } from '../x11/raster';

function webgl2(): WebGL2RenderingContext {
  const attrs: WebGLContextAttributes = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false };
  let gl: WebGL2RenderingContext | null = null;
  if (typeof OffscreenCanvas !== 'undefined') gl = new OffscreenCanvas(1, 1).getContext('webgl2', attrs) as WebGL2RenderingContext | null;
  if (!gl && typeof document !== 'undefined') gl = document.createElement('canvas').getContext('webgl2', attrs);
  if (!gl) throw new Error('this browser has no WebGL2: GL apps need it');
  return gl;
}

/** Draws RGBA pixels (bottom row first) into an X window, as the app's frame. */
export function drawIntoWindow(server: XServer, xid: number, f: Present): void {
  if (!f.pixels) return;
  let d;
  try { d = server.drawable(xid); } catch { return; }
  const w = Math.min(f.width, d.pix.width), h = Math.min(f.height, d.pix.height);
  const src = new Uint32Array(f.pixels.buffer, f.pixels.byteOffset, f.width * f.height);
  const rows = new Uint32Array(w * h);
  const alpha = d.depth === 32 ? 0 : 0xff000000;
  for (let y = 0; y < h; y++) {
    const s = (f.height - 1 - y) * f.width;
    for (let x = 0; x < w; x++) {
      const v = src[s + x]; // bytes R G B A → 0xAABBGGRR
      rows[y * w + x] = (((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff) | (alpha || (v & 0xff000000))) >>> 0;
    }
  }
  const p = new Painter(d.pix, defaultGC());
  p.copyRows(0, 0, w, h, rows, w, 0);
  p.finish();
}

/**
 * Paces the guest to the page's frames: frame acks wait for the next
 * animation frame, and libGLX_tabcomputer stops at its swap once it's
 * MAX_FRAMES_AHEAD frames ahead. A hidden tab gets no animation frames, so
 * its GL apps wait instead of rendering frames nobody sees. Other messages
 * go at once.
 */
export function pacedSend(send: (data: Uint8Array) => void, nextFrame: (cb: () => void) => void): (data: Uint8Array) => void {
  let held: Uint8Array[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const h = held;
    held = [];
    for (const m of h) send(m);
  };
  return (data) => {
    if (data.length < 4 || new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) !== MSG_FRAME) { send(data); return; }
    held.push(data);
    if (!scheduled) { scheduled = true; nextFrame(flush); }
  };
}

export async function createWebGLBackend(rawSend: (data: Uint8Array) => void): Promise<Backend> {
  const send = typeof requestAnimationFrame === 'function' ? pacedSend(rawSend, (cb) => requestAnimationFrame(() => cb())) : rawSend;
  const gl = webgl2();
  const session = await peekXSession(0);
  const xs = session ? (await session).server : null;
  const host: ExecHost = {
    send,
    presentMode: 'async-pixels',
    drawableSize(xid) {
      if (!xs) return null;
      try {
        const d = xs.drawable(xid);
        return d.win ? { width: d.win.width, height: d.win.height } : { width: d.pix.width, height: d.pix.height };
      } catch { return null; }
    },
    present(xid, frame) { if (xs) drawIntoWindow(xs, xid, frame); },
    log: (m) => console.warn(m),
  };
  const ex = new Executor(gl, host);
  return {
    run: (b) => ex.run(b),
    close: () => { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
    commands: () => ex.executed,
    frames: () => ex.frames,
  };
}
