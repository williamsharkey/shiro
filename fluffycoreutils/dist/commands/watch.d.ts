import type { FluffyCommand } from "../types.js";
/**
 * watch - Execute a program periodically, showing output
 *
 * In Unix, watch runs a command repeatedly at specified intervals,
 * displaying the output and updating the screen.
 *
 * In browser environment, this is a stub that acknowledges the command.
 * A real implementation would require:
 * - setInterval for periodic execution
 * - Terminal UI for updating display
 * - Integration with shell's command executor
 *
 * Syntax:
 *   watch [-n SECONDS] [-d] [-t] COMMAND
 *
 * Options:
 *   -n, --interval SECONDS  Specify update interval (default: 2)
 *   -d, --differences       Highlight changes between updates
 *   -t, --no-title         Turn off header
 *   -b, --beep             Beep if command has a non-zero exit
 *   -e, --errexit          Exit if command has a non-zero exit
 *   -g, --chgexit          Exit when output changes
 */
export declare const watch: FluffyCommand;
