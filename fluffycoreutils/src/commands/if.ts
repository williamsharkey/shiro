import type { FluffyCommand } from "../types.js";

/**
 * if - Conditional execution (shell language construct)
 *
 * This is a placeholder for shell parsers. In a real shell, the 'if' statement
 * is parsed as part of the shell language, not executed as a command.
 *
 * Syntax:
 *   if CONDITION; then
 *     COMMANDS
 *   elif CONDITION; then
 *     COMMANDS
 *   else
 *     COMMANDS
 *   fi
 *
 * The shell should:
 * 1. Parse the entire if/fi block
 * 2. Evaluate CONDITION commands
 * 3. Execute appropriate COMMANDS based on exit codes
 * 4. Handle elif/else branches
 */
export const ifCmd: FluffyCommand = {
  name: "if",
  description: "Conditional execution (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "if: this is a shell language construct that must be interpreted by the shell\nUsage: if CONDITION; then COMMANDS; [elif CONDITION; then COMMANDS;] [else COMMANDS;] fi\n",
      exitCode: 2
    };
  },
};

export const then: FluffyCommand = {
  name: "then",
  description: "Part of if/elif statement (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "then: can only be used as part of an if/elif statement\n",
      exitCode: 2
    };
  },
};

export const elif: FluffyCommand = {
  name: "elif",
  description: "Else-if branch (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "elif: can only be used as part of an if statement\n",
      exitCode: 2
    };
  },
};

export const elseCmd: FluffyCommand = {
  name: "else",
  description: "Else branch (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "else: can only be used as part of an if statement\n",
      exitCode: 2
    };
  },
};

export const fi: FluffyCommand = {
  name: "fi",
  description: "End if statement (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "fi: can only be used to close an if statement\n",
      exitCode: 2
    };
  },
};
