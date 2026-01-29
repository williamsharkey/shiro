import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const xargs: FluffyCommand = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const onePerLine = flags.I || flags.L;

    const command = positional.length > 0 ? positional.join(" ") : "echo";
    const inputItems = io.stdin.trim().split(onePerLine ? "\n" : /\s+/).filter(Boolean);

    if (inputItems.length === 0) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Without access to a shell, xargs falls back to echo-like behavior
    // when used with the default "echo" command, which is the most common case.
    if (command === "echo") {
      return { stdout: inputItems.join(" ") + "\n", stderr: "", exitCode: 0 };
    }

    // For other commands, output the constructed command line.
    // The host shell is responsible for piping xargs output to execution.
    const fullCommand = `${command} ${inputItems.map(escapeArg).join(" ")}`;
    return { stdout: fullCommand + "\n", stderr: "", exitCode: 0 };
  },
};

function escapeArg(s: string): string {
  if (/[^a-zA-Z0-9._\-/=]/.test(s)) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return s;
}
