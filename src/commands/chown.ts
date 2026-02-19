
import type { Command } from './index';
import { parseArgs } from './flags';
export const chown: Command = {
  name: "chown",
  description: "Change file owner and group",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);

    if (positional.length < 2) {
      ctx.stderr += "chown: missing operand\n";
      return 1;
    }

    const ownerGroup = positional[0];
    const targets = positional.slice(1);
    const recursive = flags.R;
    const verbose = flags.v;

    // Parse owner:group
    const parts = ownerGroup.split(":");
    const owner = parts[0] || null;
    const group = parts[1] || null;

    const output: string[] = [];

    try {
      // In browser environment, chown is a no-op (no actual file ownership)
      // We just acknowledge the command for script compatibility

      for (const target of targets) {
        if (verbose) {
          output.push(`ownership of '${target}' retained as ${ownerGroup}`);
        }
      }

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `chown: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
