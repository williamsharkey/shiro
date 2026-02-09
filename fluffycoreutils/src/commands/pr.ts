import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const pr: FluffyCommand = {
  name: "pr",
  description: "Convert text files for printing with headers and page breaks",
  async exec(args, io) {
    const { flags, positional, values } = parseArgs(args, [
      "h", "header",
      "l", "length",
      "w", "width",
      "t", "omit-header",
      "d", "double-space",
      "n", "number-lines",
      "m", "merge",
      "s", "separator",
      "a", "across",
      "columns",
    ]);

    const header = values.h || values.header || "";
    const pageLength = parseInt(values.l || values.length || "66");
    const pageWidth = parseInt(values.w || values.width || "72");
    const omitHeader = flags.t || flags["omit-header"];
    const doubleSpace = flags.d || flags["double-space"];
    const numberLines = flags.n || flags["number-lines"];
    const merge = flags.m || flags.merge;
    const separator = values.s || values.separator || "\t";
    const across = flags.a || flags.across;
    const numColumns = parseInt(values.columns || "1");

    const files = positional.length > 0 ? positional : ["-"];

    let output = "";

    for (const file of files) {
      let content: string;
      try {
        if (file === "-") {
          content = io.stdin;
        } else {
          const path = io.fs.resolvePath(file, io.cwd);
          content = await io.fs.readFile(path);
        }
      } catch (err) {
        return {
          stdout: "",
          stderr: `pr: ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }

      const lines = content.split("\n");
      const filename = file === "-" ? "" : file;

      // Generate header
      const currentDate = new Date().toISOString().split("T")[0];
      const pageHeader = header || filename;
      const headerLines = omitHeader
        ? []
        : [
            "",
            "",
            `${currentDate}  ${pageHeader}  Page 1`,
            "",
            "",
          ];

      // Process lines based on options
      let processedLines = [...lines];

      // Apply double spacing
      if (doubleSpace) {
        processedLines = processedLines.flatMap((line) => [line, ""]);
      }

      // Apply line numbering
      if (numberLines) {
        processedLines = processedLines.map((line, idx) => {
          const lineNum = (idx + 1).toString().padStart(6, " ");
          return `${lineNum}  ${line}`;
        });
      }

      // Apply column formatting
      if (numColumns > 1) {
        processedLines = formatColumns(processedLines, numColumns, pageWidth, separator, across);
      } else if (merge && files.length > 1) {
        // Merge mode is handled differently when multiple files are provided
        // For now, just process single file normally
      }

      // Paginate output
      const linesPerPage = pageLength - headerLines.length - 5; // Reserve space for header and footer
      const pages: string[][] = [];
      for (let i = 0; i < processedLines.length; i += linesPerPage) {
        pages.push(processedLines.slice(i, i + linesPerPage));
      }

      // Build output with headers
      for (let pageNum = 0; pageNum < pages.length; pageNum++) {
        if (!omitHeader) {
          const pageHeaderLine = `${currentDate}  ${pageHeader}  Page ${pageNum + 1}`;
          output += "\n\n" + pageHeaderLine + "\n\n\n";
        }
        output += pages[pageNum].join("\n") + "\n";
      }
    }

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
    };
  },
};

function formatColumns(
  lines: string[],
  numColumns: number,
  pageWidth: number,
  separator: string,
  across: boolean
): string[] {
  const colWidth = Math.floor((pageWidth - (numColumns - 1) * separator.length) / numColumns);
  const result: string[] = [];

  if (across) {
    // Arrange lines across columns (left to right, then down)
    for (let i = 0; i < lines.length; i += numColumns) {
      const rowCols = lines.slice(i, i + numColumns);
      const paddedCols = rowCols.map((col) => col.padEnd(colWidth).slice(0, colWidth));
      result.push(paddedCols.join(separator));
    }
  } else {
    // Arrange lines down columns (down first column, then next column)
    const linesPerCol = Math.ceil(lines.length / numColumns);
    for (let row = 0; row < linesPerCol; row++) {
      const rowCols: string[] = [];
      for (let col = 0; col < numColumns; col++) {
        const idx = col * linesPerCol + row;
        const line = idx < lines.length ? lines[idx] : "";
        rowCols.push(line.padEnd(colWidth).slice(0, colWidth));
      }
      result.push(rowCols.join(separator));
    }
  }

  return result;
}
