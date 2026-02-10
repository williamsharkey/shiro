import { Command } from './index';

/**
 * Spirit command — deprecated in favor of Claude Code (inner claude).
 * Use `claude` or `claude -p "prompt"` instead.
 */
export const spiritCmd: Command = {
  name: 'spirit',
  description: 'AI coding agent (deprecated — use claude instead)',
  async exec(ctx) {
    ctx.stdout = 'spirit: deprecated. Use `claude` or `claude -p "prompt"` instead.\n';
    return 1;
  },
};
