import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const patch: FluffyCommand = {
  name: "patch",
  description: "Apply a diff file to an original",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["p", "i", "input", "o", "output"]);

    const stripLevel = values.p ? parseInt(values.p) : 0;
    const inputFile = values.i || values.input;
    const outputFile = values.o || values.output;
    const reverse = flags.R || flags.reverse;
    const dryRun = flags["dry-run"];

    try {
      // Read patch file
      let patchContent: string;
      if (inputFile) {
        const patchPath = io.fs.resolvePath(inputFile, io.cwd);
        patchContent = await io.fs.readFile(patchPath);
      } else if (positional.length > 0) {
        const patchPath = io.fs.resolvePath(positional[0], io.cwd);
        patchContent = await io.fs.readFile(patchPath);
      } else {
        patchContent = io.stdin;
      }

      // Parse unified diff
      const patches = parseUnifiedDiff(patchContent);

      const output: string[] = [];

      for (const patch of patches) {
        const targetFile = stripPath(patch.newFile, stripLevel);
        const sourceFile = stripPath(patch.oldFile, stripLevel);

        output.push(`patching file ${targetFile}`);

        if (!dryRun) {
          // Read original file
          let originalContent: string;
          try {
            const filePath = io.fs.resolvePath(targetFile, io.cwd);
            originalContent = await io.fs.readFile(filePath);
          } catch {
            // File doesn't exist, start with empty
            originalContent = "";
          }

          // Apply hunks
          const patched = applyPatch(originalContent, patch.hunks, reverse);

          // Write result
          if (outputFile) {
            const outPath = io.fs.resolvePath(outputFile, io.cwd);
            await io.fs.writeFile(outPath, patched);
          } else {
            const filePath = io.fs.resolvePath(targetFile, io.cwd);
            await io.fs.writeFile(filePath, patched);
          }
        }
      }

      return {
        stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `patch: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface Patch {
  oldFile: string;
  newFile: string;
  hunks: Hunk[];
}

function parseUnifiedDiff(content: string): Patch[] {
  const patches: Patch[] = [];
  const lines = content.split("\n");
  let currentPatch: Patch | null = null;
  let currentHunk: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      currentPatch = { oldFile: line.substring(4).split("\t")[0], newFile: "", hunks: [] };
    } else if (line.startsWith("+++ ") && currentPatch) {
      currentPatch.newFile = line.substring(4).split("\t")[0];
      patches.push(currentPatch);
    } else if (line.startsWith("@@ ") && currentPatch) {
      const match = line.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      if (match) {
        currentHunk = {
          oldStart: parseInt(match[1]),
          oldLines: parseInt(match[2]),
          newStart: parseInt(match[3]),
          newLines: parseInt(match[4]),
          lines: []
        };
        currentPatch.hunks.push(currentHunk);
      }
    } else if (currentHunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      currentHunk.lines.push(line);
    }
  }

  return patches;
}

function stripPath(path: string, level: number): string {
  const parts = path.split("/");
  return parts.slice(level).join("/");
}

function applyPatch(original: string, hunks: Hunk[], reverse: boolean): string {
  const lines = original.split("\n");

  for (const hunk of hunks) {
    const start = hunk.oldStart - 1;
    const deleteCount = hunk.oldLines;
    const newLines: string[] = [];

    for (const line of hunk.lines) {
      const op = line[0];
      const content = line.substring(1);

      if (reverse) {
        if (op === "+") {
          // In reverse, + becomes -
          continue;
        } else if (op === "-") {
          // In reverse, - becomes +
          newLines.push(content);
        } else {
          newLines.push(content);
        }
      } else {
        if (op === "+") {
          newLines.push(content);
        } else if (op === " ") {
          newLines.push(content);
        }
        // Skip - lines in normal mode
      }
    }

    lines.splice(start, deleteCount, ...newLines);
  }

  return lines.join("\n");
}
