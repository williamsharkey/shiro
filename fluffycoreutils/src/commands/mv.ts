import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const mv: FluffyCommand = {
  name: "mv",
  description: "Move or rename files",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    if (positional.length < 2) {
      return { stdout: "", stderr: "mv: missing operand\n", exitCode: 1 };
    }

    const dest = io.fs.resolvePath(positional[positional.length - 1], io.cwd);
    const sources = positional.slice(0, -1);

    let destIsDir = false;
    try {
      const stat = await io.fs.stat(dest);
      destIsDir = stat.type === "dir";
    } catch { /* doesn't exist */ }

    if (sources.length > 1 && !destIsDir) {
      return { stdout: "", stderr: "mv: target is not a directory\n", exitCode: 1 };
    }

    try {
      for (const src of sources) {
        const srcResolved = io.fs.resolvePath(src, io.cwd);
        const name = src.split("/").pop()!;
        const target = destIsDir ? dest + "/" + name : dest;
        await io.fs.rename(srcResolved, target);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `mv: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
