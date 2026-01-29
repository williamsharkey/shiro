/**
 * SpiritCommand: canonical command interface for shared coreutils.
 *
 * Both Shiro and Foam can implement commands against this interface,
 * enabling a shared `spirit-coreutils` package. Each host wraps
 * SpiritCommands in its own native command format via an adapter.
 *
 * Example:
 *   const ls: SpiritCommand = {
 *     name: 'ls',
 *     description: 'List directory contents',
 *     async exec(args, io) {
 *       const entries = await io.fs.readdir(io.cwd);
 *       return { stdout: entries.map(e => e.name).join('\n'), stderr: '', exitCode: 0 };
 *     }
 *   };
 */

import type { OSProvider } from "./providers/types.js";

export interface CommandIO {
  /** Piped input from previous command (empty string if none) */
  stdin: string;
  /** Environment variables */
  env: Record<string, string>;
  /** Current working directory */
  cwd: string;
  /** Filesystem and shell access via the OSProvider */
  fs: OSProvider;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpiritCommand {
  name: string;
  description?: string;
  exec(args: string[], io: CommandIO): Promise<CommandResult>;
}
