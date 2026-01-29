/**
 * Minimal filesystem interface that both Shiro and Foam can satisfy.
 * Commands only depend on this — no host-specific imports.
 */

export interface FluffyFS {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<FluffyEntry[]>;
  stat(path: string): Promise<FluffyStat>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rmdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  resolvePath(path: string, cwd: string): string;
}

export interface FluffyEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
}

export interface FluffyStat {
  type: "file" | "dir";
  size: number;
  mode: number;
  mtime: number;
}

export interface CommandIO {
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  fs: FluffyFS;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FluffyCommand {
  name: string;
  description: string;
  exec(args: string[], io: CommandIO): Promise<CommandResult>;
}
