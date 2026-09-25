
import type { Command } from './index';
import { parseArgs } from './flags';
export const du: Command = {
  name: "du",
  description: "Estimate file space usage",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional, values } = parseArgs(args, ["max-depth", "d"]);

    const targets = positional.length > 0 ? positional : ["."];
    const summarize = flags.s;
    const all = flags.a;
    const humanReadable = flags.h;
    const maxDepth = values["max-depth"] || values.d;
    const maxDepthNum = maxDepth ? parseInt(maxDepth) : Infinity;

    const output: string[] = [];

    try {
      for (const target of targets) {
        const resolved = ctx.fs.resolvePath(target, ctx.cwd);
        const size = await calculateSize(resolved, ctx.fs, 0, maxDepthNum, all, !summarize, output, humanReadable);

        // Always show the target itself
        const sizeStr = humanReadable ? formatHuman(size) : String(Math.ceil(size / 1024));
        output.push(`${sizeStr}\t${target}`);
      }

      ctx.stdout += output.join("\n") + "\n";
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `du: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

async function calculateSize(
  path: string,
  fs: any,
  depth: number,
  maxDepth: number,
  showAll: boolean,
  showSubdirs: boolean,
  output: string[],
  humanReadable: boolean
): Promise<number> {
  try {
    const stat = await fs.lstat(path);
    const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : stat.type === 'dir';

    if (!isDir) {
      return stat.size || 0;
    }

    if (depth < maxDepth) {
      const entries: Array<string | { name: string }> = await fs.readdir(path);
      let totalSize = 0;

      for (const e of entries) {
        const name = typeof e === 'string' ? e : e.name;
        const entryPath = (path === '/' ? '' : path) + "/" + name;
        let entryIsDir = false;
        try { const st = await fs.lstat(entryPath); entryIsDir = typeof st.isDirectory === 'function' ? st.isDirectory() : st.type === 'dir'; } catch { /* vanished */ }
        const entrySize = await calculateSize(entryPath, fs, depth + 1, maxDepth, showAll, showSubdirs, output, humanReadable);
        totalSize += entrySize;

        // Show individual files if -a
        if (showAll && !entryIsDir) {
          const sizeStr = humanReadable ? formatHuman(entrySize) : String(Math.ceil(entrySize / 1024));
          output.push(`${sizeStr}\t${entryPath}`);
        }

        // Show subdirectories if not summarizing
        if (showSubdirs && entryIsDir && depth + 1 < maxDepth) {
          const sizeStr = humanReadable ? formatHuman(entrySize) : String(Math.ceil(entrySize / 1024));
          output.push(`${sizeStr}\t${entryPath}`);
        }
      }

      return totalSize;
    }

    return 0;
  } catch {
    return 0;
  }
}

function formatHuman(bytes: number): string {
  const units = ["", "K", "M", "G", "T"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return Math.ceil(size) + units[unitIndex];
}
