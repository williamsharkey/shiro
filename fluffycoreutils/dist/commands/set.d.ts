import type { FluffyCommand } from "../types.js";
/**
 * set - Set or unset shell options and positional parameters
 *
 * This command controls shell behavior and manipulates positional parameters.
 *
 * Common options:
 *   -e: Exit immediately if a command exits with non-zero status
 *   -u: Treat unset variables as an error
 *   -x: Print commands before executing (debug mode)
 *   -v: Print shell input lines as they are read
 *   -n: Read commands but don't execute (syntax check)
 *   -o: Set option by name (e.g., set -o pipefail)
 *   --: End of options, treat remaining args as positional parameters
 *
 * Without options, displays all shell variables.
 */
export declare const set: FluffyCommand;
