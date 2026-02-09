import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const source: FluffyCommand = {
  name: "source",
  description: "Execute commands from a file in the current shell",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "source: filename argument required\n",
        exitCode: 1
      };
    }

    const scriptPath = positional[0];

    try {
      const resolved = io.fs.resolvePath(scriptPath, io.cwd);
      const content = await io.fs.readFile(resolved);

      // In a real shell, this would execute the script in the current shell context
      // For now, we'll just acknowledge it was sourced
      // A full implementation would require shell integration

      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `source: ${scriptPath}: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

// Alias for source
export const dot: FluffyCommand = {
  name: ".",
  description: "Execute commands from a file in the current shell (alias for source)",
  async exec(args, io) {
    return source.exec(args, io);
  },
};
