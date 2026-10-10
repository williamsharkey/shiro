/**
 * shell-stdio.ts — a shell running as a kernel process (`sh -c SCRIPT` in a
 * pipeline, a script started by the kernel) uses its process's fds 0-2 as its
 * stdin/stdout/stderr, like a real shell: kernel programs in the script get
 * the fds themselves, builtins that read stdin read fd 0 when they need it
 * (`read` a record at a time, so whatever follows is left for the next
 * command), and output goes to fd 1/2 as each command finishes. Without this
 * the shell read stdin to EOF before running anything and wrote its output
 * when it exited, so a script talking to its peer over pipes deadlocked.
 */
import type { Kernel } from './kernel/kernel';
import type { Process } from './kernel/process';
import type { OpenFile } from './kernel/fd';
import type { Command, CommandContext } from './commands/index';
import { decodeBytes, encodeText } from './utils/byte-text';

export class KernelStdio {
  private chain: Promise<void> = Promise.resolve();
  private readonly one = new Uint8Array(1);

  constructor(readonly kernel: Kernel, readonly proc: Process) {}

  /** Writers for fd 1 and 2: in order, after everything written before them */
  readonly out = (s: string): void => this.write(1, s);
  readonly err = (s: string): void => this.write(2, s);

  /** A writer for fd n of the process, in order with out/err */
  writerFor(fd: number): (s: string) => void {
    return (s) => this.write(fd, s);
  }

  /**
   * The process's other inherited output fds (3-9) become the shell's own, so
   * `echo x >&3` in the script, and programs it starts, reach them.
   */
  adoptFds(shell: { userFds: Map<number, unknown> }): void {
    for (let n = 3; n <= 9; n++) {
      const f = this.proc.fds.get(n);
      if (f && f.kind !== 'dir' && !shell.userFds.has(n)) shell.userFds.set(n, { writer: this.writerFor(n) });
    }
  }

  private write(fd: number, s: string): void {
    if (!s) return;
    const bytes = encodeText(s.replace(/\r\n/g, '\n'));
    this.chain = this.chain.then(async () => {
      if (!this.proc.exiting) await this.kernel.writeAll(this.proc, fd, bytes);
    });
  }

  /** Resolves once everything written so far has reached the fds (before a kernel program writes to them itself) */
  flush(): Promise<void> {
    return this.chain;
  }

  file(fd: number): OpenFile | undefined {
    return this.proc.fds.get(fd);
  }

  /** Read fd 0 to EOF */
  async readAll(): Promise<string> {
    const r = await this.kernel.readAll(this.proc, 0);
    return typeof r === 'number' ? '' : decodeBytes(r);
  }

  private async readByte(): Promise<number> {
    const f = this.proc.fds.get(0);
    if (!f) return -1;
    let n = f.tryRead?.(this.one);
    if (n === undefined) n = await f.read(this.one, this.proc.syscallSignal);
    return n > 0 ? this.one[0] : -1;
  }

  /**
   * Read one `read` record from fd 0 a byte at a time (as bash does on a
   * pipe), so nothing after it is taken from the next reader: up to and
   * including `delim` ('' = NUL; a backslash escapes it unless `raw`), or
   * `nchars` characters when that is >= 0 (`exact`, read -N: the delimiter
   * doesn't stop it). Returns the raw text read.
   */
  async readRecord(delim: string, nchars: number, raw: boolean, exact = false): Promise<string> {
    const d = delim === '' ? 0 : delim.charCodeAt(0);
    const bytes: number[] = [];
    let chars = 0;
    let escaped = false;
    for (;;) {
      if (nchars >= 0 && chars >= nchars) break;
      const b = await this.readByte();
      if (b < 0) break;
      bytes.push(b);
      // The rest of a UTF-8 sequence belongs to the same character
      const extra = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : 0;
      for (let k = 0; k < extra; k++) {
        const c = await this.readByte();
        if (c < 0) break;
        bytes.push(c);
      }
      chars++;
      if (exact) continue;
      if (!raw && b === 0x5c && !escaped) { escaped = true; continue; }
      if (b === d && !escaped) break;
      escaped = false;
    }
    return decodeBytes(new Uint8Array(bytes));
  }
}

/** Thrown by ctx.stdin the first time execLazyStdin's command reads it */
export class NeedStdin extends Error {
  constructor() { super('stdin not read yet'); }
}

/** Commands that read ctx.stdin late (node's process.stdin): read stdin before they start */
const EAGER_STDIN = new Set(['node', 'nodejs']);

/**
 * Run a command whose stdin is a stream it may never read. Most commands
 * don't look at stdin, and reading it to EOF first would block a script
 * whose peer waits for it (`sh -c 'mkdir d; prog'`). So ctx.stdin starts
 * out unread: the first read of it throws (NeedStdin, which ends the command
 * before it does much: commands read stdin, or copy ctx, early), and the
 * command runs again from the start with `readAll()`'s result. Its output
 * from the first try is dropped. Commands that know about this (sh) see
 * `ctx.liveStdin` and read the stream themselves.
 */
export async function execLazyStdin(cmd: Command, ctx: CommandContext, readAll: () => Promise<string>): Promise<number> {
  if (EAGER_STDIN.has(cmd.name)) {
    // node runs its program once (no rerun), so it can't use the NeedStdin
    // trick. With a script or -e/-p, process.stdin reads the stream when the
    // program asks (ctx.readStdin): one that never reads exits at once even if
    // the pipe stays open (an agent's shell). With neither, the program is
    // stdin, or on a terminal node starts its REPL.
    const programFromStdin = !ctx.args.some((a) => !a.startsWith('-') || /^(-e|--eval|-p|--print)$/.test(a)) &&
      !(ctx.stdinIsTTY && ctx.terminal);
    if (programFromStdin) {
      ctx.stdin = await readAll();
      return cmd.exec(ctx);
    }
    let once: Promise<string> | null = null;
    ctx.stdin = '';
    ctx.readStdin = () => (once ??= readAll());
    return cmd.exec(ctx);
  }
  const args = [...ctx.args];
  const { stdout, stderr } = ctx;
  let wanted = false;
  const setStdin = (v: string) => Object.defineProperty(ctx, 'stdin', { value: v, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(ctx, 'stdin', {
    enumerable: true, configurable: true,
    get: () => { wanted = true; throw new NeedStdin(); },
    set: setStdin,
  });
  ctx.liveStdin = true;
  let code: number;
  try {
    code = await cmd.exec(ctx);
  } catch (e) {
    if (!wanted) throw e;
    code = 1;
  }
  if (!wanted) return code;
  ctx.args = args;
  ctx.stdout = stdout;
  ctx.stderr = stderr;
  ctx.liveStdin = false;
  setStdin(await readAll());
  return cmd.exec(ctx);
}
