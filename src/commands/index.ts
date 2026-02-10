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
}

export interface Command {
  name: string;
  description: string;
  exec(ctx: CommandContext): Promise<number>;
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
