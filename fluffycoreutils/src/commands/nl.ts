import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const nl: FluffyCommand = {
  name: "nl",
  description: "Number lines of files",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["b", "s", "w", "n", "v"]);

    const bodyNumbering = values.b || "t"; // t=non-empty, a=all, n=none
    const separator = values.s || "\t";
    const width = parseInt(values.w || "6", 10);
    const format = values.n || "rn"; // rn=right no leading zeros, ln=left, rz=right with zeros
    const startNumber = parseInt(values.v || "1", 10);

    const noRenumber = flags.p;
    const blankLines = flags.ba; // same as -b a

    try {
      const { content } = await readInput(
        positional,
        io.stdin,
        io.fs,
        io.cwd,
        io.fs.resolvePath
      );

      const lines = content.split("\n");
      const output: string[] = [];
      let lineNumber = startNumber;

      for (const line of lines) {
        let shouldNumber = false;

        // Determine if we should number this line
        const actualBodyNumbering = blankLines ? "a" : bodyNumbering;

        switch (actualBodyNumbering) {
          case "a":
            shouldNumber = true;
            break;
          case "t":
            shouldNumber = line.trim() !== "";
            break;
          case "n":
            shouldNumber = false;
            break;
          default:
            // Pattern matching (e.g., p^#)
            if (actualBodyNumbering.startsWith("p")) {
              const pattern = actualBodyNumbering.substring(1);
              try {
                const regex = new RegExp(pattern);
                shouldNumber = regex.test(line);
              } catch {
                shouldNumber = false;
              }
            }
        }

        if (shouldNumber) {
          const numStr = formatNumber(lineNumber, width, format);
          output.push(numStr + separator + line);
          lineNumber++;
        } else {
          output.push(" ".repeat(width) + separator + line);
        }
      }

      return {
        stdout: output.join("\n") + (content.endsWith("\n") ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `nl: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

function formatNumber(num: number, width: number, format: string): string {
  const numStr = String(num);

  switch (format) {
    case "ln":
      // Left justified, no leading zeros
      return numStr.padEnd(width, " ");
    case "rn":
      // Right justified, no leading zeros (default)
      return numStr.padStart(width, " ");
    case "rz":
      // Right justified, leading zeros
      return numStr.padStart(width, "0");
    default:
      return numStr.padStart(width, " ");
  }
}
