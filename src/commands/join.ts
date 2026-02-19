
import type { Command } from './index';
import { parseArgs, readFileText } from './flags';
export const join: Command = {
  name: "join",
  description: "Join lines of two files on a common field",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["1", "2", "t", "o"]);

    if (positional.length < 2) {
      ctx.stderr += "join: missing file operand\n";
      return 1;
    }

    const field1 = values["1"] ? parseInt(values["1"]) - 1 : 0; // Convert to 0-indexed
    const field2 = values["2"] ? parseInt(values["2"]) - 1 : 0;
    const delimiter = values.t || /\s+/;
    const outputFormat = values.o; // e.g., "1.1,2.2"
    const ignoreCase = flags.i;

    try {
      // Read both files
      const file1Path = ctx.fs.resolvePath(positional[0], ctx.cwd);
      const file2Path = ctx.fs.resolvePath(positional[1], ctx.cwd);

      const content1 = await readFileText(ctx.fs, file1Path);
      const content2 = await readFileText(ctx.fs, file2Path);

      const lines1 = content1.split("\n").filter(l => l.trim() !== "");
      const lines2 = content2.split("\n").filter(l => l.trim() !== "");

      // Parse lines into fields
      const parseLines = (lines: string[]) => {
        return lines.map(line => {
          const fields = typeof delimiter === "string"
            ? line.split(delimiter)
            : line.split(delimiter);
          return fields;
        });
      };

      const records1 = parseLines(lines1);
      const records2 = parseLines(lines2);

      // Build index for file2
      const index2 = new Map<string, string[][]>();
      for (const record of records2) {
        const key = (record[field2] || "").trim();
        const normalizedKey = ignoreCase ? key.toLowerCase() : key;
        if (!index2.has(normalizedKey)) {
          index2.set(normalizedKey, []);
        }
        index2.get(normalizedKey)!.push(record);
      }

      const output: string[] = [];

      // Join records
      for (const record1 of records1) {
        const key = (record1[field1] || "").trim();
        const normalizedKey = ignoreCase ? key.toLowerCase() : key;

        const matches = index2.get(normalizedKey) || [];
        for (const record2 of matches) {
          let joinedLine: string;

          if (outputFormat) {
            // Custom output format: -o 1.1,2.2
            const parts = outputFormat.split(",").map(spec => {
              const [fileNum, fieldNum] = spec.split(".").map(n => parseInt(n));
              const record = fileNum === 1 ? record1 : record2;
              return record[fieldNum - 1] || "";
            });
            joinedLine = parts.join(" ");
          } else {
            // Default: join field + remaining fields from file1 + remaining fields from file2
            const joinField = record1[field1] || "";
            const rest1 = record1.filter((_, i) => i !== field1);
            const rest2 = record2.filter((_, i) => i !== field2);
            joinedLine = [joinField, ...rest1, ...rest2].join(" ");
          }

          output.push(joinedLine);
        }
      }

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `join: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
