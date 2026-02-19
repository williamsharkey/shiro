
import type { Command } from './index';
export const basename: Command = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(ctx) {
    const args = ctx.args;
    if (args.length === 0) {
      ctx.stderr += "basename: missing operand\n";
      return 1;
    }
    let name = args[0].replace(/\/+$/, "").split("/").pop() || "/";
    if (args.length > 1 && name.endsWith(args[1])) {
      name = name.slice(0, -args[1].length);
    }
    ctx.stdout += name + "\n";
    return 0;
  },
};
