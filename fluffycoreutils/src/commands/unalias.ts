import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const unalias: FluffyCommand = {
  name: "unalias",
  description: "Remove alias definitions",
  async exec(args, io) {
    const { positional, flags } = parseArgs(args);

    if (positional.length === 0 && !flags.a) {
      return {
        stdout: "",
        stderr: "unalias: usage: unalias [-a] name [name ...]\n",
        exitCode: 2
      };
    }

    // In a real shell, this would remove aliases from shell context
    // -a: remove all aliases

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
