import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const sed: FluffyCommand = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const inPlace = flags.i;

    // First positional is the expression, rest are files
    const expression = positional.shift();
    if (!expression) {
      return { stdout: "", stderr: "sed: no expression provided\n", exitCode: 1 };
    }

    // Parse s/pattern/replacement/flags
    const match = expression.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!match) {
      return { stdout: "", stderr: `sed: unsupported expression: ${expression}\n`, exitCode: 1 };
    }

    const [, , pattern, replacement, regexFlags] = match;
    const global = regexFlags.includes("g");
    const caseInsensitive = regexFlags.includes("i");

    let regex: RegExp;
    try {
      const flags = (global ? "g" : "") + (caseInsensitive ? "i" : "");
      regex = new RegExp(pattern, flags);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${pattern}\n`, exitCode: 2 };
    }

    try {
      const { content, files } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );

      const result = content
        .split("\n")
        .map((line) => line.replace(regex, replacement))
        .join("\n");

      if (inPlace && files.length > 0) {
        // Write back to original files
        for (const f of files) {
          const resolved = io.fs.resolvePath(f, io.cwd);
          const original = await io.fs.readFile(resolved);
          const modified = original
            .split("\n")
            .map((line) => line.replace(regex, replacement))
            .join("\n");
          await io.fs.writeFile(resolved, modified);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      return { stdout: result, stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `sed: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
