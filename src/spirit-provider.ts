/**
 * ShiroProvider - Implements Spirit's OSProvider interface.
 *
 * This adapter wraps Shiro's FileSystem and Shell so Spirit's tools
 * (Bash, Read, Write, Edit, Glob, AskUser) can operate on the
 * virtual filesystem and terminal without knowing about Shiro internals.
 *
 * Spirit expects this interface:
 *   readFile, writeFile, mkdir, readdir, stat, exists, unlink, rename
 *   resolvePath, getCwd, setCwd, getEnv
 *   glob, exec, writeToTerminal, readFromUser, getHostInfo
 */

import { FileSystem } from './filesystem';
import { Shell } from './shell';

export interface FileInfo {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}

export interface StatResult {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtime: Date;
}

export interface OSProvider {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<FileInfo[]>;
  stat(path: string): Promise<StatResult>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  resolvePath(path: string): string;
  getCwd(): string;
  setCwd(path: string): void;
  getEnv(): Record<string, string>;
  glob(pattern: string, base?: string): Promise<string[]>;
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  writeToTerminal(text: string): void;
  readFromUser(prompt: string): Promise<string>;
  getHostInfo(): { name: string; version: string };
}

export class ShiroProvider implements OSProvider {
  private fs: FileSystem;
  private shell: Shell;
  private terminalWrite: (text: string) => void;
  private userInputResolver: ((input: string) => void) | null = null;

  constructor(
    fs: FileSystem,
    shell: Shell,
    terminalWrite: (text: string) => void,
  ) {
    this.fs = fs;
    this.shell = shell;
    this.terminalWrite = terminalWrite;
  }

  async readFile(path: string): Promise<string> {
    const resolved = this.fs.resolvePath(path, this.shell.cwd);
    return await this.fs.readFile(resolved, 'utf8') as string;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const resolved = this.fs.resolvePath(path, this.shell.cwd);
    // Auto-create parent directories
    const parentPath = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
    if (!await this.fs.exists(parentPath)) {
      await this.fs.mkdir(parentPath, { recursive: true });
    }
    await this.fs.writeFile(resolved, content);
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const resolved = this.fs.resolvePath(path, this.shell.cwd);
    await this.fs.mkdir(resolved, opts);
  }

  async readdir(path: string): Promise<FileInfo[]> {
    const resolved = this.fs.resolvePath(path, this.shell.cwd);
    const entries = await this.fs.readdir(resolved);
    const result: FileInfo[] = [];
    for (const name of entries) {
      const childPath = resolved === '/' ? '/' + name : resolved + '/' + name;
      const stat = await this.fs.stat(childPath);
      result.push({
        name,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        size: stat.size,
      });
    }
    return result;
  }

  async stat(path: string): Promise<StatResult> {
    const resolved = this.fs.resolvePath(path, this.shell.cwd);
    return await this.fs.stat(resolved);
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.fs.resolvePath(path, this.shell.cwd);
    return await this.fs.exists(resolved);
  }

  async unlink(path: string): Promise<void> {
    const resolved = this.fs.resolvePath(path, this.shell.cwd);
    const stat = await this.fs.stat(resolved);
    if (stat.isDirectory()) {
      await this.fs.rm(resolved, { recursive: true });
    } else {
      await this.fs.unlink(resolved);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const resolvedOld = this.fs.resolvePath(oldPath, this.shell.cwd);
    const resolvedNew = this.fs.resolvePath(newPath, this.shell.cwd);
    await this.fs.rename(resolvedOld, resolvedNew);
  }

  resolvePath(path: string): string {
    return this.fs.resolvePath(path, this.shell.cwd);
  }

  getCwd(): string {
    return this.shell.cwd;
  }

  setCwd(path: string): void {
    const resolved = this.fs.resolvePath(path, this.shell.cwd);
    this.shell.cwd = resolved;
    this.shell.env['PWD'] = resolved;
  }

  getEnv(): Record<string, string> {
    return { ...this.shell.env };
  }

  async glob(pattern: string, base?: string): Promise<string[]> {
    const resolvedBase = base
      ? this.fs.resolvePath(base, this.shell.cwd)
      : this.shell.cwd;
    return await this.fs.glob(pattern, resolvedBase);
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = '';
    let stderr = '';

    // Capture output instead of writing to terminal
    const exitCode = await this.shell.execute(command, (s: string) => {
      // Shell output has \r\n, normalize back to \n for tool results
      stdout += s.replace(/\r\n/g, '\n');
    });

    return { stdout, stderr, exitCode };
  }

  writeToTerminal(text: string): void {
    this.terminalWrite(text.replace(/\n/g, '\r\n'));
  }

  async readFromUser(prompt: string): Promise<string> {
    this.writeToTerminal(prompt);
    return new Promise<string>((resolve) => {
      this.userInputResolver = resolve;
    });
  }

  /** Called by the terminal when user submits input during a readFromUser prompt */
  resolveUserInput(input: string): void {
    if (this.userInputResolver) {
      const resolver = this.userInputResolver;
      this.userInputResolver = null;
      resolver(input);
    }
  }

  getHostInfo(): { name: string; version: string } {
    return { name: 'shiro', version: '0.1.0' };
  }
}
