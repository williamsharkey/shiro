/**
 * Adapts Shiro's FileSystem and Shell to the FluffyFS/FluffyCommand interfaces
 * so fluffycoreutils commands can run in Shiro's shell.
 */

import { FileSystem } from './filesystem';
import { Command, CommandContext } from './commands/index';
import type { FluffyFS, FluffyEntry, FluffyStat, FluffyCommand } from '../fluffycoreutils/src/types';

/**
 * Wraps Shiro's FileSystem as a FluffyFS.
 * FluffyFS expects readFile to return string; Shiro returns Uint8Array|string.
 */
export function createFluffyFS(fs: FileSystem): FluffyFS {
  return {
    async readFile(path: string): Promise<string> {
      return await fs.readFile(path, 'utf8') as string;
    },
    async writeFile(path: string, content: string): Promise<void> {
      await fs.writeFile(path, content);
    },
    async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
      await fs.mkdir(path, opts);
    },
    async readdir(path: string): Promise<FluffyEntry[]> {
      const names = await fs.readdir(path);
      const entries: FluffyEntry[] = [];
      for (const name of names) {
        const childPath = path === '/' ? '/' + name : path + '/' + name;
        const stat = await fs.stat(childPath);
        entries.push({
          name,
          type: stat.isDirectory() ? 'dir' : 'file',
          size: stat.size,
          mtime: stat.mtime.getTime(),
        });
      }
      return entries;
    },
    async stat(path: string): Promise<FluffyStat> {
      const s = await fs.stat(path);
      return {
        type: s.isDirectory() ? 'dir' : 'file',
        size: s.size,
        mode: s.mode,
        mtime: s.mtime.getTime(),
      };
    },
    async exists(path: string): Promise<boolean> {
      return await fs.exists(path);
    },
    async unlink(path: string): Promise<void> {
      await fs.unlink(path);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      await fs.rename(oldPath, newPath);
    },
    async rmdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
      if (opts?.recursive) {
        await fs.rm(path, { recursive: true });
      } else {
        await fs.rmdir(path);
      }
    },
    resolvePath(path: string, cwd: string): string {
      return fs.resolvePath(path, cwd);
    },
  };
}

/**
 * Wraps a FluffyCommand as a Shiro Command.
 * Bridges the different interfaces:
 *   FluffyCommand.exec(args, io) → CommandResult
 *   Shiro Command.exec(ctx) → number (exit code), writes to ctx.stdout/stderr
 */
export function wrapFluffyCommand(fluffy: FluffyCommand): Command {
  return {
    name: fluffy.name,
    description: fluffy.description,
    async exec(ctx: CommandContext): Promise<number> {
      const fluffyFS = createFluffyFS(ctx.fs);
      const result = await fluffy.exec(ctx.args, {
        stdin: ctx.stdin,
        env: ctx.env,
        cwd: ctx.cwd,
        fs: fluffyFS,
      });
      ctx.stdout += result.stdout;
      ctx.stderr += result.stderr;
      return result.exitCode;
    },
  };
}
