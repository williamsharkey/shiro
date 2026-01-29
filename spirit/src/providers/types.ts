export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
}

export interface StatResult {
  type: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HostInfo {
  name: string;
  version: string;
}

export interface OSProvider {
  // Filesystem
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<FileInfo[]>;
  stat(path: string): Promise<StatResult>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;

  // Path / env
  resolvePath(path: string): string;
  getCwd(): string;
  setCwd(path: string): void;
  getEnv(): Record<string, string>;

  // Search
  glob(pattern: string, base?: string): Promise<string[]>;

  // Shell
  exec(command: string): Promise<ShellResult>;

  // Terminal I/O
  writeToTerminal(text: string): void;
  readFromUser(prompt: string): Promise<string>;

  // Host info (for system prompt)
  getHostInfo(): HostInfo;
}
