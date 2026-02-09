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

    // In virtual FS, just resolve the path
    const resolved = io.fs.resolvePath(positional[0], io.cwd);

    if (canonicalize) {
      return { stdout: resolved + "\n", stderr: "", exitCode: 0 };
    }

    // Without -f, readlink only works on symlinks (not supported in virtual FS)
    return { stdout: resolved + "\n", stderr: "", exitCode: 0 };
  },
};
