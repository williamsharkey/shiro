import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const echo: FluffyCommand = {
  name: "echo",
  description: "Display text",
  async exec(args) {
    const { flags } = parseArgs(args);
    const noNewline = flags.n;
    // Filter out the -n flag from output, reconstruct text
    const text = args.filter((a) => a !== "-n" && a !== "-e").join(" ");
    let output = flags.e
      ? text
          .replace(/\\\\/g, "\x00ESCAPED_BACKSLASH\x00")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\a/g, "\x07")
          .replace(/\\b/g, "\b")
          .replace(/\\f/g, "\f")
          .replace(/\\v/g, "\v")
          .replace(/\\0([0-7]{0,3})/g, (_, oct) => String.fromCharCode(parseInt(oct || '0', 8)))
          .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\x00ESCAPED_BACKSLASH\x00/g, "\\")
      : text;
    if (!noNewline) output += "\n";
    return { stdout: output, stderr: "", exitCode: 0 };
  },
};
