
import type { Command } from './index';
import { parseArgs, statEntry } from './flags';
export const which: Command = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    const showAll = flags.a;

    if (positional.length === 0) {
      ctx.stderr += "which: missing argument\n";
      return 1;
    }

    const commandName = positional[0];
    const pathEnv = ctx.env.PATH || "/bin:/usr/bin:/usr/local/bin";
    const paths = pathEnv.split(":");
    const found: string[] = [];

    // Search for the command in PATH directories
    for (const dir of paths) {
      const cmdPath = `${dir}/${commandName}`;
      try {
        const exists = await ctx.fs.exists(cmdPath);
        if (exists) {
          const stat = await statEntry(ctx.fs, cmdPath);
          // Check if it's a file (executable check would require mode bits)
          if (stat.type === "file") {
            found.push(cmdPath);
            if (!showAll) break;
          }
        }
      } catch {
        // Directory might not exist, continue searching
        continue;
      }
    }

    if (found.length === 0) {
      ctx.stderr += `which: no ${commandName} in (${pathEnv})\n`;
      return 1;
    }

    ctx.stdout += found.join("\n") + "\n";
    return 0;
  },
};
