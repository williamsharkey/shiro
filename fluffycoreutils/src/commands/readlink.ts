import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const readlink: FluffyCommand = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const canonicalize = flags.f;

    if (positional.length === 0) {
      return { stdout: "", stderr: "readlink: missing operand\n", exitCode: 1 };
    }

    const resolved = io.fs.resolvePath(positional[0], io.cwd);

    if (canonicalize) {
      // -f: canonicalize, resolving all symlinks
      try {
        if (io.fs.readlink) {
          const target = await io.fs.readlink(resolved);
          // Resolve relative symlink targets
          const dir = resolved.split("/").slice(0, -1).join("/") || "/";
          const canonical = target.startsWith("/") ? target : io.fs.resolvePath(target, dir);
          return { stdout: canonical + "\n", stderr: "", exitCode: 0 };
        }
      } catch {
        // Not a symlink, just return resolved path
      }
      return { stdout: resolved + "\n", stderr: "", exitCode: 0 };
    }

    // Without -f, readlink only prints symlink target
    try {
      if (io.fs.readlink) {
        const target = await io.fs.readlink(resolved);
        return { stdout: target + "\n", stderr: "", exitCode: 0 };
      }
    } catch {
      // Not a symlink
    }
    return { stdout: "", stderr: `readlink: ${positional[0]}: not a symbolic link\n`, exitCode: 1 };
  },
};
