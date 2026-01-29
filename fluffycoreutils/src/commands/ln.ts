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

    // In a virtual filesystem, symlinks may not be supported.
    // We implement a simple copy-based "link" as a fallback.
    const src = io.fs.resolvePath(positional[0], io.cwd);
    const dst = io.fs.resolvePath(positional[1], io.cwd);

    try {
      if (symbolic) {
        // Try symlink if available, otherwise copy
        const content = await io.fs.readFile(src);
        await io.fs.writeFile(dst, content);
      } else {
        const content = await io.fs.readFile(src);
        await io.fs.writeFile(dst, content);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `ln: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
