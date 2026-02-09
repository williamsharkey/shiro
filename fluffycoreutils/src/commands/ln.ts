import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const ln: FluffyCommand = {
  name: "ln",
  description: "Make links between files",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const symbolic = flags.s;
    const force = flags.f;
    const verbose = flags.v;

    if (positional.length < 2) {
      return { stdout: "", stderr: "ln: missing operand\n", exitCode: 1 };
    }

    const src = io.fs.resolvePath(positional[0], io.cwd);
    const dst = io.fs.resolvePath(positional[1], io.cwd);

    const output: string[] = [];

    try {
      // Check if destination exists
      if (await io.fs.exists(dst)) {
        if (force) {
          // Remove existing destination
          try {
            await io.fs.unlink(dst);
          } catch {
            // Ignore errors
          }
        } else {
          return {
            stdout: "",
            stderr: `ln: ${dst}: File exists\n`,
            exitCode: 1
          };
        }
      }

      if (symbolic && io.fs.symlink) {
        // Use real symlink if the host supports it
        await io.fs.symlink(src, dst);
        if (verbose) {
          output.push(`'${dst}' -> '${src}'`);
        }
      } else {
        // Fall back to copy (virtual FS may not support symlinks)
        // Hard link = copy in virtual FS
        const content = await io.fs.readFile(src);
        await io.fs.writeFile(dst, content);
        if (verbose) {
          output.push(`'${dst}' => '${src}'`);
        }
      }

      return {
        stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return { stdout: "", stderr: `ln: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
