import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

/**
 * column - Format input into columns
 *
 * Formats text into columns based on input separators.
 */
export const column: FluffyCommand = {
  name: "column",
  description: "Format input into columns",
  async exec(args, io) {
    const { flags, values, positional } = parseArgs(args, ["t", "s", "c", "x", "n"]);

    try {
      const { content } = await readInput(
        positional,
        io.stdin,
        io.fs,
        io.cwd,
        io.fs.resolvePath
      );

      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }

      // -t: create a table (determine number of columns automatically)
      if (flags.t) {
        const separator = values.s || "\t";
        const sepRegex = new RegExp(separator);

        // Split each line into columns
        const rows = lines.map(line => line.split(sepRegex));

        // Find maximum width for each column
        const maxColumns = Math.max(...rows.map(r => r.length));
        const columnWidths: number[] = new Array(maxColumns).fill(0);

        for (const row of rows) {
          for (let i = 0; i < row.length; i++) {
            columnWidths[i] = Math.max(columnWidths[i] || 0, row[i].length);
          }
        }

        // Format output
        const output = rows.map(row => {
          return row.map((cell, i) => {
            const width = columnWidths[i];
            return cell.padEnd(width);
          }).join("  ");
        }).join("\n");

        return {
          stdout: output ? output + "\n" : "",
          stderr: "",
          exitCode: 0
        };
      }

      // -x: fill columns before rows (default is fill rows)
      // -c: output width (default is terminal width)
      // -n: don't merge multiple adjacent delimiters
      const width = values.c ? parseInt(values.c) : 80;

      // Simple column formatting (fill rows)
      // Find max word length to determine column width
      const words = lines.flatMap(line => line.split(/\s+/).filter(w => w));
      if (words.length === 0) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      const maxWordLen = Math.max(...words.map(w => w.length));
      const colWidth = maxWordLen + 2; // Add spacing
      const numCols = Math.max(1, Math.floor(width / colWidth));

      if (flags.x) {
        // Fill columns before rows
        const numRows = Math.ceil(words.length / numCols);
        const grid: string[][] = Array(numRows).fill(null).map(() => []);

        for (let i = 0; i < words.length; i++) {
          const row = i % numRows;
          grid[row].push(words[i]);
        }

        const output = grid.map(row => {
          return row.map(word => word.padEnd(colWidth)).join("").trimEnd();
        }).join("\n");

        return {
          stdout: output ? output + "\n" : "",
          stderr: "",
          exitCode: 0
        };
      } else {
        // Fill rows before columns (default)
        const output: string[] = [];
        for (let i = 0; i < words.length; i += numCols) {
          const row = words.slice(i, i + numCols);
          output.push(row.map(word => word.padEnd(colWidth)).join("").trimEnd());
        }

        return {
          stdout: output.join("\n") + "\n",
          stderr: "",
          exitCode: 0
        };
      }
    } catch (err: any) {
      return {
        stdout: "",
        stderr: `column: ${err.message}\n`,
        exitCode: 1
      };
    }
  },
};
