
import type { Command } from './index';
export const pwd: Command = {
  name: "pwd",
  description: "Print working directory",
  async exec(ctx) {
    ctx.stdout += ctx.cwd + "\n";
    return 0;
  },
};
