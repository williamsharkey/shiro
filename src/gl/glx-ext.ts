/**
 * The GLX extension as libglvnd needs it from the X server when every GL
 * call goes to glshiro (docs/research/GL.md): present, QueryVersion 1.4, and
 * QueryServerString naming the vendor library (GLX_VENDOR_NAMES_EXT, with
 * GLX_EXT_libglvnd among the extensions), so glvnd loads libGLX_tabcomputer,
 * and GetDrawableAttributes, which glvnd uses to find a drawable's screen
 * (and so its vendor). Other GLX requests are BadRequest.
 */
import { XError, type XServer } from '../x11/server';

const GLX_VENDOR_NAMES_EXT = 0x20f6;
const GLX_SCREEN = 0x800c, GLX_WIDTH = 0x801d, GLX_HEIGHT = 0x801e;
const GLXBadDrawable = 2;

export function installGLX(server: XServer): void {
  if (server.extensions.has('GLX')) return;
  const reply = (server as unknown as { reply(c: unknown, data: number, w: unknown): void }).reply.bind(server);
  const ext = server.addExtension('GLX', 17, 13, (c, minor, r) => {
    if (minor === 7) { reply(c, 0, c.writer().u32(1).u32(4).zero(16)); return; } // QueryVersion
    if (minor === 19) { // QueryServerString
      r.u32();
      const name = r.u32();
      // glvnd asks for the vendor only from a server whose GLX extensions include GLX_EXT_libglvnd
      const s = name === GLX_VENDOR_NAMES_EXT || name === 1 ? 'tabcomputer' : name === 2 ? '1.4' : name === 3 ? 'GLX_EXT_libglvnd' : '';
      const b = new TextEncoder().encode(`${s}\0`);
      reply(c, 0, c.writer().u32(0).u32(b.length).zero(16).bytes(b).pad());
      return;
    }
    if (minor === 29) { // GetDrawableAttributes
      const id = r.u32();
      let d;
      try { d = server.drawable(id); } catch { throw new XError(ext.firstError + GLXBadDrawable, id); }
      const w = d.win ? d.win.width : d.pix.width, h = d.win ? d.win.height : d.pix.height;
      reply(c, 0, c.writer().u32(3).zero(20).u32(GLX_SCREEN).u32(0).u32(GLX_WIDTH).u32(w).u32(GLX_HEIGHT).u32(h));
      return;
    }
    throw new XError(1 /* BadRequest */, 0);
  });
}
