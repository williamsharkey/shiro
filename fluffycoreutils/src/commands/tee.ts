import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const tee: FluffyCommand = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const append = flags.a;
    const input = io.stdin;

    try {
      for (const file of positional) {
        const resolved = io.fs.resolvePath(file, io.cwd);
        if (append) {
          let existing = "";
          try { existing = await io.fs.readFile(resolved); } catch { /* new file */ }
          await io.fs.writeFile(resolved, existing + input);
        } else {
          await io.fs.writeFile(resolved, input);
        }
      }
      return { stdout: input, stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: input, stderr: `tee: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
