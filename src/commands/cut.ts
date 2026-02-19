
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const cut: Command = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional } = parseArgs(args, ["d", "f", "c"]);
    const delimiter = values.d ?? "\t";
    const fieldSpec = values.f;
    const charSpec = values.c;

    if (!fieldSpec && !charSpec) {
      ctx.stderr += "cut: you must specify -f or -c\n";
      return 1;
    }

    try {
      const { content } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
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

      ctx.stdout += output.join("\n") + "\n";
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `cut: ${e instanceof Error ? e.message : e}\n`;
      return 1;
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
