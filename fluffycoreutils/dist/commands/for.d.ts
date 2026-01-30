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
export declare const forCmd: FluffyCommand;
export declare const inCmd: FluffyCommand;
