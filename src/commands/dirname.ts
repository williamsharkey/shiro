
import type { Command } from './index';
export const dirname: Command = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(ctx) {
    const args = ctx.args;
    if (args.length === 0) {
      ctx.stderr += "dirname: missing operand\n";
      return 1;
    }
    const path = args[0].replace(/\/+$/, "");
    const lastSlash = path.lastIndexOf("/");
    const result = lastSlash === -1 ? "." : lastSlash === 0 ? "/" : path.slice(0, lastSlash);
    ctx.stdout += result + "\n";
    return 0;
  },
};
