import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

type DiffOp = { type: "equal" | "add" | "delete"; lines: string[]; line1?: number; line2?: number };

export const diff: FluffyCommand = {
  name: "diff",
  description: "Compare files line by line",
  async exec(args, io) {
    const { flags, positional, values } = parseArgs(args, ["U", "context", "C"]);
    const unified = flags.u || values.U !== undefined;
    const context = values.U || values.context || values.C || (flags.u ? 3 : 0);
    const contextLines = typeof context === "string" ? parseInt(context) : 3;
    const brief = flags.q || flags.brief;
    const ignoreCase = flags.i;
    const ignoreWhitespace = flags.w || flags["ignore-all-space"];
    const sideBySide = flags.y || flags["side-by-side"];

    if (positional.length < 2) {
      return { stdout: "", stderr: "diff: missing operand\n", exitCode: 2 };
    }

    try {
      const file1 = io.fs.resolvePath(positional[0], io.cwd);
      const file2 = io.fs.resolvePath(positional[1], io.cwd);
      const content1 = await io.fs.readFile(file1);
      const content2 = await io.fs.readFile(file2);

      if (content1 === content2) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      if (brief) {
        return { stdout: `Files ${positional[0]} and ${positional[1]} differ\n`, stderr: "", exitCode: 1 };
      }

      const lines1 = content1.split("\n");
      const lines2 = content2.split("\n");

      // Compute LCS-based diff
      const diff = computeDiff(lines1, lines2, { ignoreCase, ignoreWhitespace });
      const output: string[] = [];

      if (unified) {
        // Unified diff format (-u)
        output.push(`--- ${positional[0]}`);
        output.push(`+++ ${positional[1]}`);

        let i = 0;
        while (i < diff.length) {
          const op = diff[i];

          if (op.type === "equal") {
            i++;
            continue;
          }

          // Found a change, create a hunk
          const hunkStart = Math.max(0, i - 1);
          let hunkEnd = i;

          // Extend hunk to include context and nearby changes
          while (hunkEnd < diff.length) {
            const nextOp = diff[hunkEnd];
            if (nextOp.type !== "equal") {
              hunkEnd++;
            } else if (nextOp.lines.length <= contextLines * 2) {
              hunkEnd++;
            } else {
              break;
            }
          }

          // Generate hunk header
          const start1 = (diff[hunkStart]?.line1 ?? 0) + 1;
          const start2 = (diff[hunkStart]?.line2 ?? 0) + 1;
          let count1 = 0, count2 = 0;

          for (let j = hunkStart; j < hunkEnd; j++) {
            if (diff[j].type === "equal" || diff[j].type === "delete") {
              count1 += diff[j].lines.length;
            }
            if (diff[j].type === "equal" || diff[j].type === "add") {
              count2 += diff[j].lines.length;
            }
          }

          output.push(`@@ -${start1},${count1} +${start2},${count2} @@`);

          // Output hunk content
          for (let j = hunkStart; j < hunkEnd; j++) {
            const op = diff[j];
            if (op.type === "equal") {
              op.lines.forEach(line => output.push(` ${line}`));
            } else if (op.type === "delete") {
              op.lines.forEach(line => output.push(`-${line}`));
            } else if (op.type === "add") {
              op.lines.forEach(line => output.push(`+${line}`));
            }
          }

          i = hunkEnd;
        }
      } else if (sideBySide) {
        // Side-by-side format
        const width = 40;
        for (const op of diff) {
          if (op.type === "equal") {
            op.lines.forEach(line => {
              const left = line.substring(0, width).padEnd(width);
              output.push(`${left} | ${line}`);
            });
          } else if (op.type === "delete") {
            op.lines.forEach(line => {
              const left = line.substring(0, width).padEnd(width);
              output.push(`${left} <`);
            });
          } else if (op.type === "add") {
            op.lines.forEach(line => {
              output.push(`${" ".repeat(width)} > ${line}`);
            });
          }
        }
      } else {
        // Normal diff format
        for (const op of diff) {
          if (op.type === "equal") continue;

          const line1 = (op.line1 ?? 0) + 1;
          const line2 = (op.line2 ?? 0) + 1;

          if (op.type === "delete") {
            output.push(`${line1},${line1 + op.lines.length - 1}d${line2 - 1}`);
            op.lines.forEach(line => output.push(`< ${line}`));
          } else if (op.type === "add") {
            output.push(`${line1 - 1}a${line2},${line2 + op.lines.length - 1}`);
            op.lines.forEach(line => output.push(`> ${line}`));
          }
        }
      }

      return { stdout: output.join("\n") + (output.length > 0 ? "\n" : ""), stderr: "", exitCode: 1 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `diff: ${e instanceof Error ? e.message : e}\n`, exitCode: 2 };
    }
  },
};

interface DiffOptions {
  ignoreCase?: boolean;
  ignoreWhitespace?: boolean;
}

function computeDiff(lines1: string[], lines2: string[], options: DiffOptions = {}): DiffOp[] {
  // LCS-based diff using dynamic programming
  const m = lines1.length;
  const n = lines2.length;

  const normalize = (line: string) => {
    let result = line;
    if (options.ignoreWhitespace) {
      result = result.replace(/\s+/g, "");
    }
    if (options.ignoreCase) {
      result = result.toLowerCase();
    }
    return result;
  };

  // Build LCS matrix
  const lcs: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (normalize(lines1[i - 1]) === normalize(lines2[j - 1])) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff operations
  const result: DiffOp[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && normalize(lines1[i - 1]) === normalize(lines2[j - 1])) {
      // Equal line
      if (result.length > 0 && result[result.length - 1].type === "equal") {
        result[result.length - 1].lines.unshift(lines1[i - 1]);
      } else {
        result.push({ type: "equal", lines: [lines1[i - 1]], line1: i - 1, line2: j - 1 });
      }
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      // Addition
      if (result.length > 0 && result[result.length - 1].type === "add") {
        result[result.length - 1].lines.unshift(lines2[j - 1]);
      } else {
        result.push({ type: "add", lines: [lines2[j - 1]], line1: i, line2: j - 1 });
      }
      j--;
    } else {
      // Deletion
      if (result.length > 0 && result[result.length - 1].type === "delete") {
        result[result.length - 1].lines.unshift(lines1[i - 1]);
      } else {
        result.push({ type: "delete", lines: [lines1[i - 1]], line1: i - 1, line2: j });
      }
      i--;
    }
  }

  return result.reverse();
}
