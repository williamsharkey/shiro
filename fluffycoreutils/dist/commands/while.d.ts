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
export declare const whileCmd: FluffyCommand;
export declare const until: FluffyCommand;
export declare const doCmd: FluffyCommand;
export declare const done: FluffyCommand;
