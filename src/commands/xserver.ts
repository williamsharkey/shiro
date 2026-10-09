import type { Command } from './index';
import { getKernel } from '../kernel/kernel';

/**
 * xserver — the in-page X11 display (src/x11, docs/GUI.md).
 *
 *   xserver [status]        display, process, clients and windows
 *   xserver start [:N]      start display :N (boot starts :0)
 *   xserver stop [:N]       stop listening (connected clients keep running)
 */
export const xserverCmd: Command = {
  name: 'xserver',
  description: 'In-page X11 display server (Xshiro): status, start, stop',
  async exec(ctx) {
    const { startDisplay, getDisplay } = await import('../x11/display');
    const sub = ctx.args[0] ?? 'status';
    const n = parseInt((ctx.args[1] ?? ':0').replace(/^:/, ''), 10) || 0;
    if (sub === 'start') {
      const h = await startDisplay(getKernel(), n);
      ctx.stdout += `Xshiro :${n} listening on /tmp/.X11-unix/X${n} (pid ${h.proc.pid})\n`;
      return 0;
    }
    if (sub === 'stop') {
      const h = getDisplay(n);
      if (!h) { ctx.stderr += `xserver: display :${n} is not running\n`; return 1; }
      h.stop();
      ctx.stdout += `Xshiro :${n} stopped\n`;
      return 0;
    }
    if (sub !== 'status' && sub !== 'windows') {
      ctx.stderr += 'usage: xserver [status|start [:N]|stop [:N]]\n';
      return 2;
    }
    const h = getDisplay(n);
    if (!h) { ctx.stdout += `display :${n}: not running (xserver start :${n})\n`; return 1; }
    ctx.stdout += `display :${n}: Xshiro pid ${h.proc.pid}, socket /tmp/.X11-unix/X${n}, ${h.connections} connection(s) since start\n`;
    const { peekXSession } = await import('../x11/session');
    const s = await peekXSession(n);
    if (!s) { ctx.stdout += 'server: idle (loads on the first client)\n'; return 0; }
    ctx.stdout += `server: ${s.server.width}x${s.server.height}, ${s.server.clients.size} client(s), extensions: ${[...s.server.extensions.keys()].join(' ')}\n`;
    for (const w of s.rootless?.windows() ?? []) {
      ctx.stdout += `  0x${w.id.toString(16)}  ${w.width}x${w.height}+${w.x}+${w.y}  ${w.mapped ? 'mapped  ' : 'unmapped'}  ${w.title}\n`;
    }
    return 0;
  },
};
