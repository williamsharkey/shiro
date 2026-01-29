import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const diff: FluffyCommand = {
  name: "diff",
  description: "Compare files line by line",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const unified = flags.u;

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

      const lines1 = content1.split("\n");
      const lines2 = content2.split("\n");
      const output: string[] = [];

      if (unified) {
        output.push(`--- ${positional[0]}`);
        output.push(`+++ ${positional[1]}`);
        // Simple unified diff: show all changes
        const maxLen = Math.max(lines1.length, lines2.length);
        output.push(`@@ -1,${lines1.length} +1,${lines2.length} @@`);
        // LCS-based diff is complex; use simple line-by-line comparison
        let i = 0, j = 0;
        while (i < lines1.length || j < lines2.length) {
          if (i < lines1.length && j < lines2.length && lines1[i] === lines2[j]) {
            output.push(` ${lines1[i]}`);
            i++; j++;
          } else if (i < lines1.length && (j >= lines2.length || lines1[i] !== lines2[j])) {
            output.push(`-${lines1[i]}`);
            i++;
          } else {
            output.push(`+${lines2[j]}`);
            j++;
          }
        }
      } else {
        // Normal diff output
        for (let i = 0; i < Math.max(lines1.length, lines2.length); i++) {
          if (i >= lines1.length) {
            output.push(`${i + 1}a${i + 1}`);
            output.push(`> ${lines2[i]}`);
          } else if (i >= lines2.length) {
            output.push(`${i + 1}d${i + 1}`);
            output.push(`< ${lines1[i]}`);
          } else if (lines1[i] !== lines2[i]) {
            output.push(`${i + 1}c${i + 1}`);
            output.push(`< ${lines1[i]}`);
            output.push("---");
            output.push(`> ${lines2[i]}`);
          }
        }
      }

      return { stdout: output.join("\n") + "\n", stderr: "", exitCode: 1 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `diff: ${e instanceof Error ? e.message : e}\n`, exitCode: 2 };
    }
  },
};
