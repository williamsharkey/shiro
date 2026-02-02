/**
 * favicon - Toggle dynamic favicon on/off
 *
 * The dynamic favicon shows a 32x32 pixel minimap of terminal content,
 * useful for identifying tabs when many are open or seeing agent activity.
 */

import type { Command } from './index';
import { setFaviconEnabled, isFaviconEnabled } from '../favicon';

export const faviconCmd: Command = {
  name: 'favicon',
  description: 'Toggle dynamic favicon minimap (on/off/status)',
  async exec(ctx) {
    const arg = ctx.args[0]?.toLowerCase();
    const term = (ctx as any).shell?.terminal?.term;

    if (arg === 'on') {
      setFaviconEnabled(true, term);
      ctx.stdout = 'Dynamic favicon enabled\n';
      return 0;
    }

    if (arg === 'off') {
      setFaviconEnabled(false, term);
      ctx.stdout = 'Dynamic favicon disabled\n';
      return 0;
    }

    if (arg === 'status' || !arg) {
      const status = isFaviconEnabled() ? 'enabled' : 'disabled';
      ctx.stdout = `Dynamic favicon: ${status}\n`;
      ctx.stdout += '\nUsage: favicon [on|off|status]\n';
      ctx.stdout += '\nThe favicon shows a 32x32 minimap of the last 32 lines of terminal output.\n';
      ctx.stdout += 'Each pixel represents one character, colored by its foreground color.\n';
      return 0;
    }

    ctx.stderr = `Unknown option: ${arg}\nUsage: favicon [on|off|status]\n`;
    return 1;
  }
};
