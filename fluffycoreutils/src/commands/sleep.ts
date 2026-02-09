import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const sleep: FluffyCommand = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    if (positional.length === 0) {
      return { stdout: "", stderr: "sleep: missing operand\n", exitCode: 1 };
    }

    const input = positional[0];
    let seconds = 0;

    // Parse duration: supports s (seconds), m (minutes), h (hours), d (days)
    const match = input.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);

    if (!match) {
      return {
        stdout: "",
        stderr: `sleep: invalid time interval '${input}'\n`,
        exitCode: 1
      };
    }

    const value = parseFloat(match[1]);
    const unit = match[2] || "s";

    switch (unit) {
      case "s":
        seconds = value;
        break;
      case "m":
        seconds = value * 60;
        break;
      case "h":
        seconds = value * 3600;
        break;
      case "d":
        seconds = value * 86400;
        break;
    }

    // In browser environment, we simulate sleep with a promise
    // Note: This is non-blocking in async context
    await new Promise(resolve => (globalThis as any).setTimeout(resolve, seconds * 1000));

    return { stdout: "", stderr: "", exitCode: 0 };
  },
};
