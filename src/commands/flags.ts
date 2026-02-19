/**
 * Shared utilities for command argument parsing and filesystem helpers.
 */

import type { FileSystem } from '../filesystem';

export interface ParsedArgs {
  flags: Record<string, boolean>;
  values: Record<string, string>;
  positional: string[];
}

/**
 * Parse command arguments into flags, values, and positional args.
 * @param args - raw argument array
 * @param valueFlags - flags that consume the next argument as a value (e.g., ["n"])
 */
export function parseArgs(args: string[], valueFlags: string[] = []): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const valueFlagSet = new Set(valueFlags);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valueFlagSet.has(name) && i + 1 < args.length) {
        values[name] = args[++i];
      } else {
        flags[name] = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) {
      const chars = arg.slice(1);

      // Check if the entire string after - matches a long-form value flag
      // (e.g., -name matches value flag "name", -type matches "type")
      if (valueFlagSet.has(chars) && i + 1 < args.length) {
        values[chars] = args[++i];
      } else {
        // Combined short flags: -rf → r=true, f=true
        // Value flag: -n 10 → n="10"
        for (let j = 0; j < chars.length; j++) {
          const ch = chars[j];
          if (valueFlagSet.has(ch)) {
            // Rest of chars or next arg is the value
            const rest = chars.slice(j + 1);
            if (rest) {
              values[ch] = rest;
            } else if (i + 1 < args.length) {
              values[ch] = args[++i];
            }
            break;
          }
          flags[ch] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, values, positional };
}

/**
 * Read input from either files or stdin.
 * If positional args are present, read files. Otherwise use stdin.
 */
export async function readInput(
  positional: string[],
  stdin: string,
  fs: { readFile(path: string, encoding?: string): Promise<string | Uint8Array> },
  cwd: string,
  resolvePath: (path: string, cwd: string) => string
): Promise<{ content: string; files: string[] }> {
  if (positional.length === 0) {
    return { content: stdin, files: [] };
  }
  const files: string[] = [];
  const parts: string[] = [];
  for (const p of positional) {
    const resolved = resolvePath(p, cwd);
    files.push(resolved);
    parts.push(await fs.readFile(resolved, 'utf8') as string);
  }
  return { content: parts.join(""), files };
}

/**
 * Read a file as text (convenience wrapper that always returns string).
 */
export async function readFileText(fs: FileSystem, path: string): Promise<string> {
  return (await fs.readFile(path, 'utf8')) as string;
}

/** Directory entry with metadata (replaces FluffyEntry). */
export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
  mode?: number;
  target?: string;
}

/** Stat result as a plain object (replaces FluffyStat). */
export interface StatEntry {
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mode: number;
  mtime: number;
  target?: string;
}

/**
 * Read directory entries with metadata (name, type, size, mtime).
 * Uses lstat to detect symlinks without following them.
 */
export async function readdirEntries(fs: FileSystem, path: string): Promise<DirEntry[]> {
  const names = await fs.readdir(path);
  const entries: DirEntry[] = [];
  for (const name of names) {
    const childPath = path === '/' ? '/' + name : path + '/' + name;
    const stat = await fs.lstat(childPath);
    const entry: DirEntry = {
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
}

/**
 * Get file stat as a plain object (type, size, mode, mtime).
 * Uses lstat to detect symlinks.
 */
export async function statEntry(fs: FileSystem, path: string): Promise<StatEntry> {
  const s = await fs.lstat(path);
  const result: StatEntry = {
    type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : 'file',
    size: s.size,
    mode: s.isSymbolicLink() ? 0o777 : s.mode,
    mtime: s.mtime.getTime(),
  };
  if (s.isSymbolicLink()) {
    try { result.target = await fs.readlink(path); } catch {}
  }
  return result;
}
