import type { FluffyCommand } from "../types.js";
/**
 * local - Declare local variables (shell built-in)
 *
 * In shell functions, local creates variables with local scope.
 * This implementation provides a stub that shells can recognize.
 *
 * Syntax:
 *   local VAR=value
 *   local VAR
 *   local -r VAR=value  (readonly)
 *   local -a ARRAY      (array)
 *   local -i INT        (integer)
 */
export declare const local: FluffyCommand;
export declare const declare: FluffyCommand;
export declare const readonly: FluffyCommand;
export declare const unset: FluffyCommand;
