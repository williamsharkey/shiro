import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const cut: FluffyCommand = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(args, io) {
    const { values, positional } = parseArgs(args, ["d", "f", "c"]);
    const delimiter = values.d ?? "\t";
    const fieldSpec = values.f;
    const charSpec = values.c;

    if (!fieldSpec && !charSpec) {
      return { stdout: "", stderr: "cut: you must specify -f or -c\n", exitCode: 1 };
    }

    try {
      const { content } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );

      const ranges = parseRanges(fieldSpec ?? charSpec!);
      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      const output: string[] = [];

      for (const line of lines) {
        if (fieldSpec) {
          const fields = line.split(delimiter);
          const selected = ranges
            .flatMap((r) => fields.slice(r.start - 1, r.end))
            .filter((f) => f !== undefined);
          output.push(selected.join(delimiter));
        } else {
          const chars = line.split("");
          const selected = ranges
            .flatMap((r) => chars.slice(r.start - 1, r.end))
            .filter((c) => c !== undefined);
          output.push(selected.join(""));
        }
      }

      return { stdout: output.join("\n") + "\n", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `cut: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};

function parseRanges(spec: string): { start: number; end: number }[] {
  return spec.split(",").map((part) => {
    if (part.includes("-")) {
      const [a, b] = part.split("-");
      return {
        start: a ? parseInt(a, 10) : 1,
        end: b ? parseInt(b, 10) : Infinity,
      };
    }
    const n = parseInt(part, 10);
    return { start: n, end: n };
  });
}
