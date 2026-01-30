import type { FluffyCommand } from "../types.js";

/**
 * function - Define shell function (shell language construct)
 *
 * This is a placeholder for shell parsers. In a real shell, function definitions
 * are parsed as part of the shell language, not executed as a command.
 *
 * Syntax:
 *   function NAME {
 *     COMMANDS
 *   }
 *
 *   NAME() {
 *     COMMANDS
 *   }
 *
 * The shell should:
 * 1. Parse the entire function definition
 * 2. Store the function in the shell's namespace
 * 3. Execute function body when NAME is called
 * 4. Handle local variables and positional parameters
 * 5. Handle return statement
 */
export const functionCmd: FluffyCommand = {
  name: "function",
  description: "Define shell function (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "function: this is a shell language construct that must be interpreted by the shell\nUsage: function NAME { COMMANDS; } or NAME() { COMMANDS; }\n",
      exitCode: 2
    };
  },
};
