import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const realpath: FluffyCommand = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);

    if (positional.length === 0) {
      return { stdout: "", stderr: "realpath: missing operand\n", exitCode: 1 };
    }

    const quiet = flags.q || flags.quiet;
    const canonicalize = !flags.s; // -s means don't canonicalize (default is to canonicalize)
    const noSymlinks = flags.s;

    const results: string[] = [];
    const errors: string[] = [];

    for (const path of positional) {
      try {
        // Resolve the path
        let resolved = io.fs.resolvePath(path, io.cwd);

        // Normalize the path
        if (canonicalize) {
          // Remove redundant separators and resolve . and ..
          const parts = resolved.split("/").filter(p => p !== "" && p !== ".");
          const canonical: string[] = [];

          for (const part of parts) {
            if (part === "..") {
              if (canonical.length > 0) {
                canonical.pop();
              }
            } else {
              canonical.push(part);
            }
          }

          resolved = "/" + canonical.join("/");
        }

        // Verify the path exists
        if (await io.fs.exists(resolved)) {
          results.push(resolved);
        } else {
          if (!quiet) {
            errors.push(`realpath: ${path}: No such file or directory`);
          }
        }
      } catch (e: unknown) {
        if (!quiet) {
          errors.push(`realpath: ${path}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    const stderr = errors.length > 0 ? errors.join("\n") + "\n" : "";
    const exitCode = errors.length > 0 ? 1 : 0;

    return {
      stdout: results.join("\n") + (results.length > 0 ? "\n" : ""),
      stderr,
      exitCode
    };
  },
};
