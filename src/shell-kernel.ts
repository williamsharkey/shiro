/**
 * shell-kernel.ts — run programs typed at the prompt as kernel processes.
 *
 * Builtins and JS commands stay in-page. Programs the shell finds on PATH
 * that are WASM (`.wasm`, `#!wasi-pkg` stubs) or x86-64 ELF (`#!x86-pkg`
 * stubs, ELF files) run as kernel processes instead: a run of such segments
 * in a pipeline is spawned at once, joined by kernel pipes, in one process
 * group under the terminal's pty session (`TtySession.spawnJob`), and waited
 * for with `runKernelJob`, so they get a real controlling tty and Ctrl-C,
 * Ctrl-Z, fg, bg, jobs and kill work. Builtin segments on either side of the
 * run feed it and read its output as strings, as before.
 */
import type { Shell } from './shell';
import type { TerminalLike, CommandContext } from './commands/index';
import type { Runner, Kernel } from './kernel/kernel';
import type { Process } from './kernel/process';
import type { OpenFile } from './kernel/fd';
import * as A from './kernel/abi';
import { packageOfPath, packageShadows, packageKernelProgram } from './pkg-manager';
import { nodeKernelProgram } from './node-worker/boot';
import { elfInterpreter, missingInterpreterMessage } from './elf-interp';

/** Bash builtins the shell implements inline (never looked up on PATH) */
const SHELL_BUILTINS = new Set([
  '.', ':', '[', '[[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen',
  'complete', 'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec',
  'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let',
  'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly',
  'return', 'select', 'set', 'shift', 'shopt', 'source', 'test', 'time', 'trap', 'true', 'type',
  'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait', 'coproc', 'timeout', 'sh', 'bash', 'zsh',
]);

export interface KernelProgram {
  argv: string[];
  /** The program's path when argv[0] isn't it (`exec -a NAME prog`) */
  path?: string;
  run: Runner;
  /** A Shiro builtin run through kernel.runBuiltin (not a WASM/x86 program) */
  builtin?: boolean;
  /** Environment defaults from the package (the job's own values win) */
  env?: Record<string, string>;
}

const dec = new TextDecoder();
const isWasmBytes = (b: Uint8Array) => b.length >= 4 && b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
const isElfBytes = (b: Uint8Array) => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;

/** Should `name` be looked up as a kernel program at all? (not a builtin, function, alias or JS command) */
export function mayBeKernelProgram(shell: Shell, name: string, args?: string[]): boolean {
  if (!name || SHELL_BUILTINS.has(name) || shell.functions[name] || shell.aliases.has(name)) return false;
  // An installed package's command replaces a builtin of the same name (pkg-manager.ts),
  // except where the builtin keeps these arguments (Command.keepOverPackage)
  const cmd = shell.commands.get(name);
  if (!cmd || (shell.pkgShadowBypass !== name && packageShadows(shell.fs).has(name) && !(args && cmd.keepOverPackage?.(args)))) return true;
  // node as a kernel guest (the default; TABCOMPUTER_NODE_WORKER=0 keeps the builtin)
  return !!nodeKernelProgram(shell.env, name, [], (shell as any).terminal);
}

/**
 * Resolve a command to a kernel program: WASM or x86-64 ELF found on PATH
 * (or by path). Returns null for everything else (scripts, node programs,
 * builtins), and for WASM when this page can't run WASM processes.
 */
export async function resolveKernelProgram(
  shell: Shell, name: string, args: string[], progress?: (msg: string) => void,
): Promise<KernelProgram | null> {
  if (!mayBeKernelProgram(shell, name)) return null;
  if (shell.commands.get(name) && !(shell.pkgShadowBypass !== name && packageShadows(shell.fs).has(name))) return nodeKernelProgram(shell.env, name, args, (shell as any).terminal);
  const found = await shell.findExecutableInPath(name);
  if (!found) return null;
  let path = found;
  try { path = await shell.fs.realpath(found); } catch { /* keep the PATH entry */ }
  let bytes: Uint8Array;
  try {
    const st = await shell.fs.stat(path);
    if (st.type === 'dir') return null;
    const data = await shell.fs.readFile(path);
    bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  } catch {
    return null;
  }
  const base = name.slice(name.lastIndexOf('/') + 1);
  // pkg-installed binaries carry their own arguments, preopens and kernel gate
  if (packageOfPath(path) && (isWasmBytes(bytes) || isElfBytes(bytes))) return packageKernelProgram(shell.fs, path, base, args, found.startsWith('/') ? found : shell.fs.resolvePath(found, shell.cwd));
  const { wasmProcessMode, wasmRunner } = await import('./wasi/host');

  if (isWasmBytes(bytes)) {
    if (wasmProcessMode() === 'none') return null;
    const image = new Uint8Array(bytes);
    const module = await WebAssembly.compile(image);
    return { argv: [base, ...args], run: wasmRunner(module, image) };
  }
  if (isElfBytes(bytes)) {
    // A dynamic executable without its loader (a glibc program before
    // `debian install`): bash's message and 127, not a silent exit
    const interp = elfInterpreter(bytes);
    if (interp && !(await shell.fs.stat(interp).then(() => true, () => false))) {
      const msg = new TextEncoder().encode(missingInterpreterMessage(name, interp));
      return { argv: [name, ...args], run: async (proc) => { await proc.fds.get(2)?.write(msg); return 127; } };
    }
    // Blink (wasm) when the page can run it, else the src/x86 interpreter
    const { chooseElfRunner } = await import('./x86-engine');
    const { x86Runner } = await import('./x86/kernel-runner');
    // argv[0] is the name as typed (a symlink's, not its target's: busybox applets,
    // Debian's redis-server -> redis-check-rdb); the runner loads the resolved `path`
    return { argv: [name, ...args], run: await chooseElfRunner(path, shell.env, () => x86Runner(bytes, name)) };
  }
  if (bytes[0] !== 0x23 /* # */) return null;
  const firstLine = dec.decode(bytes.subarray(0, Math.min(bytes.length, 256))).split('\n')[0];
  if (firstLine.startsWith('#!wasi-pkg ')) {
    if (wasmProcessMode() === 'none') return null;
    const pkg = firstLine.slice('#!wasi-pkg '.length).trim();
    const { getCompiledModule } = await import('./wasi-packages');
    const module = await getCompiledModule(pkg, (m) => progress?.(m));
    return { argv: [pkg, ...args], run: wasmRunner(module) };
  }
  if (firstLine.startsWith('#!x86-pkg ')) {
    const [pkg, applet] = firstLine.slice('#!x86-pkg '.length).trim().split(/\s+/);
    const { getX86Binary } = await import('./x86-packages');
    const elf = await getX86Binary(pkg, (m) => progress?.(m));
    const argv0 = applet || pkg;
    const { x86Runner } = await import('./x86/kernel-runner');
    return { argv: [argv0, ...args], run: x86Runner(elf, argv0) };
  }
  return null;
}

/**
 * Registered commands that are plain stdin→stdout filters. Next to a kernel
 * program in a pipeline they run as kernel processes too (kernel.runBuiltin),
 * so the whole pipeline is one job joined by real pipes. Anything that wants
 * the terminal (less, vi, node, claude, ...) is left out and stays in-page.
 */
const PIPE_FILTERS = new Set([
  'cat', 'tac', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'tr', 'wc', 'head', 'tail', 'sort', 'uniq', 'cut',
  'paste', 'rev', 'nl', 'fold', 'fmt', 'expand', 'unexpand', 'column', 'tee', 'base64', 'md5sum', 'sha1sum',
  'sha256sum', 'od', 'hexdump', 'xxd', 'strings', 'jq', 'echo', 'printf', 'seq', 'yes', 'comm', 'join',
  'gzip', 'gunzip', 'zcat', 'iconv',
]);

/** A pipe-filter builtin as a kernel stage, or null */
export function builtinStage(shell: Shell, name: string, args: string[]): KernelProgram | null {
  if (!PIPE_FILTERS.has(name) || shell.functions[name] || shell.aliases.has(name)) return null;
  // An installed package's program replaces the builtin (pkg-manager.ts)
  if (shell.pkgShadowBypass !== name && packageShadows(shell.fs).has(name)) return null;
  const cmd = shell.commands.get(name);
  if (!cmd) return null;
  return { argv: [name, ...args], run: (proc, kernel) => kernel.runBuiltin(proc, cmd), builtin: true };
}

export interface KernelRunOptions {
  /** Shell-provided stdin for the first stage (pipe from a builtin, `<`, heredoc); undefined = the terminal */
  stdin?: string;
  /** Collect the last stage's stdout (it feeds a builtin or a redirect) instead of letting it reach the terminal */
  captureStdout: boolean;
  /** Collect stderr too (the last segment has redirects) */
  captureStderr: boolean;
  /** The last stage's stdout goes to this file (`> f`, `>> f`), opened by the kernel */
  stdoutTo?: { path: string; append: boolean };
  /** stderr to a file (`2> f`), or wherever stdout goes (`2>&1`) */
  stderrTo?: { path: string; append: boolean } | 'stdout';
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  terminal?: TerminalLike;
  /** Text for the job table */
  command: string;
  background?: boolean;
  cwd: string;
  env: Record<string, string>;
  /**
   * Files to use as the first stage's stdin and the last stage's stdout and
   * stderr instead (the fds of a shell running as a kernel process,
   * shell-stdio.ts); a missing one falls back to the options above.
   */
  fds?: { 0?: OpenFile; 1?: OpenFile; 2?: OpenFile };
  /**
   * The shell's own fds 3-9 (exec 3>file, exec 4>&1, exec 5<in), which every
   * program inherits: a file to append to, a stream to write to, or input text.
   */
  inheritFds?: { fd: number; path?: string; file?: OpenFile; write?: (s: string) => void; content?: string }[];
}

export interface KernelRunResult {
  exitCode: number;
  /** Shell status of each stage, for PIPESTATUS */
  statuses: number[];
  stdout: string;
  stderr: string;
}

async function kernelFor(shell: Shell): Promise<Kernel> {
  const { kernelForContext } = await import('./wasi/run-command');
  const { attachKernelTty } = await import('./kernel/pty');
  const kernel = kernelForContext({ fs: shell.fs, shell } as unknown as CommandContext);
  attachKernelTty(kernel);
  return kernel;
}

/** Spawn `programs` as one pipeline job and wait for it (or put it in the background). */
export async function runKernelPipeline(shell: Shell, programs: KernelProgram[], opts: KernelRunOptions): Promise<KernelRunResult> {
  const kernel = await kernelFor(shell);
  const { BufferFile } = await import('./kernel/fd');
  const { createPipe } = await import('./kernel/pipe');
  const { SinkFile } = await import('./wasi/stdio');
  const { runKernelJob } = await import('./commands/jobs');
  const { shellStatus } = await import('./kernel/signals');

  const tty = opts.terminal?.tty;
  let stdout = '';
  let stderr = '';
  const slave = tty ? tty.openSlave() : null;
  // A shell running as a kernel process hands its own fds down
  const host = !tty && shell.kernelHost && shell.kernelHost.kernel === kernel && !shell.kernelHost.proc.exiting ? shell.kernelHost.proc : null;
  // (A shell with kernelStdio decides per command which of them apply: opts.fds)
  const fds = opts.fds;
  const hostFd = (fd: number) => (fds ? fds[fd as 0 | 1 | 2] : host?.fds.get(fd));
  const openOut = async (to: { path: string; append: boolean }): Promise<OpenFile | string> => {
    const { Process } = await import('./kernel/process');
    const probe = new Process({ pid: -1, ppid: 1, path: 'sh', argv: ['sh'], env: opts.env, cwd: opts.cwd });
    const f = await kernel.open(probe, to.path, A.O_WRONLY | A.O_CREAT | (to.append ? A.O_APPEND : A.O_TRUNC), 0o666);
    return typeof f === 'number' ? `${to.path}: ${f === -A.EISDIR ? 'Is a directory' : f === -A.ENOENT ? 'No such file or directory' : 'Permission denied'}` : f;
  };
  const toFile = opts.stdoutTo ? await openOut(opts.stdoutTo) : undefined;
  const errFile = opts.stderrTo && opts.stderrTo !== 'stdout' ? await openOut(opts.stderrTo) : undefined;
  for (const f of [toFile, errFile]) {
    if (typeof f === 'string') {
      opts.writeStderr(`sh: ${f}\n`);
      if (slave) void slave.close();
      if (typeof toFile === 'object') void toFile.close();
      if (typeof errFile === 'object') void errFile.close();
      return { exitCode: 1, statuses: programs.map(() => 1), stdout: '', stderr: '' };
    }
  }
  const stdin0: OpenFile = opts.stdin !== undefined ? new BufferFile(opts.stdin, A.O_RDONLY) : (slave ?? hostFd(0) ?? new BufferFile('', A.O_RDONLY));
  const lastOut: OpenFile = (toFile as OpenFile | undefined) ?? (opts.captureStdout
    ? new SinkFile((t) => { stdout += t; })
    : slave ?? hostFd(1) ?? new SinkFile((t) => opts.writeStdout(t)));
  const errOut: OpenFile = (opts.stderrTo === 'stdout' ? lastOut : errFile as OpenFile | undefined) ?? (opts.captureStderr
    ? new SinkFile((t) => { stderr += t; })
    : slave ?? hostFd(2) ?? new SinkFile((t) => opts.writeStderr(t)));

  // The shell's internal variables (__PIPE_STDIN: piped input being read) aren't the program's
  const env = Object.fromEntries(Object.entries(opts.env).filter(([k]) => !k.startsWith('__')));
  if (tty) {
    env.TERM ??= 'xterm-256color';
    // Programs ask the tty for its size; stale exported values would override it
    delete env.COLUMNS;
    delete env.LINES;
  }

  // fds 3-9 of the shell, the same open files for every stage
  const extra: Record<number, OpenFile> = {};
  for (const f of opts.inheritFds ?? []) {
    if (f.file) {
      extra[f.fd] = f.file;
    } else if (f.path !== undefined) {
      const o = await openOut({ path: f.path, append: true });
      if (typeof o !== 'string') extra[f.fd] = o;
    } else if (f.write) {
      const w = f.write;
      extra[f.fd] = new SinkFile((t) => w(t.replace(/\r?\n/g, '\r\n')));
    } else if (f.content !== undefined) {
      extra[f.fd] = new BufferFile(f.content, A.O_RDONLY);
    }
  }

  // Under timeout (its abort says so) the job leads a group of its own even in a hosted shell
  const ownGroup = !!(shell.abortController as { ownProcessGroup?: boolean } | null)?.ownProcessGroup;
  const procs: Process[] = [];
  let input = stdin0;
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i];
    let out: OpenFile;
    let nextInput: OpenFile | null = null;
    if (i === programs.length - 1) out = lastOut;
    else [nextInput, out] = createPipe();
    const spawn = {
      path: p.path ?? p.argv[0], argv: p.argv, env: p.env ? { ...p.env, ...env } : env, cwd: opts.cwd,
      fds: { ...extra, 0: input, 1: out, 2: errOut }, run: p.run,
      // children of a hosted shell stay in its process group, under it
      pgid: host && !shell.options.has('monitor') && !ownGroup ? undefined : procs.length ? procs[0].pgid : 0,
      parent: host ?? undefined,
      uid: shell.uid,
    };
    const proc = tty ? tty.spawnJob(kernel, spawn) : kernel.spawn(spawn);
    proc.umask = shell.umask; // (the shell's umask builtin, not the parent process's)
    procs.push(proc);
    if (nextInput) input = nextInput;
  }
  // The children's fd tables hold the slave; if none took it, give it back
  if (slave && stdin0 !== slave && lastOut !== slave && errOut !== slave) void slave.close();

  const pgid = procs[0].pgid;
  const pids = procs.map((p) => p.pid);
  // (straight to xterm, which doesn't turn \n into \r\n: `[1]+ Stopped` must end its line)
  const termWrite = (s: string) => (opts.terminal ? opts.terminal.writeOutput(s.replace(/\r?\n/g, '\r\n')) : opts.writeStdout(s));

  if (opts.background) {
    const code = await runKernelJob(shell, { command: opts.command, pgid, pids, background: true, tty, write: termWrite });
    return { exitCode: code, statuses: pids.map(() => 0), stdout, stderr };
  }

  // Aborts from the shell (timeout, a script's Ctrl-C) reach the whole job:
  // SIGINT, or the signal the abort names (timeout -s SIG -k DURATION)
  const abort = shell.abortController;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    const reason = abort?.signal.reason as { signal?: number; killAfter?: number } | undefined;
    kernel.kill(-pgid, typeof reason?.signal === 'number' ? reason.signal : A.SIGINT);
    if (typeof reason?.killAfter === 'number') {
      killTimer = setTimeout(() => { if (procs.some((p) => p.alive)) kernel.kill(-pgid, A.SIGKILL); }, reason.killAfter);
    }
  };
  abort?.signal.addEventListener('abort', onAbort);
  let exitCode: number;
  try {
    if (tty) {
      exitCode = await runKernelJob(shell, { command: opts.command, pgid, pids, tty, write: termWrite });
    } else {
      await Promise.all(procs.map((p) => p.wait()));
      for (const p of procs) await kernel.waitpid(p.pid, A.WNOHANG);
      exitCode = shellStatus(procs[procs.length - 1].exitStatus ?? 0);
    }
  } finally {
    abort?.signal.removeEventListener('abort', onAbort);
    clearTimeout(killTimer);
  }
  const stopped = exitCode > 128 && procs.some((p) => p.state === 'stopped');
  const statuses = procs.map((p) => (p.exitStatus !== undefined ? shellStatus(p.exitStatus) : exitCode));
  // bash reports the last stage's status for a pipeline
  if (!stopped && procs[procs.length - 1].exitStatus !== undefined) exitCode = statuses[statuses.length - 1];
  return { exitCode, statuses, stdout, stderr };
}
