import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const mkdir: FluffyCommand = {
  name: "mkdir",
  description: "Make directories",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const parents = flags.p;

    if (positional.length === 0) {
      return { stdout: "", stderr: "mkdir: missing operand\n", exitCode: 1 };
    }

    try {
      for (const p of positional) {
        const resolved = io.fs.resolvePath(p, io.cwd);
        await io.fs.mkdir(resolved, { recursive: parents });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `mkdir: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
