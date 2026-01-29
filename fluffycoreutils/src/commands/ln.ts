import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const ln: FluffyCommand = {
  name: "ln",
  description: "Make links between files",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const symbolic = flags.s;

    if (positional.length < 2) {
      return { stdout: "", stderr: "ln: missing operand\n", exitCode: 1 };
    }

    const src = io.fs.resolvePath(positional[0], io.cwd);
    const dst = io.fs.resolvePath(positional[1], io.cwd);

    try {
      if (symbolic && io.fs.symlink) {
        // Use real symlink if the host supports it
        await io.fs.symlink(src, dst);
      } else {
        // Fall back to copy (virtual FS may not support symlinks)
        const content = await io.fs.readFile(src);
        await io.fs.writeFile(dst, content);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `ln: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
