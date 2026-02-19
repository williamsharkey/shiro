
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const fmt: Command = {
  name: "fmt",
  description: "Simple optimal text formatter",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["w", "width"]);

    const width = parseInt(values.w || values.width || "75", 10);
    const uniform = flags.u;
    const split = flags.s;

    if (isNaN(width) || width <= 0) {
      ctx.stderr += `fmt: invalid width: '${values.w || values.width}'\n`;
      return 1;
    }

    try {
      const { content } = await readInput(
        positional,
        ctx.stdin,
        ctx.fs,
        ctx.cwd,
        ctx.fs.resolvePath
      );

      const lines = content.split("\n");
      const output: string[] = [];
      let paragraph: string[] = [];

      const flushParagraph = () => {
        if (paragraph.length === 0) return;

        if (split) {
          // Split-only mode: don't join lines
          for (const line of paragraph) {
            output.push(...wrapLine(line, width));
          }
        } else {
          // Normal mode: join and reformat
          const joined = paragraph.join(" ").trim();
          if (joined) {
            output.push(...wrapLine(joined, width));
          }
        }

        paragraph = [];
      };

      for (const line of lines) {
        const trimmed = line.trim();

        // Empty line marks paragraph boundary
        if (trimmed === "") {
          flushParagraph();
          output.push("");
        } else {
          paragraph.push(trimmed);
        }
      }

      flushParagraph();

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `fmt: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

function wrapLine(text: string, width: number): string[] {
  const result: string[] = [];
  const words = text.split(/\s+/);
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= width) {
      currentLine += " " + word;
    } else {
      result.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine.length > 0) {
    result.push(currentLine);
  }

  return result;
}
