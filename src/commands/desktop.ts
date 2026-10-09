import type { Command } from './index';
import { UI_MODE_KEY } from '../ui-mode';

/**
 * desktop                 switch this page to the desktop (reloads)
 * desktop classic         back to the full-page terminal
 * desktop open APP [ARG…] open an app's window (terminal, files, settings, activity, …)
 * desktop windows         list windows: id, app, state, title
 */
export const desktopCmd: Command = {
  name: 'desktop',
  description: 'Desktop: open apps, list windows, switch UI mode',
  async exec(ctx) {
    const d = (globalThis as any).__shiroDesktop as import('../desktop/wm').DesktopAPI | undefined;
    const [sub, ...rest] = ctx.args;
    const reload = (mode: string) => {
      try { localStorage.setItem(UI_MODE_KEY, mode); } catch {}
      setTimeout(() => location.reload(), 50);
    };
    if (!sub) {
      if (d) { ctx.stdout += 'This page is already the desktop. Try: desktop open files, desktop windows, desktop classic\n'; return 0; }
      ctx.stdout += 'Switching to the desktop…\n';
      reload('desktop');
      return 0;
    }
    if (sub === 'classic' || sub === 'terminal') {
      ctx.stdout += 'Switching to the classic terminal…\n';
      reload('terminal');
      return 0;
    }
    if (!d) { ctx.stderr += `desktop: not running a desktop (run 'desktop' to switch)\n`; return 1; }
    if (sub === 'open') {
      const app = rest[0];
      if (!app) { ctx.stdout += d.apps().map(a => a.id).join('\n') + '\n'; return 0; }
      if (!d.apps().some(a => a.id === app)) { ctx.stderr += `desktop: no app '${app}'\n`; return 1; }
      const args: Record<string, unknown> = {};
      if (app === 'files' && rest[1]) args.path = ctx.fs.resolvePath(rest[1], ctx.cwd);
      if (app === 'terminal') { if (rest.length > 1) args.command = rest.slice(1).join(' '); else args.cwd = ctx.cwd; }
      if (app === 'settings' && rest[1]) args.pane = rest[1];
      const w = await d.openApp(app, args);
      if (w) ctx.stdout += w.id + '\n';
      return 0;
    }
    if (sub === 'windows' || sub === 'ls') {
      for (const w of d.windows()) ctx.stdout += `${w.id}\t${w.appId ?? '-'}\t${w.state}\t${w.title}\n`;
      return 0;
    }
    ctx.stderr += `desktop: unknown subcommand '${sub}'\nusage: desktop [classic | open APP [ARG...] | windows]\n`;
    return 2;
  },
};
