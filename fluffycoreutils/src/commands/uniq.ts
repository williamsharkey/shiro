import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const uniq: FluffyCommand = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(args, io) {
    const { flags, positional, values } = parseArgs(args, ["f", "s", "w"]);

    const skipFields = values.f ? parseInt(values.f) : 0;
    const skipChars = values.s ? parseInt(values.s) : 0;
    const checkChars = values.w ? parseInt(values.w) : undefined;
    const ignoreCase = flags.i;

    try {
      const { content } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );
      const lines = content.split("\n");
      // Remove trailing empty from final newline
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      const output: string[] = [];
      let prev = "";
      let prevKey = "";
      let count = 0;

      for (const line of lines) {
        const key = getComparisonKey(line, skipFields, skipChars, checkChars, ignoreCase);

        if (key === prevKey) {
          count++;
        } else {
          if (count > 0) emitLine(prev, count, flags, output);
          prev = line;
          prevKey = key;
          count = 1;
        }
      }
      if (count > 0) emitLine(prev, count, flags, output);

      return { stdout: output.join("\n") + (output.length > 0 ? "\n" : ""), stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `uniq: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};

function getComparisonKey(
  line: string,
  skipFields: number,
  skipChars: number,
  checkChars: number | undefined,
  ignoreCase: boolean
): string {
  let key = line;

  // Skip fields
  if (skipFields > 0) {
    const fields = line.split(/\s+/);
    key = fields.slice(skipFields).join(" ");
  }

  // Skip characters
  if (skipChars > 0) {
    key = key.substring(skipChars);
  }

  // Check only N characters
  if (checkChars !== undefined) {
    key = key.substring(0, checkChars);
  }

  // Case insensitive
  if (ignoreCase) {
    key = key.toLowerCase();
  }

  return key;
}

function emitLine(
  line: string,
  count: number,
  flags: Record<string, boolean>,
  output: string[]
): void {
  // -d: only duplicated lines
  if (flags.d && count < 2) return;

  // -u: only unique lines
  if (flags.u && count > 1) return;

  // -c: prefix with count
  if (flags.c) {
    output.push(`${String(count).padStart(7)} ${line}`);
  } else {
    output.push(line);
  }
}
