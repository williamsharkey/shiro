import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const rm: FluffyCommand = {
  name: "rm",
  description: "Remove files or directories",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const recursive = flags.r || flags.R;
    const force = flags.f;

    if (positional.length === 0 && !force) {
      return { stdout: "", stderr: "rm: missing operand\n", exitCode: 1 };
    }

    async function removeDir(path: string): Promise<void> {
      const entries = await io.fs.readdir(path);
      for (const entry of entries) {
        const child = path + "/" + entry.name;
        if (entry.type === "dir") {
          await removeDir(child);
        } else {
          await io.fs.unlink(child);
        }
      }
      await io.fs.rmdir(path);
    }

    try {
      for (const p of positional) {
        const resolved = io.fs.resolvePath(p, io.cwd);
        let stat;
        try {
          stat = await io.fs.stat(resolved);
        } catch {
          if (force) continue;
          return { stdout: "", stderr: `rm: cannot remove '${p}': No such file or directory\n`, exitCode: 1 };
        }

        if (stat.type === "dir") {
          if (!recursive) {
            return { stdout: "", stderr: `rm: cannot remove '${p}': Is a directory\n`, exitCode: 1 };
          }
          await removeDir(resolved);
        } else {
          await io.fs.unlink(resolved);
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      if (force) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: `rm: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
