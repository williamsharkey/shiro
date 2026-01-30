import type { FluffyCommand } from "../types.js";
/**
 * nohup - Run a command immune to hangups
 *
 * In Unix, nohup runs a command that continues running after the shell exits,
 * ignoring the HUP (hangup) signal. Output is redirected to nohup.out.
 *
 * In browser environment, this is a stub that acknowledges the command
 * but doesn't actually implement signal immunity (no real processes).
 *
 * Syntax:
 *   nohup COMMAND [ARG...]
 *
 * Example:
 *   nohup long-running-task &
 */
export declare const nohup: FluffyCommand;
