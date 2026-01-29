import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const uniq: FluffyCommand = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    try {
      const { content } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );
      const lines = content.split("\n");
      // Remove trailing empty from final newline
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      const output: string[] = [];
      let prev = "";
      let count = 0;

      for (const line of lines) {
        if (line === prev) {
          count++;
        } else {
          if (count > 0) emitLine(prev, count, flags, output);
          prev = line;
          count = 1;
        }
      }
      if (count > 0) emitLine(prev, count, flags, output);

      return { stdout: output.join("\n") + "\n", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `uniq: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};

function emitLine(
  line: string,
  count: number,
  flags: Record<string, boolean>,
  output: string[]
): void {
  if (flags.d && count < 2) return;
  if (flags.c) {
    output.push(`${String(count).padStart(7)} ${line}`);
  } else {
    output.push(line);
  }
}
