/**
 * ShiroProvider: adapts Shiro's FileSystem, Shell, and Terminal
 * to Spirit's OSProvider interface.
 *
 * Shiro types (not imported to avoid hard dependency):
 *   FileSystem — readFile(path, 'utf8'), writeFile(path, string), mkdir, readdir (string[]), stat, etc.
 *   Shell      — execute(line, write: (s: string) => void): Promise<number>, cwd, env
 *   Terminal   — writeOutput(text: string)
 */

import type {
  OSProvider,
  FileInfo,
  StatResult,
  ShellResult,
  HostInfo,
} from "./types.js";

// Minimal type shapes for Shiro objects (avoids import coupling)
interface ShiroFileSystem {
  readFile(path: string, encoding?: "utf8"): Promise<Uint8Array | string>;
  writeFile(
    path: string,
    data: Uint8Array | string,
    options?: { mode?: number }
  ): Promise<void>;
  appendFile(path: string, data: Uint8Array | string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{
    type: "file" | "dir" | "symlink";
    size: number;
    mtime: Date;
    isFile(): boolean;
    isDirectory(): boolean;
  }>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  glob(pattern: string, base?: string): Promise<string[]>;
  resolvePath(path: string, cwd: string): string;
}

interface ShiroShell {
  cwd: string;
  env: Record<string, string>;
  execute(
    line: string,
    write: (s: string) => void,
    writeStderr?: (s: string) => void
  ): Promise<number>;
}

interface ShiroTerminal {
  writeOutput(text: string): void;
}

export class ShiroProvider implements OSProvider {
  private fs: ShiroFileSystem;
  private shell: ShiroShell;
  private terminal: ShiroTerminal;
  private userInputResolver: ((value: string) => void) | null = null;

  constructor(
    fs: ShiroFileSystem,
    shell: ShiroShell,
    terminal: ShiroTerminal
  ) {
    this.fs = fs;
    this.shell = shell;
    this.terminal = terminal;
  }

  // -- Filesystem --

  async readFile(path: string): Promise<string> {
    const resolved = this.resolvePath(path);
    const data = await this.fs.readFile(resolved, "utf8");
    return typeof data === "string" ? data : new TextDecoder().decode(data);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const resolved = this.resolvePath(path);
    await this.fs.writeFile(resolved, content);
  }

  async mkdir(
    path: string,
    opts?: { recursive?: boolean }
  ): Promise<void> {
    const resolved = this.resolvePath(path);
    await this.fs.mkdir(resolved, opts);
  }

  async readdir(path: string): Promise<FileInfo[]> {
    const resolved = this.resolvePath(path);
    const names = await this.fs.readdir(resolved);
    const result: FileInfo[] = [];
    for (const name of names) {
      const childPath =
        resolved === "/" ? "/" + name : resolved + "/" + name;
      const stat = await this.fs.stat(childPath);
      result.push({
        name,
        path: childPath,
        type: stat.type,
        size: stat.size,
        mtime: stat.mtime.getTime(),
      });
    }
    return result;
  }

  async stat(path: string): Promise<StatResult> {
    const resolved = this.resolvePath(path);
    const s = await this.fs.stat(resolved);
    return {
      type: s.type,
      size: s.size,
      mtime: s.mtime.getTime(),
      isFile: () => s.isFile(),
      isDirectory: () => s.isDirectory(),
    };
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolvePath(path);
    return this.fs.exists(resolved);
  }

  async unlink(path: string): Promise<void> {
    const resolved = this.resolvePath(path);
    await this.fs.unlink(resolved);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const resolved = this.resolvePath(oldPath);
    const resolvedNew = this.resolvePath(newPath);
    await this.fs.rename(resolved, resolvedNew);
  }

  // -- Path / env --

  resolvePath(path: string): string {
    return this.fs.resolvePath(path, this.shell.cwd);
  }

  getCwd(): string {
    return this.shell.cwd;
  }

  setCwd(path: string): void {
    this.shell.cwd = this.resolvePath(path);
  }

  getEnv(): Record<string, string> {
    return { ...this.shell.env };
  }

  // -- Search --

  async glob(pattern: string, base?: string): Promise<string[]> {
    const basePath = base ?? this.shell.cwd;
    return this.fs.glob(pattern, basePath);
  }

  // -- Shell --

  async exec(command: string): Promise<ShellResult> {
    let stdout = "";
    let stderr = "";
    const exitCode = await this.shell.execute(
      command,
      (s: string) => {
        stdout += s;
      },
      (s: string) => {
        stderr += s;
      }
    );
    return { stdout, stderr, exitCode };
  }

  // -- Terminal I/O --

  writeToTerminal(text: string): void {
    this.terminal.writeOutput(text);
  }

  readFromUser(prompt: string): Promise<string> {
    this.terminal.writeOutput(prompt + " ");
    return new Promise<string>((resolve) => {
      this.userInputResolver = resolve;
    });
  }

  /**
   * Call this from the terminal's input handler when the user
   * submits a line while Spirit is waiting for input.
   */
  resolveUserInput(input: string): void {
    if (this.userInputResolver) {
      const resolver = this.userInputResolver;
      this.userInputResolver = null;
      resolver(input);
    }
  }

  // -- Host info --

  getHostInfo(): HostInfo {
    return { name: "Shiro", version: "0.1.0" };
  }
}
