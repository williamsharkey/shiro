
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
import type { Command } from './index';
export const whileCmd: Command = {
  name: "while",
  description: "Loop while condition is true (shell language construct)",
  async exec(ctx) {
    const args = ctx.args;
    ctx.stderr += "while: this is a shell language construct that must be interpreted by the shell\nUsage: while CONDITION; do COMMANDS; done\n";
    return 2;
  },
};

export const until: Command = {
  name: "until",
  description: "Loop until condition is true (shell language construct)",
  async exec(ctx) {
    const args = ctx.args;
    ctx.stderr += "until: this is a shell language construct that must be interpreted by the shell\nUsage: until CONDITION; do COMMANDS; done\n";
    return 2;
  },
};

export const doCmd: Command = {
  name: "do",
  description: "Start loop body (shell language construct)",
  async exec(ctx) {
    const args = ctx.args;
    ctx.stderr += "do: can only be used as part of a for/while/until loop\n";
    return 2;
  },
};

export const done: Command = {
  name: "done",
  description: "End loop (shell language construct)",
  async exec(ctx) {
    const args = ctx.args;
    ctx.stderr += "done: can only be used to close a for/while/until loop\n";
    return 2;
  },
};
