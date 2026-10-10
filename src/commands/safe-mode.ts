/**
 * safe-mode: what safe mode skipped, and the resets that get a machine whose
 * saved state freezes the page booting normally again (src/safe-mode.ts).
 * Nothing is deleted: ~/.profile is renamed, and only restored-layout keys
 * leave localStorage.
 */
import type { Command } from './index';
import { RESTORED_STATE_KEYS, bootFinished, bootProblems, normalUrl, safeMode } from '../safe-mode';

const PROFILE = '/home/user/.profile';

export const safeModeCmd: Command = {
  name: 'safe-mode',
  description: 'Safe mode: what was skipped at boot, resets, and how to leave it',
  async exec(ctx) {
    const sub = ctx.args[0] ?? 'status';
    const out = (s: string) => { ctx.stdout += s + '\n'; };
    switch (sub) {
      case 'status': {
        const reason = safeMode();
        out(reason ? `Safe mode is on: ${reason}.` : 'Safe mode is off. Boot in safe mode with ?safe=1 in the address.');
        out(bootProblems.length ? `Boot steps that failed or hung:\n${bootProblems.map((p) => `  ${p}`).join('\n')}` : 'No boot step failed or hung.');
        out('Subcommands: reset-layout, disable-profile, exit');
        return 0;
      }
      case 'reset-layout': {
        const removed: string[] = [];
        for (const k of RESTORED_STATE_KEYS) {
          try { if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); removed.push(k); } } catch { /* no storage */ }
        }
        out(removed.length ? `Removed from localStorage: ${removed.join(', ')}` : 'No saved layout to remove.');
        return 0;
      }
      case 'disable-profile': {
        if (!(await ctx.fs.exists(PROFILE))) { out('There is no ~/.profile.'); return 0; }
        let to = `${PROFILE}.disabled`;
        for (let i = 2; await ctx.fs.exists(to); i++) to = `${PROFILE}.disabled.${i}`;
        await ctx.fs.rename(PROFILE, to);
        out(`Renamed ~/.profile to ~${to.slice('/home/user'.length)}; it no longer runs at boot (rename it back to restore it).`);
        return 0;
      }
      case 'exit': {
        bootFinished();
        if (typeof location === 'undefined') return 0;
        location.href = normalUrl(location.href);
        return 0;
      }
      default:
        ctx.stderr += `safe-mode: unknown subcommand '${sub}' (status, reset-layout, disable-profile, exit)\n`;
        return 2;
    }
  },
};
