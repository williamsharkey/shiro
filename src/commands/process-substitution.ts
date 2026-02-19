
/**
 * process-substitution - Helper for process substitution
 *
 * Process substitution is a shell feature that treats command output as a file:
 *   diff <(sort file1) <(sort file2)
 *   command > >(tee log.txt)
 *
 * This helper command assists shells in implementing process substitution.
 * This command is a stub that provides guidance for shell implementers.
 */
import type { Command } from './index';
export const processSubstitution: Command = {
  name: "process-substitution",
  description: "Helper for process substitution (shell feature)",
  async exec(ctx) {
    ctx.stdout += `process-substitution: This is a shell language feature, not a command.

Process substitution must be implemented at the shell parser level:

Syntax:
  <(command)  # Input substitution - command output as input file
  >(command)  # Output substitution - command input as output file

Example:
  diff <(sort file1.txt) <(sort file2.txt)

Shell implementers: Parse at lexer/parser level, execute before main command.
`;
    return 0;
  },
};
