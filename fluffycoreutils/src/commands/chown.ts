import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const chown: FluffyCommand = {
  name: "chown",
  description: "Change file owner and group",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);

    if (positional.length < 2) {
      return { stdout: "", stderr: "chown: missing operand\n", exitCode: 1 };
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

      return {
        stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `chown: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
