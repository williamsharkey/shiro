import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const touch: FluffyCommand = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    if (positional.length === 0) {
      return { stdout: "", stderr: "touch: missing operand\n", exitCode: 1 };
    }

    try {
      for (const p of positional) {
        const resolved = io.fs.resolvePath(p, io.cwd);
        try {
          await io.fs.stat(resolved);
          // File exists — in a real FS we'd update mtime, but virtual FS may not support it.
          // Write same content to trigger mtime update if possible.
          const content = await io.fs.readFile(resolved);
          await io.fs.writeFile(resolved, content);
        } catch {
          // Doesn't exist — create empty file
          await io.fs.writeFile(resolved, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `touch: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
