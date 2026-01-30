import type { FluffyCommand } from "../types.js";

/**
 * for - Iterate over list (shell language construct)
 *
 * This is a placeholder for shell parsers. In a real shell, the 'for' loop
 * is parsed as part of the shell language, not executed as a command.
 *
 * Syntax:
 *   for VAR in LIST; do
 *     COMMANDS
 *   done
 *
 *   for ((INIT; CONDITION; INCREMENT)); do
 *     COMMANDS
 *   done
 *
 * The shell should:
 * 1. Parse the entire for/done block
 * 2. Iterate over LIST items or arithmetic expression
 * 3. Set VAR to each item and execute COMMANDS
 * 4. Handle break and continue statements
 */
export const forCmd: FluffyCommand = {
  name: "for",
  description: "Iterate over list (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "for: this is a shell language construct that must be interpreted by the shell\nUsage: for VAR in LIST; do COMMANDS; done\n",
      exitCode: 2
    };
  },
};

export const inCmd: FluffyCommand = {
  name: "in",
  description: "Part of for loop (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "in: can only be used as part of a for loop or case statement\n",
      exitCode: 2
    };
  },
};
