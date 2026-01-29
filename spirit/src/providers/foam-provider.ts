/**
 * FoamProvider: adapts Foam's VFS, Shell, and Terminal
 * to Spirit's OSProvider interface.
 *
 * Foam types (not imported to avoid hard dependency):
 *   VFS      — readFile(path): string, writeFile(path, content), readdir(path): Inode[], etc.
 *   Shell    — exec(input): {stdout, stderr, exitCode}
 *   Terminal — write(text), readFromUser(prompt): Promise<string>
 *
 * Key differences from Shiro:
 *   - VFS stores content as strings (not Uint8Array)
 *   - readdir() returns full inode objects (not just names)
 *   - Shell.exec() returns {stdout, stderr, exitCode} directly
 *   - Terminal is plain HTML (not xterm.js)
 *   - glob() returns absolute paths (we strip the base prefix)
 */

import type {
  OSProvider,
  FileInfo,
  StatResult,
  ShellResult,
  HostInfo,
} from "./types.js";

// Minimal type shapes for Foam objects (avoids import coupling)

interface FoamInode {
  path: string;
  type: "file" | "dir";
  mode: number;
  size: number;
  mtime: number;
  ctime: number;
  atime: number;
  content: string | null;
}

interface FoamVFS {
  cwd: string;
  env: Record<string, string>;
  readFile(path: string): Promise<string>;
  writeFile(
    path: string,
    content: string,
    options?: { append?: boolean }
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<FoamInode[]>;
  stat(path: string): Promise<FoamInode>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  glob(pattern: string, basePath?: string): Promise<string[]>;
  resolvePath(path: string): string;
}

interface FoamShell {
  exec(input: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

interface FoamTerminal {
  write(text: string): void;
  writeLine(text: string): void;
  readFromUser(prompt: string): Promise<string>;
}

export class FoamProvider implements OSProvider {
  private vfs: FoamVFS;
  private shell: FoamShell;
  private terminal: FoamTerminal;

  constructor(vfs: FoamVFS, shell: FoamShell, terminal: FoamTerminal) {
    this.vfs = vfs;
    this.shell = shell;
    this.terminal = terminal;
  }

  // -- Filesystem --

  async readFile(path: string): Promise<string> {
    const resolved = this.resolvePath(path);
    return this.vfs.readFile(resolved);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const resolved = this.resolvePath(path);
    await this.vfs.writeFile(resolved, content);
  }

  async mkdir(
    path: string,
    opts?: { recursive?: boolean }
  ): Promise<void> {
    const resolved = this.resolvePath(path);
    await this.vfs.mkdir(resolved, opts);
  }

  async readdir(path: string): Promise<FileInfo[]> {
    const resolved = this.resolvePath(path);
    const inodes = await this.vfs.readdir(resolved);
    return inodes.map((inode) => ({
      name: inode.path.split("/").pop()!,
      path: inode.path,
      type: inode.type as "file" | "dir" | "symlink",
      size: inode.size,
      mtime: inode.mtime,
    }));
  }

  async stat(path: string): Promise<StatResult> {
    const resolved = this.resolvePath(path);
    const inode = await this.vfs.stat(resolved);
    return {
      type: inode.type as "file" | "dir" | "symlink",
      size: inode.size,
      mtime: inode.mtime,
      isFile: () => inode.type === "file",
      isDirectory: () => inode.type === "dir",
    };
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolvePath(path);
    return this.vfs.exists(resolved);
  }

  async unlink(path: string): Promise<void> {
    const resolved = this.resolvePath(path);
    await this.vfs.unlink(resolved);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const resolved = this.resolvePath(oldPath);
    const resolvedNew = this.resolvePath(newPath);
    await this.vfs.rename(resolved, resolvedNew);
  }

  // -- Path / env --

  resolvePath(path: string): string {
    return this.vfs.resolvePath(path);
  }

  getCwd(): string {
    return this.vfs.cwd;
  }

  setCwd(path: string): void {
    this.vfs.cwd = this.resolvePath(path);
    this.vfs.env.PWD = this.vfs.cwd;
  }

  getEnv(): Record<string, string> {
    return { ...this.vfs.env };
  }

  // -- Search --

  async glob(pattern: string, base?: string): Promise<string[]> {
    const basePath = base ?? this.vfs.cwd;
    const results = await this.vfs.glob(pattern, basePath);
    // Foam returns absolute paths — strip base prefix for consistency
    const prefix = basePath === "/" ? "/" : basePath + "/";
    return results.map((p) =>
      p.startsWith(prefix) ? p.slice(prefix.length) : p
    );
  }

  // -- Shell --

  async exec(command: string): Promise<ShellResult> {
    const result = await this.shell.exec(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  // -- Terminal I/O --

  writeToTerminal(text: string): void {
    this.terminal.write(text);
  }

  readFromUser(prompt: string): Promise<string> {
    return this.terminal.readFromUser(prompt);
  }

  // -- Host info --

  getHostInfo(): HostInfo {
    return { name: "Foam", version: "0.1.0" };
  }
}
