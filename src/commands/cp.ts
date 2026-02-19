
import type { Command } from './index';
import { parseArgs, readFileText, readdirEntries, statEntry } from './flags';
export const cp: Command = {
  name: "cp",
  description: "Copy files and directories",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    const recursive = flags.r || flags.R;

    if (positional.length < 2) {
      ctx.stderr += "cp: missing operand\n";
      return 1;
    }

    const dest = ctx.fs.resolvePath(positional[positional.length - 1], ctx.cwd);
    const sources = positional.slice(0, -1);

    let destIsDir = false;
    try {
      const stat = await statEntry(ctx.fs, dest);
      destIsDir = stat.type === "dir";
    } catch { /* doesn't exist */ }

    if (sources.length > 1 && !destIsDir) {
      ctx.stderr += "cp: target is not a directory\n";
      return 1;
    }

    async function copyFile(src: string, dst: string): Promise<void> {
      const content = await readFileText(ctx.fs, src);
      await ctx.fs.writeFile(dst, content);
    }

    async function copyDir(src: string, dst: string): Promise<void> {
      await ctx.fs.mkdir(dst, { recursive: true });
      const entries = await readdirEntries(ctx.fs, src);
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
        const srcResolved = ctx.fs.resolvePath(src, ctx.cwd);
        const stat = await statEntry(ctx.fs, srcResolved);
        const name = src.split("/").pop()!;
        const target = destIsDir ? dest + "/" + name : dest;

        if (stat.type === "dir") {
          if (!recursive) {
            ctx.stderr += `cp: -r not specified; omitting directory '${src}'\n`;
            return 1;
          }
          await copyDir(srcResolved, target);
        } else {
          await copyFile(srcResolved, target);
        }
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `cp: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
