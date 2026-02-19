
import type { Command } from './index';
import { parseArgs } from './flags';
export const type: Command = {
  name: "type",
  description: "Display information about command type",
  async exec(ctx) {
    const args = ctx.args;
    const { positional, flags } = parseArgs(args);

    if (positional.length === 0) {
      ctx.stderr += "type: missing operand\n";
      return 1;
    }

    const all = flags.a;
    const typeOnly = flags.t;
    const pathOnly = flags.p;

    const output: string[] = [];
    let exitCode = 0;

    for (const cmdName of positional) {
      // In a browser environment, we don't have actual shell builtins
      // This is a simplified version that checks if command exists in PATH

      const pathDirs = (ctx.env.PATH || "/bin:/usr/bin").split(":");
      let found = false;

      for (const dir of pathDirs) {
        const fullPath = dir + "/" + cmdName;
        try {
          const exists = await ctx.fs.exists(fullPath);
          if (exists) {
            found = true;
            if (typeOnly) {
              output.push("file");
            } else if (pathOnly) {
              output.push(fullPath);
            } else {
              output.push(`${cmdName} is ${fullPath}`);
            }

            if (!all) break;
          }
        } catch {
          // Ignore errors
        }
      }

      if (!found) {
        if (!typeOnly && !pathOnly) {
          output.push(`type: ${cmdName}: not found`);
        }
        exitCode = 1;
      }
    }

    ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
    return exitCode;
  },
};
