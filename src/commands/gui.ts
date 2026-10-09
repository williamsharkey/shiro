import type { Command, CommandContext } from './index';
import { getKernel } from '../kernel/kernel';

/**
 * gui — Linux GUI apps from Debian, streamed on first use (src/gui/apps.ts, docs/GUI.md).
 *
 *   gui [list]               apps, download size to first launch, installed or not
 *   gui install APP...       fetch and unpack an app's packages
 *   gui APP [ARGS...]        install if needed, then start it on the display (background)
 *   gui run APP [ARGS...]    same
 *   gui info APP             packages, sizes, what was left out
 */
export const guiCmd: Command = {
  name: 'gui',
  description: 'Linux GUI apps (xterm, GTK, Qt) from Debian, streamed on first use',
  async exec(ctx) {
    const apps = await import('../gui/apps');
    const kernel = getKernel();
    const [sub = 'list', ...rest] = ctx.args;
    const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
    const err = (s: string) => { if (ctx.streamStderr) ctx.streamStderr(s); else ctx.stderr += s; };
    let m;
    try { m = await apps.guiManifest(); } catch (e) { err(`gui: ${(e as Error).message}\n`); return 1; }
    const mb = (b: number) => (b / 1e6).toFixed(1) + ' MB';
    if (sub === 'list' || sub === 'ls') {
      out(`${'APP'.padEnd(12)} ${'TOOLKIT'.padEnd(7)} ${'FIRST RUN'.padStart(9)}  INSTALLED  DESCRIPTION\n`);
      for (const [name, a] of Object.entries(m.apps)) {
        const inst = await apps.isAppInstalled(ctx.fs, name);
        out(`${name.padEnd(12)} ${a.toolkit.padEnd(7)} ${mb(a.size).padStart(9)}  ${inst ? 'yes' : 'no '}        ${a.description}\n`);
      }
      out(`\nDebian ${m.suite} ${m.arch}; packages are shared between apps and cached by sha256.\n`);
      return 0;
    }
    if (sub === 'info') {
      const a = m.apps[rest[0]];
      if (!a) { err(`gui: no app named ${rest[0]}\n`); return 1; }
      out(`${rest[0]}: ${a.description} (${a.toolkit}), runs ${a.bin}\n`);
      out(`first run: ${a.packages.length} packages, ${mb(a.size)} (full Debian closure ${mb(a.closureSize)})\n`);
      out(`packages: ${a.packages.join(' ')}\n`);
      if (a.dropped.length) out(`left out (not needed to start): ${a.dropped.join(' ')}\n`);
      return 0;
    }
    if (sub === 'install') {
      for (const name of rest) if (await install(ctx, name, out, err) !== 0) return 1;
      return 0;
    }
    const name = sub === 'run' ? rest.shift() : sub;
    if (!name || !m.apps[name]) { err(`gui: no app named ${name ?? ''} (gui list)\n`); return 1; }
    if (!(await apps.isAppInstalled(ctx.fs, name)) && await install(ctx, name, out, err) !== 0) return 1;
    const t0 = Date.now();
    const p = await apps.launchApp(kernel, name, rest);
    out(`${name} started (pid ${p.pid}) on display :0\n`);
    void p.exited.then((st) => {
      if (st !== 0) console.warn(`[gui] ${name} exited with status ${st >> 8 || st} after ${Date.now() - t0} ms:\n${p.output().slice(-2000)}`);
    });
    return 0;
  },
};

async function install(ctx: CommandContext, name: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const apps = await import('../gui/apps');
  let last = 0;
  try {
    const r = await apps.installApp(ctx.fs, getKernel(), name, (p) => {
      if (p.phase === 'unpack' && (Date.now() - last > 1000 || p.done === p.total)) {
        last = Date.now();
        out(`\r${name}: ${p.done}/${p.total} packages, ${(p.bytes / 1e6).toFixed(1)}/${(p.totalBytes / 1e6).toFixed(1)} MB`);
      }
    }, (s) => out(`\n${s}`));
    out(`\n${name}: installed ${r.packages - r.skipped} packages (${r.fetched} downloaded, ${(r.bytes / 1e6).toFixed(1)} MB; ${r.cached} from cache; ${r.skipped} already there) in ${(r.ms.total / 1000).toFixed(1)} s\n`);
    return 0;
  } catch (e) {
    err(`\ngui: ${name}: ${(e as Error).message}\n`);
    return 1;
  }
}
