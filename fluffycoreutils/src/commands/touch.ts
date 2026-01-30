import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const touch: FluffyCommand = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(args, io) {
    const { positional, flags } = parseArgs(args);

    if (positional.length === 0) {
      return { stdout: "", stderr: "touch: missing operand\n", exitCode: 1 };
    }

    const noCreate = flags.c;

    try {
      for (const p of positional) {
        const resolved = io.fs.resolvePath(p, io.cwd);

        let exists = false;
        try {
          await io.fs.stat(resolved);
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
          await io.fs.writeFile(resolved, "");
        } else {
          // File exists — update timestamp by rewriting content
          // Note: Virtual FS may not support timestamp-only updates
          const content = await io.fs.readFile(resolved);
          await io.fs.writeFile(resolved, content);
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `touch: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
