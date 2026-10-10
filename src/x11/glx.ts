/**
 * The GLX extension, as much of it as GL needs from the X server when every
 * GL call goes to glshiro instead (libGLX_tabcomputer, docs/research/GL.md):
 * the extension exists (glvnd's glXQueryExtension asks), QueryVersion says
 * 1.4, and QueryServerString names the vendor library for each screen
 * (GLX_VENDOR_NAMES_EXT, how glvnd picks one without
 * __GLX_VENDOR_LIBRARY_NAME), the vendor and the version. ClientInfo and
 * SetClientInfo* are accepted; QueryExtensionsString is empty. Rendering
 * requests (CreateContext, MakeCurrent, Render, ...) are BadRequest: Mesa's
 * own GLX can't use this server.
 *
 * Off until glshiro is up on a page with WebGL2 (it calls enableGLX()): with
 * GLX advertised and no usable vendor, glvnd falls back to Mesa, whose first
 * rendering request is an X error that Xlib's default handler exits on.
 * Without GLX, apps see "no GLX" and fall back as before. `glxEnabled()`
 * also decides the apps' GL environment (src/gui/apps.ts), set before their
 * first X connection.
 */
import * as P from './proto';
import { XError, type XServer } from './server';

const enum Req {
  QueryVersion = 7, QueryExtensionsString = 18, QueryServerString = 19, ClientInfo = 20,
  SetClientInfoARB = 33, SetClientInfo2ARB = 35,
}
const GLX_VENDOR = 1, GLX_VERSION = 2, GLX_VENDOR_NAMES_EXT = 0x20f6;
/** The glvnd vendor name: libGLX_<name>.so.0 */
export const GLX_VENDOR_NAME = 'tabcomputer';

export function installGLX(server: XServer): void {
  if (server.extensions.has('GLX')) return;
  const str = (c: Parameters<XServer['reply']>[0], s: string) => {
    const b = new TextEncoder().encode(`${s}\0`);
    server.reply(c, 0, c.writer(32 + b.length + 3).u32(0).u32(b.length).zero(16).bytes(b).pad());
  };
  // Xorg's event and error counts
  server.addExtension('GLX', 17, 13, (c, minor, r) => {
    switch (minor) {
      case Req.QueryVersion: server.reply(c, 0, c.writer().u32(1).u32(4).zero(16)); return;
      case Req.QueryServerString: {
        r.u32(); // screen
        const name = r.u32();
        str(c, name === GLX_VENDOR || name === GLX_VENDOR_NAMES_EXT ? GLX_VENDOR_NAME : name === GLX_VERSION ? '1.4' : '');
        return;
      }
      case Req.QueryExtensionsString: r.u32(); str(c, ''); return;
      case Req.ClientInfo: case Req.SetClientInfoARB: case Req.SetClientInfo2ARB: return;
      default: throw new XError(P.BadRequest, 0);
    }
  });
}

let enabled = false;
const servers = new Set<XServer>();

/** Sessions (session.ts) register their server: GLX is installed now or when enabled. */
export function glxServer(server: XServer): void {
  servers.add(server);
  if (enabled) installGLX(server);
}

/** glshiro is serving GL (WebGL2 available): advertise GLX on every display. */
export function enableGLX(): void {
  enabled = true;
  for (const s of servers) installGLX(s);
}

/** Apps get libGLX_tabcomputer and __GLX_VENDOR_LIBRARY_NAME (apps.ts). */
export const glxEnabled = (): boolean => enabled;

/** Tests. */
export function resetGLX(): void { enabled = false; servers.clear(); }
