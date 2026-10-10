/**
 * The GLX extension as libglvnd needs it from the X server when every GL
 * call goes to glshiro (docs/research/GL.md): present, QueryVersion 1.4, and
 * QueryServerString naming the vendor library (GLX_VENDOR_NAMES_EXT), so
 * glvnd loads libGLX_tabcomputer. Other GLX requests are BadRequest.
 */
import { XError, type XServer } from '../x11/server';

const GLX_VENDOR_NAMES_EXT = 0x20f6;

export function installGLX(server: XServer): void {
  if (server.extensions.has('GLX')) return;
  const reply = (server as unknown as { reply(c: unknown, data: number, w: unknown): void }).reply.bind(server);
  server.addExtension('GLX', 17, 13, (c, minor, r) => {
    if (minor === 7) { reply(c, 0, c.writer().u32(1).u32(4).zero(16)); return; } // QueryVersion
    if (minor === 19) { // QueryServerString
      r.u32();
      const name = r.u32();
      const s = name === GLX_VENDOR_NAMES_EXT || name === 1 ? 'tabcomputer' : name === 2 ? '1.4' : '';
      const b = new TextEncoder().encode(`${s}\0`);
      reply(c, 0, c.writer().u32(0).u32(b.length).zero(16).bytes(b).pad());
      return;
    }
    throw new XError(1 /* BadRequest */, 0);
  });
}
