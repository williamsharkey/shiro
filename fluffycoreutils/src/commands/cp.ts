import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const cp: FluffyCommand = {
  name: "cp",
  description: "Copy files and directories",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const recursive = flags.r || flags.R;

    if (positional.length < 2) {
      return { stdout: "", stderr: "cp: missing operand\n", exitCode: 1 };
    }

    const dest = io.fs.resolvePath(positional[positional.length - 1], io.cwd);
    const sources = positional.slice(0, -1);

    let destIsDir = false;
    try {
      const stat = await io.fs.stat(dest);
      destIsDir = stat.type === "dir";
    } catch { /* doesn't exist */ }

    if (sources.length > 1 && !destIsDir) {
      return { stdout: "", stderr: "cp: target is not a directory\n", exitCode: 1 };
    }

    async function copyFile(src: string, dst: string): Promise<void> {
      const content = await io.fs.readFile(src);
      await io.fs.writeFile(dst, content);
    }

    async function copyDir(src: string, dst: string): Promise<void> {
      await io.fs.mkdir(dst, { recursive: true });
      const entries = await io.fs.readdir(src);
      for (const entry of entries) {
        const srcChild = src + "/" + entry.name;
        const dstChild = dst + "/" + entry.name;
        if (entry.type === "dir") {
          await copyDir(srcChild, dstChild);
        } else {
          await copyFile(srcChild, dstChild);
        }
      }
    }

    try {
      for (const src of sources) {
        const srcResolved = io.fs.resolvePath(src, io.cwd);
        const stat = await io.fs.stat(srcResolved);
        const name = src.split("/").pop()!;
        const target = destIsDir ? dest + "/" + name : dest;

        if (stat.type === "dir") {
          if (!recursive) {
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${src}'\n`, exitCode: 1 };
          }
          await copyDir(srcResolved, target);
        } else {
          await copyFile(srcResolved, target);
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `cp: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
