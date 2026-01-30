import type { FluffyCommand } from "../types.js";

/**
 * while - Loop while condition is true (shell language construct)
 *
 * This is a placeholder for shell parsers. In a real shell, the 'while' loop
 * is parsed as part of the shell language, not executed as a command.
 *
 * Syntax:
 *   while CONDITION; do
 *     COMMANDS
 *   done
 *
 * The shell should:
 * 1. Parse the entire while/done block
 * 2. Repeatedly evaluate CONDITION commands
 * 3. Execute COMMANDS while condition returns exit code 0
 * 4. Handle break and continue statements
 */
export const whileCmd: FluffyCommand = {
  name: "while",
  description: "Loop while condition is true (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "while: this is a shell language construct that must be interpreted by the shell\nUsage: while CONDITION; do COMMANDS; done\n",
      exitCode: 2
    };
  },
};

export const until: FluffyCommand = {
  name: "until",
  description: "Loop until condition is true (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "until: this is a shell language construct that must be interpreted by the shell\nUsage: until CONDITION; do COMMANDS; done\n",
      exitCode: 2
    };
  },
};

export const doCmd: FluffyCommand = {
  name: "do",
  description: "Start loop body (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "do: can only be used as part of a for/while/until loop\n",
      exitCode: 2
    };
  },
};

export const done: FluffyCommand = {
  name: "done",
  description: "End loop (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "done: can only be used to close a for/while/until loop\n",
      exitCode: 2
    };
  },
};
