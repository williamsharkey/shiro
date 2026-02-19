
import type { Command } from './index';
import { parseArgs, readFileText, statEntry } from './flags';
export const touch: Command = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(ctx) {
    const args = ctx.args;
    const { positional, flags } = parseArgs(args);

    if (positional.length === 0) {
      ctx.stderr += "touch: missing operand\n";
      return 1;
    }

    const noCreate = flags.c;

    try {
      for (const p of positional) {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);

        let exists = false;
        try {
          await statEntry(ctx.fs, resolved);
          exists = true;
        } catch {
          exists = false;
        }

        if (!exists) {
          if (noCreate) {
            // -c flag: don't create file
            continue;
          }
          // Create empty file
          await ctx.fs.writeFile(resolved, "");
        } else {
          // File exists — update timestamp by rewriting content
          // Note: Virtual FS may not support timestamp-only updates
          const content = await readFileText(ctx.fs, resolved);
          await ctx.fs.writeFile(resolved, content);
        }
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `touch: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
