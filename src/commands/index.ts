import type { FileSystem } from '../filesystem';
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
    this.commands.set(cmd.name, cmd);
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
