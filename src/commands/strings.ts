
import type { Command } from './index';
import { parseArgs, readInput, readFileText } from './flags';
export const strings: Command = {
  name: "strings",
  description: "Find printable strings in files",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["n", "bytes"]);

    const minLength = parseInt(values.n || values.bytes || "4", 10);
    const printFilename = flags.f;
    const all = flags.a;

    try {
      const files = positional.length > 0 ? positional : ["-"];
      const output: string[] = [];

      for (const file of files) {
        let content: string;
        let filename = file;

        if (file === "-") {
          content = ctx.stdin;
          filename = "(standard input)";
        } else {
          const resolved = ctx.fs.resolvePath(file, ctx.cwd);
          content = await readFileText(ctx.fs, resolved);
        }

        const strings = extractStrings(content, minLength);

        for (const str of strings) {
          if (printFilename) {
            output.push(`${filename}: ${str}`);
          } else {
            output.push(str);
          }
        }
      }

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `strings: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

function extractStrings(content: string, minLength: number): string[] {
  const results: string[] = [];
  const printableChars = /[ -~]/; // ASCII printable characters
  let currentString = "";

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (printableChars.test(char)) {
      currentString += char;
    } else {
      if (currentString.length >= minLength) {
        results.push(currentString);
      }
      currentString = "";
    }
  }

  // Don't forget the last string
  if (currentString.length >= minLength) {
    results.push(currentString);
  }

  return results;
}
