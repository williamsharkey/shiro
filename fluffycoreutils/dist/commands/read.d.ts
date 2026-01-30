import type { FluffyCommand } from "../types.js";
/**
 * read - Read a line from stdin
 *
 * Reads a line from stdin and assigns it to variables.
 * In a real shell, this would be interactive and set shell variables.
 * This implementation reads from stdin and can set environment variables.
 *
 * Syntax:
 *   read [-r] [-p prompt] [-n nchars] [-t timeout] [-d delim] [var...]
 *
 * Options:
 *   -r: Do not allow backslashes to escape characters
 *   -p: Display prompt before reading
 *   -n: Read only N characters
 *   -t: Timeout after N seconds
 *   -d: Use DELIM as line delimiter instead of newline
 *   -a: Read into array (bash extension)
 *   -s: Silent mode (don't echo input)
 */
export declare const read: FluffyCommand;
