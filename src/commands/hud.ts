import { Command } from './index';

export const hudCmd: Command = {
  name: 'hud',
  description: 'Draw the HUD (heads-up display) at current position',
  async exec(ctx) {
    if (!ctx.terminal) {
      ctx.stderr = 'Terminal not available\n';
      return 1;
    }
    (ctx.terminal as any).drawHud?.();
    return 0;
  },
};
