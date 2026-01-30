import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const which: FluffyCommand = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const showAll = flags.a;

    if (positional.length === 0) {
      return { stdout: "", stderr: "which: missing argument\n", exitCode: 1 };
    }

    const commandName = positional[0];
    const pathEnv = io.env.PATH || "/bin:/usr/bin:/usr/local/bin";
    const paths = pathEnv.split(":");
    const found: string[] = [];

    // Search for the command in PATH directories
    for (const dir of paths) {
      const cmdPath = `${dir}/${commandName}`;
      try {
        const exists = await io.fs.exists(cmdPath);
        if (exists) {
          const stat = await io.fs.stat(cmdPath);
          // Check if it's a file (executable check would require mode bits)
          if (stat.type === "file") {
            found.push(cmdPath);
            if (!showAll) break;
          }
        }
      } catch {
        // Directory might not exist, continue searching
        continue;
      }
    }

    if (found.length === 0) {
      return {
        stdout: "",
        stderr: `which: no ${commandName} in (${pathEnv})\n`,
        exitCode: 1
      };
    }

    return {
      stdout: found.join("\n") + "\n",
      stderr: "",
      exitCode: 0
    };
  },
};
