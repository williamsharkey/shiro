/**
 * Adapts FluffyCommand → Shiro Command interface.
 * Bridges the different interfaces:
 *   FluffyCommand.exec(args, io) → CommandResult
 *   Shiro Command.exec(ctx) → number (exit code), writes to ctx.stdout/stderr
 */

import { FileSystem } from '../../filesystem';
import { Command, CommandContext } from '../index';
import type { FluffyFS, FluffyEntry, FluffyStat, FluffyCommand } from './types';

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
        // Use lstat to detect symlinks without following them
        const stat = await fs.lstat(childPath);
        const entry: FluffyEntry = {
          name,
          type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file',
          size: stat.size,
          mtime: stat.mtime.getTime(),
        };
        if (stat.isSymbolicLink()) {
          try { entry.target = await fs.readlink(childPath); } catch {}
        }
        entries.push(entry);
      }
      return entries;
    },
    async stat(path: string): Promise<FluffyStat> {
      const s = await fs.lstat(path);
      const result: FluffyStat = {
        type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : 'file',
        size: s.size,
        mode: s.isSymbolicLink() ? 0o777 : s.mode,
        mtime: s.mtime.getTime(),
      };
      if (s.isSymbolicLink()) {
        try { (result as any).target = await fs.readlink(path); } catch {}
      }
      return result;
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
    async chmod(path: string, mode: number): Promise<void> {
      await fs.chmod(path, mode);
    },
    async symlink(target: string, path: string): Promise<void> {
      await fs.symlink(target, path);
    },
    async readlink(path: string): Promise<string> {
      return await fs.readlink(path);
    },
    resolvePath(path: string, cwd: string): string {
      return fs.resolvePath(path, cwd);
    },
  };
}

/**
 * Wraps a FluffyCommand as a Shiro Command.
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
        exec: async (cmd: string) => {
          let stdout = '';
          let stderr = '';
          const exitCode = await ctx.shell.execute(cmd, (s: string) => { stdout += s; }, (s: string) => { stderr += s; });
          return { stdout, stderr, exitCode };
        },
      });
      ctx.stdout += result.stdout;
      ctx.stderr += result.stderr;
      return result.exitCode;
    },
  };
}
