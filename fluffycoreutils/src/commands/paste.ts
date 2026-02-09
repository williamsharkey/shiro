import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const paste: FluffyCommand = {
  name: "paste",
  description: "Merge lines of files",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["d", "delimiters"]);

    const delimiters = values.d || values.delimiters || "\t";
    const serial = flags.s;

    if (positional.length === 0) {
      // Read from stdin
      positional.push("-");
    }

    try {
      // Read all files
      const fileContents: string[][] = [];

      for (const file of positional) {
        let content: string;
        if (file === "-") {
          content = io.stdin;
        } else {
          const resolved = io.fs.resolvePath(file, io.cwd);
          content = await io.fs.readFile(resolved);
        }
        fileContents.push(content.split("\n").filter((line, idx, arr) => {
          // Keep all lines except the last empty one (from trailing newline)
          return idx < arr.length - 1 || line !== "";
        }));
      }

      const output: string[] = [];

      if (serial) {
        // Serial mode: paste each file's lines on one line
        for (const lines of fileContents) {
          const delimiterChars = delimiters.split("");
          const mergedLine: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            mergedLine.push(lines[i]);
            if (i < lines.length - 1) {
              mergedLine.push(delimiterChars[i % delimiterChars.length]);
            }
          }
          output.push(mergedLine.join(""));
        }
      } else {
        // Parallel mode: paste corresponding lines from each file
        const maxLines = Math.max(...fileContents.map(f => f.length));
        const delimiterChars = delimiters.split("");

        for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
          const lineParts: string[] = [];
          for (let fileIdx = 0; fileIdx < fileContents.length; fileIdx++) {
            const line = fileContents[fileIdx][lineIdx] || "";
            lineParts.push(line);

            // Add delimiter between files (but not after last file)
            if (fileIdx < fileContents.length - 1) {
              lineParts.push(delimiterChars[fileIdx % delimiterChars.length]);
            }
          }
          output.push(lineParts.join(""));
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
        stderr: `paste: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
