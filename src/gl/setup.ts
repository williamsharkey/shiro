/**
 * Turns on GL when the page has WebGL2 (docs/research/GL.md): the guest gets
 * libGLX_tabcomputer.so.0 where libglvnd looks for it, and Xshiro's GLX
 * (src/x11/glx.ts) is enabled, naming the tabcomputer vendor. Done before
 * Xshiro serves its first client, so programs started from a terminal find
 * both. Without WebGL2 neither happens and GL apps get Mesa (llvmpipe), the
 * slow fallback.
 */
import type { Kernel } from '../kernel/kernel';
import { enableGLX } from '../x11/glx';

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
  // missing, or not a library (a dev server's index.html): keep what's there
  if (!lib || lib[0] !== 0x7f || lib[1] !== 0x45 || lib[2] !== 0x4c || lib[3] !== 0x46) return fs.exists(VENDOR_LIBRARY).catch(() => false);
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

const prepared = new WeakMap<Kernel, Promise<boolean>>();
/** Once per kernel, before Xshiro's first client is served: the vendor library and GLX, if WebGL2 is there. */
export function prepareGL(kernel: Kernel, available = webgl2Available()): Promise<boolean> {
  let p = prepared.get(kernel);
  if (!p) {
    p = available
      ? installVendorLibrary(kernel).then((ok) => { if (ok) enableGLX(); return ok; }).catch(() => false)
      : Promise.resolve(false);
    prepared.set(kernel, p);
  }
  return p;
}
