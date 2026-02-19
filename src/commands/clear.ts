
import type { Command } from './index';
export const clear: Command = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec(ctx) {
    ctx.stdout += "\x1b[2J\x1b[H";
    return 0;
  },
};
