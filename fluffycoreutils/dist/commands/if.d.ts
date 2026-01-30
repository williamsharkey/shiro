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
export declare const ifCmd: FluffyCommand;
export declare const then: FluffyCommand;
export declare const elif: FluffyCommand;
export declare const elseCmd: FluffyCommand;
export declare const fi: FluffyCommand;
