
import type { Command } from './index';
export const whoami: Command = {
  name: "whoami",
  description: "Print current user name",
  async exec(ctx) {
    const user = ctx.env.USER ?? ctx.env.USERNAME ?? "user";
    ctx.stdout += user + "\n";
    return 0;
  },
};
