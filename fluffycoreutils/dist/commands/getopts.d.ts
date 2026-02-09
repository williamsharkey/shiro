import type { FluffyCommand } from "../types.js";
/**
 * getopts - Parse option arguments
 *
 * This is a shell built-in used to parse positional parameters and
 * extract options and their arguments.
 *
 * Syntax:
 *   getopts OPTSTRING NAME [args...]
 *
 * OPTSTRING format:
 *   - Letters are option characters
 *   - A colon after a letter means that option requires an argument
 *   - If OPTSTRING starts with :, silent error reporting mode
 *
 * Example:
 *   getopts "ab:c" opt
 *   # -a and -c are boolean flags
 *   # -b requires an argument
 *
 * In a real shell, getopts:
 *   - Sets NAME to the next option character
 *   - Sets OPTARG to option argument (if any)
 *   - Sets OPTIND to index of next argument
 *   - Returns 0 if option found, 1 if no more options
 *
 * This implementation provides a stub that recognizes the syntax.
 */
export declare const getopts: FluffyCommand;
