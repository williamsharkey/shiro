import type { FluffyCommand } from "../types.js";
/**
 * trap - Trap signals and execute commands
 *
 * In real shells, trap sets up signal handlers. This implementation provides
 * a stub that shells can recognize for signal handling.
 *
 * Syntax:
 *   trap 'COMMANDS' SIGNAL...
 *   trap - SIGNAL...          (reset to default)
 *   trap -l                   (list signals)
 *   trap -p [SIGNAL...]       (print current traps)
 *
 * Common signals:
 *   EXIT, INT, TERM, HUP, QUIT, USR1, USR2, ERR, DEBUG, RETURN
 */
export declare const trap: FluffyCommand;
export declare const kill: FluffyCommand;
