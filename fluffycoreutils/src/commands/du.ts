import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const du: FluffyCommand = {
  name: "du",
  description: "Estimate file space usage",
  async exec(args, io) {
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
        const resolved = io.fs.resolvePath(target, io.cwd);
        const size = await calculateSize(resolved, io.fs, 0, maxDepthNum, all, !summarize, output, humanReadable);

        // Always show the target itself
        const sizeStr = humanReadable ? formatHuman(size) : String(Math.ceil(size / 1024));
        output.push(`${sizeStr}\t${target}`);
      }

      return {
        stdout: output.join("\n") + "\n",
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `du: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
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
    const stat = await fs.stat(path);

    if (stat.type === "file") {
      return stat.size;
    }

    if (stat.type === "dir" && depth < maxDepth) {
      const entries = await fs.readdir(path);
      let totalSize = 0;

      for (const entry of entries) {
        const entryPath = path + "/" + entry.name;
        const entrySize = await calculateSize(entryPath, fs, depth + 1, maxDepth, showAll, showSubdirs, output, humanReadable);
        totalSize += entrySize;

        // Show individual files if -a
        if (showAll && entry.type === "file") {
          const sizeStr = humanReadable ? formatHuman(entrySize) : String(Math.ceil(entrySize / 1024));
          output.push(`${sizeStr}\t${entryPath}`);
        }

        // Show subdirectories if not summarizing
        if (showSubdirs && entry.type === "dir" && depth + 1 < maxDepth) {
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
