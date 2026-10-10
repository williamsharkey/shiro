/**
 * Turns on GL for an X session when the page has WebGL2 (docs/research/GL.md):
 * Xshiro gets the GLX extension naming the tabcomputer vendor, and the guest
 * gets libGLX_tabcomputer.so.0 where libglvnd looks for it. Without WebGL2
 * neither happens and GL apps get Mesa (llvmpipe), the slow fallback.
 */
import type { Kernel } from '../kernel/kernel';
import type { XServer } from '../x11/server';
import { installGLX } from './glx-ext';

export const VENDOR_LIBRARY = '/usr/lib/x86_64-linux-gnu/libGLX_tabcomputer.so.0';

let webgl2: boolean | null = null;
/** Whether this page can make a WebGL2 context (checked once). */
export function webgl2Available(): boolean {
  if (webgl2 !== null) return webgl2;
  webgl2 = false;
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1)
      : typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null | undefined;
    if (gl) { webgl2 = true; gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  } catch { /* none */ }
  return webgl2;
}

function baseUrl(): string {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  return (globalThis as { location?: { href: string } }).location?.href ?? 'http://localhost/';
}

/** Writes the vendor library into the guest's filesystem (fetched from gui/lib, rewritten when it changed). */
export async function installVendorLibrary(kernel: Kernel, fetchLib: () => Promise<Uint8Array | null> = defaultFetch): Promise<boolean> {
  const fs = kernel.fs;
  if (!fs) return false;
  const lib = await fetchLib().catch(() => null);
  if (!lib) return fs.exists(VENDOR_LIBRARY).catch(() => false);
  const have = await fs.readFile(VENDOR_LIBRARY).catch(() => null) as Uint8Array | null;
  if (!have || have.length !== lib.length || have.some((b, i) => b !== lib[i])) {
    await fs.mkdir(VENDOR_LIBRARY.slice(0, VENDOR_LIBRARY.lastIndexOf('/')), { recursive: true }).catch(() => {});
    await fs.writeFile(VENDOR_LIBRARY, lib, { mode: 0o755 });
  }
  return true;
}

async function defaultFetch(): Promise<Uint8Array | null> {
  // X clients wait for this: don't let a stuck request hold them
  const r = await fetch(new URL('gui/lib/libGLX_tabcomputer.so.0', baseUrl()).href, { signal: AbortSignal.timeout(15_000) });
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

const prepared = new WeakMap<XServer, Promise<boolean>>();
/** Once per X server, before its first client is served: GLX and the vendor library, if WebGL2 is there. */
export function prepareGL(kernel: Kernel, server: XServer, available = webgl2Available()): Promise<boolean> {
  let p = prepared.get(server);
  if (!p) {
    p = available
      ? installVendorLibrary(kernel).then((ok) => { if (ok) installGLX(server); return ok; }).catch(() => false)
      : Promise.resolve(false);
    prepared.set(server, p);
  }
  return p;
}
