import type { FileSystem } from '../filesystem';
import { withHelpFlags } from './help-flags';
import type { Shell } from '../shell';

export interface TerminalLike {
  writeOutput(text: string): void;
  enterStdinPassthrough(cb: (data: string) => void, forceExitCb?: () => void): void;
  exitStdinPassthrough(): void;
  enterRawMode(cb: (key: string) => void): void;
  exitRawMode(): void;
  isRawMode(): boolean;
  onResize(cb: (cols: number, rows: number) => void): () => void;
  getSize(): { rows: number; cols: number };
  getBufferContent?(): string;
  term: any; // xterm.js Terminal instance
  /** The terminal's pty session (controlling tty, termios, foreground job) */
  tty?: import('../kernel/pty').TtySession;
}

export interface CommandContext {
  args: string[];
  fs: FileSystem;
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  stdout: string;
  stderr: string;
  shell: Shell;
  terminal?: TerminalLike;
  /** false when stdout goes to a pipe or file (ls then prints one name per line, like coreutils) */
  stdoutIsTTY?: boolean;
  /**
   * The command's stdin is fd 0 of the kernel process ctx.shell runs as, not
   * ctx.stdin: read it with ctx.shell.kernelStdio (src/shell-stdio.ts).
   * Reading ctx.stdin instead still works (the command then runs twice).
   */
  liveStdin?: boolean;
  /**
   * The command's stdin read to EOF, when it is a live stream the command
   * reads only if it wants to (node's process.stdin): awaited on first use,
   * so a program that never reads doesn't wait for a pipe that stays open
   */
  readStdin?: () => Promise<string>;
  /** stdin is the terminal, not a pipe, file or here-doc (set by the shell; unset: the terminal if there is one) */
  stdinIsTTY?: boolean;
  /** A live stdin read as its data arrives, chunks then null at EOF (a spawned node child's pipe: node-compat/live-stdin.ts) */
  stdinStream?: { read(): Promise<Uint8Array | null> };
  /** Byte writers that get the command's stdout/stderr as it writes them, bytes as written (a spawned node child's pipes) */
  stdoutBytes?: (b: Uint8Array) => void;
  stderrBytes?: (b: Uint8Array) => void;
  /** Writers that reach the command's stdout/stderr right away (set only where nothing captures them) */
  streamStdout?: (s: string) => void;
  streamStderr?: (s: string) => void;
}

export interface Command {
  name: string;
  description: string;
  exec(ctx: CommandContext): Promise<number>;
  /**
   * Run as a kernel process with direct access to its fds, instead of
   * exec() with string stdio (programs that talk a protocol over pipes, like
   * apt's transport methods). Used when the kernel starts the command.
   */
  program?: (proc: import('../kernel/process').Process, kernel: import('../kernel/kernel').Kernel) => Promise<number>;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(cmd: Command): void {
    // `CMD --help` / `CMD --version` work for every command (help-flags.ts)
    this.commands.set(cmd.name, withHelpFlags(cmd));
  }

  registerAll(cmds: Command[]): void {
    for (const cmd of cmds) this.register(cmd);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  list(): Command[] {
    return Array.from(this.commands.values());
  }
}
