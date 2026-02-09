import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const strings: FluffyCommand = {
  name: "strings",
  description: "Find printable strings in files",
  async exec(args, io) {
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
          content = io.stdin;
          filename = "(standard input)";
        } else {
          const resolved = io.fs.resolvePath(file, io.cwd);
          content = await io.fs.readFile(resolved);
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

      return {
        stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `strings: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
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
