import { ipcLine, ipcReader } from '../ipc';
import { stdinPipe } from '../live-stdin';
import type { CommandContext } from '../../commands/index';
import { parseShellArgs } from '../../shell-args';
import { activeProfile } from '../../profile';

/** Marks the wait a running child (ref()'d) puts on its parent: process.exit() doesn't wait for it */
export const CHILD_HOLD = Symbol('child hold');
const childWait = <T>(p: Promise<T>): Promise<T> => Object.assign(p, { [CHILD_HOLD]: true });

export interface ChildProcessDeps {
  ctx: CommandContext;
  fileCache: Map<string, string>;
  fileMtimes: Map<string, number>;
  pendingPromises: Promise<any>[];
  FakeBuffer: any;
  /** The parent's process: inherited stdio writes to its stdout/stderr */
  getProcess?: () => any;
  /** As a kernel guest (node-worker): children are real processes, the sync calls really block */
  guest?: import('../../node-worker/hooks').NodeGuestHooks;
}

export function createChildProcessModule(deps: ChildProcessDeps): any {
  const { ctx, fileCache, fileMtimes, pendingPromises, FakeBuffer } = deps;
  /** Whether spawn's stdio[i] is the parent's own stream ('inherit', the fd number, or process.stdout/stderr). */
  /** pbcopy & co.: the browser's clipboard (a kernel guest has none of its own: the page writes it) */
  const toClipboard = (text: string) => {
    if (deps.guest?.page) { deps.guest.page.clipboard(text); return; }
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  const inherits = (stdio: any, i: number): boolean => {
    if (stdio === 'inherit') return true;
    if (!Array.isArray(stdio)) return false;
    const s = stdio[i];
    if (s === 'inherit' || s === i) return true;
    const proc = deps.getProcess?.();
    return !!proc && s != null && s === (i === 1 ? proc.stdout : i === 2 ? proc.stderr : proc.stdin);
  };
  const ignores = (stdio: any, i: number): boolean => stdio === 'ignore' || (Array.isArray(stdio) && stdio[i] === 'ignore');

  // Synchronous fast-path responses for version/detection checks.
  // spawnSync/execSync/execFileSync are async under the hood but some callers
  // read stdout synchronously. Pre-populate known safe responses so the CLI
  // sees the right answer without awaiting.
  const getSyncResponse = (cmd: string): { stdout: string; stderr: string; status: number } | null => {
    // Strip shell wrapper: /bin/sh -c "git --version" → git --version
    let trimmed = cmd.trim();
    const shellMatch = trimmed.match(/^\/bin\/(?:sh|bash|zsh)\s+(?:-\w+\s+)*-\w*c\s+["']?(.+?)["']?$/);
    if (shellMatch) trimmed = shellMatch[1].trim();
    // Version/detection checks
    if (/^git\s+--version$/.test(trimmed)) {
      return { stdout: 'git version 2.47.0\n', stderr: '', status: 0 };
    }
    if (/^(which|command\s+-v)\s+git$/.test(trimmed)) {
      return { stdout: '/usr/local/bin/git\n', stderr: '', status: 0 };
    }
    // pwd
    if (trimmed === 'pwd') {
      return { stdout: ctx.cwd + '\n', stderr: '', status: 0 };
    }
    // echo (only handle simple cases — fall through to async for shell operators)
    if (/^echo\s/.test(trimmed) || trimmed === 'echo') {
      const echoArg = trimmed === 'echo' ? '' : trimmed.slice(5);
      // If the echo args contain shell operators, fall through to async
      if (/&&|\|\||[;|]/.test(echoArg) && !/^['"].*['"]$/.test(echoArg)) {
        return null;
      }
      // Expand env vars in echo args
      let expanded = echoArg.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, k: string) => ctx.env[k] || '');
      // Strip outer quotes (shell would do this)
      expanded = expanded.replace(/^["']|["']$/g, '');
      return { stdout: expanded + '\n', stderr: '', status: 0 };
    }
    // cat <file> — read from fileCache for synchronous access
    const catMatch = trimmed.match(/^cat\s+(.+)$/);
    if (catMatch) {
      const catPath = catMatch[1].trim().replace(/^["']|["']$/g, '');
      const resolved = ctx.fs.resolvePath(catPath, ctx.cwd);
      const cached = fileCache.get(resolved);
      if (cached !== undefined) {
        return { stdout: cached, stderr: '', status: 0 };
      }
    }
    // true / : → empty, status 0
    if (trimmed === 'true' || trimmed === ':') {
      return { stdout: '', stderr: '', status: 0 };
    }
    // false → status 1
    if (trimmed === 'false') {
      return { stdout: '', stderr: '', status: 1 };
    }
    // node --version / node -v
    if (/^node\s+(--version|-v)$/.test(trimmed)) {
      return { stdout: 'v22.12.0\n', stderr: '', status: 0 };
    }
    // npm --version
    if (/^npm\s+--version$/.test(trimmed)) {
      return { stdout: '10.0.0\n', stderr: '', status: 0 };
    }
    // uname variants
    if (/^uname(\s|$)/.test(trimmed)) {
      const flags = trimmed.slice(5).trim();
      if (flags === '-s' || flags === '') return { stdout: 'Linux\n', stderr: '', status: 0 };
      if (flags === '-m') return { stdout: 'x86_64\n', stderr: '', status: 0 };
      if (flags === '-n') return { stdout: `${activeProfile().hostname}\n`, stderr: '', status: 0 };
      if (flags === '-r') return { stdout: '0.1.0\n', stderr: '', status: 0 };
      if (flags === '-a') return { stdout: `Linux ${activeProfile().hostname} 0.1.0 x86_64\n`, stderr: '', status: 0 };
    }
    // which/command -v for known commands
    const whichMatch = trimmed.match(/^(which|command\s+-v)\s+(\S+)$/);
    if (whichMatch) {
      const cmdName = whichMatch[2];
      const knownCmds = ['node', 'npm', 'npx', 'git', 'cat', 'ls', 'grep', 'sed', 'find', 'echo',
        'mkdir', 'rm', 'cp', 'mv', 'touch', 'chmod', 'head', 'tail', 'sort', 'uniq', 'wc', 'tr',
        'tee', 'diff', 'env', 'which', 'test', 'sh', 'bash', 'vi', 'rg', 'curl', 'mktemp', 'jq',
        'tput', 'stty', 'gzip', 'gunzip', 'wget', 'pgrep', 'pkill', 'nproc', 'getconf', 'ed'];
      if (knownCmds.includes(cmdName)) {
        return { stdout: `/usr/local/bin/${cmdName}\n`, stderr: '', status: 0 };
      }
    }
    // git config
    const gitConfigMatch = trimmed.match(/^git\s+config\s+(?:--global\s+)?(?:--get\s+)?(\S+)$/);
    if (gitConfigMatch) {
      const key = gitConfigMatch[1];
      if (key === 'user.name') return { stdout: 'user\n', stderr: '', status: 0 };
      if (key === 'user.email') return { stdout: `user@${activeProfile().hostname}.local\n`, stderr: '', status: 0 };
      return { stdout: '', stderr: '', status: 1 }; // unknown config key
    }

    return null;
  };

  // Shim /bin/sh, /bin/bash, /bin/zsh — Shiro has no real shell binaries.
  // Claude Code's Bash tool calls patterns like:
  //   spawn('/bin/sh', ['-l', '-c', 'echo hello'])  → extract 'echo hello'
  //   spawn('/bin/sh', ['-l'])                       → no-op (login shell init)
  //   spawn('/bin/sh', ['/tmp/claude-XXX-cwd'])      → source file as script
  //   exec('/bin/sh -l -c "echo hello"')             → extract 'echo hello'
  const isShellBin = (s: string) => /^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh)$/.test(s);
  // Shell-quote a single argument: wrap in single quotes, escape internal single quotes
  const shellQuoteArg = (s: string): string => {
    if (/^[A-Za-z0-9_\-.,/:=@]+$/.test(s)) return s; // safe chars, no quoting needed
    return "'" + s.replace(/'/g, "'\\''") + "'";
  };
  const shellQuoteArgs = (args: string[]): string => args.map(shellQuoteArg).join(' ');
  const stripOuterQuotes = (s: string): string => {
    // Strip matching outer quotes like a shell would: "cmd" → cmd, 'cmd' → cmd
    // Also unescape inner escaped quotes: \" → "
    const t = s.trim();
    if (t.length >= 2) {
      if (t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1);
      if (t[0] === '"' && t[t.length - 1] === '"') {
        return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    return t;
  };
  const stripShellPrefix = (cmd: string): string => {
    if (!/^\/bin\/(?:sh|bash|zsh)\b/.test(cmd)) return cmd;
    const rest = cmd.replace(/^\/bin\/(?:sh|bash|zsh)\s*/, '').trim();
    if (!rest) return 'true'; // bare /bin/sh → no-op
    // Find -c flag (possibly combined: -lc, -ilc, or separate: -l -c)
    const idx = rest.search(/(^|\s)-\w*c\s/);
    if (idx >= 0) {
      const extracted = rest.slice(idx).replace(/^\s*-\w*c\s+/, '');
      return stripOuterQuotes(extracted);
    }
    // No -c: separate flags from file args
    const parts = rest.split(/\s+/);
    const scripts = parts.filter(p => !p.startsWith('-'));
    if (scripts.length > 0) {
      // File arg: read and execute as shell script
      const resolved = ctx.fs.resolvePath(scripts[0], ctx.cwd);
      const content = fileCache.get(resolved);
      return content ? content.trim() : 'true';
    }
    return 'true'; // only flags like -l, -i → no-op
  };
  // Extract command from spawn-style args array for shell binaries
  const extractShellArgs = (args: string[]): string => {
    // bash's options, before or after -c (Claude Code runs `zsh -c -l <cmd>`): src/shell-args.ts
    const parsed = parseShellArgs(args);
    if (parsed.command && parsed.rest.length) {
      // One command string and nothing that changes how it runs: run it directly
      if (parsed.rest.length === 1 && !parsed.on.length && !parsed.off.length) return parsed.rest[0];
      // $0, $1… after the string (bash -c 'echo $1' x y) or -e/-o …: the shell's own sh -c
      return shellQuoteArgs(['sh', ...parsed.on.flatMap((o) => ['-o', o]), ...parsed.off.flatMap((o) => ['+o', o]), '-c', ...parsed.rest]);
    }
    // No -c: find non-flag args (file paths to source)
    const scripts = args.filter(a => !a.startsWith('-'));
    if (scripts.length > 0) {
      const resolved = ctx.fs.resolvePath(scripts[0], ctx.cwd);
      const content = fileCache.get(resolved);
      return content ? content.trim() : 'true';
    }
    return 'true'; // only flags → no-op
  };
  // execAsync is the underlying impl — returns a Promise
  // Shell natively handles setopt (no-op), eval (builtin), >| (clobber), /dev/null (virtual file)
  /** Output as it arrives (a guest's spawn(): data events and stdio 'inherit' don't wait for the end) */
  type Live = { out: (s: string) => void; err: (s: string) => void };
  /**
   * `inherit`: which of fds 0/1/2 are this process's own for the child (stdio
   * 'inherit'): a guest passes its kernel fds; in the page, all three on a
   * terminal run the child on that terminal (codex's npm launcher runs its
   * native binary so, which waited for EOF on a stdin that wasn't the tty)
   */
  const execAsync = async (cmd: string, env?: Record<string, unknown>, input?: string, live?: Live, inherit?: [boolean, boolean, boolean], abort?: AbortController): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    let normalized = stripShellPrefix(cmd);
    // Strip leading shell flags (-l, -i, -e) that leak through from spawn args
    normalized = normalized.replace(/^(-[a-zA-Z]+\s+)+/, '');
    if (!normalized || /^-[a-zA-Z]+$/.test(normalized)) normalized = 'true';

    // Intercept vendored ripgrep binary — it's an ELF/Mach-O binary that can't
    // run in browser. Route to Shiro's builtin `rg` command which handles all flags.
    const rgMatch = normalized.match(/^(\/[^\s]*\/rg|rg)\s+(.*)/s);
    if (rgMatch) {
      const rgArgs = rgMatch[2];
      if (rgArgs.includes('--version')) {
        return { stdout: 'ripgrep 14.0.0 (tabcomputer shim)\n', stderr: '', exitCode: 0 };
      }
      // Pass through to Shiro's builtin rg command (handles --files, --sort, all flags)
      normalized = `rg ${rgArgs}`;
    }

    if (deps.guest) {
      // A real child process; files it changed are read again afterwards
      const outDec = new TextDecoder(), errDec = new TextDecoder();
      const r = await deps.guest.runChild(normalized, {
        input, cwd: ctx.cwd,
        ...(inherit ? { inherit } : {}),
        ...(env ? { env: Object.fromEntries(Object.entries(env).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) } : {}),
        ...(live ? {
          onStdout: (b: Uint8Array) => { const t = outDec.decode(b, { stream: true }); if (t) live.out(t); },
          onStderr: (b: Uint8Array) => { const t = errDec.decode(b, { stream: true }); if (t) live.err(t); },
        } : {}),
      });
      if (live) {
        const t = outDec.decode(), e = errDec.decode();
        if (t) live.out(t);
        if (e) live.err(e);
      }
      fileCache.clear();
      const dec = new TextDecoder();
      return { stdout: dec.decode(r.stdout), stderr: dec.decode(r.stderr), exitCode: r.status ?? 128 + (r.signal ?? 0) };
    }
    // Drain pending IDB writes so shell commands can see files written by
    // writeFileSync (which only updates fileCache + queues async IDB write).
    if (pendingPromises.length > 0) {
      await Promise.all(pendingPromises.splice(0));
    }

    let stdout = '';
    let stderr = '';
    // Run in a forked shell with no terminal: a child process's output belongs to
    // the parent that spawned it. With a terminal attached, nested programs (node,
    // tsc, vitest) saw a TTY and painted straight over Claude's UI instead of
    // returning output to its Bash tool. The fork also keeps `cd`/`export` from
    // leaking into the interactive shell.
    const sh = ctx.shell.fork();
    // child.kill() (spawn): its own abort, chained to the one it would have had
    if (abort) {
      const outer = sh.inheritedAbort;
      if (outer?.signal.aborted) abort.abort(outer.signal.reason);
      else outer?.signal.addEventListener('abort', () => abort.abort(outer.signal.reason), { once: true });
      sh.inheritedAbort = abort;
    }
    // spawn(…, { env }): the child sees that environment (Gemini CLI relaunches
    // itself with { ...process.env, GEMINI_CLI_NO_RELAUNCH: 'true' })
    if (env) {
      sh.env = {};
      for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== null) sh.env[k] = String(v);
    }
    // { input }: the child's stdin (execSync, spawnSync, execFileSync)
    const exitCode = input !== undefined
      ? await sh.executeWithStdin(normalized, input, (s) => { stdout += s; }, (s) => { stderr += s; })
      : await sh.execute(normalized, (s) => { stdout += s; }, (s) => { stderr += s; }, false,
        inherit?.every(Boolean) && ctx.terminal ? ctx.terminal : undefined, true);

    // Refresh fileCache from Shiro FS cache — shell commands may have created,
    // modified, or deleted files that fileCache still has stale entries for.
    for (const path of [...fileCache.keys()]) {
      if (path.endsWith('/.')) continue; // skip dir markers
      // Not read yet: it is decoded from the filesystem when read (has() drops a deleted one)
      if ((fileCache as { isLazy?(p: string): boolean }).isLazy?.(path)) { fileCache.has(path); continue; }
      const fresh = ctx.fs.readCached(path);
      if (fresh === undefined) {
        fileCache.delete(path); // file was deleted by shell
      } else if (fresh !== fileCache.get(path)) {
        fileCache.set(path, fresh);
        fileMtimes.set(path, Date.now());
      }
    }

    // Normalize \r\n to \n (shell adds \r\n for terminal display, but Node convention is \n)
    stdout = stdout.replace(/\r\n/g, '\n');
    stderr = stderr.replace(/\r\n/g, '\n');

    return { stdout, stderr, exitCode };
  };
  /**
   * Run `node ARGS` as the child, its stdin a pipe the parent writes into as it
   * goes and its stdout/stderr bytes delivered as written (not at exit). The
   * parent waits for it only while it is ref()'d (esbuild unrefs its service);
   * when the parent ends, the child's stdin closes, so a server loop sees EOF.
   */
  const spawnNodeLive = (child: any, args: string[], opts: any, io: {
    stdoutEvents: Record<string, Function[]>; stderrEvents: Record<string, Function[]>; events: Record<string, Function[]>;
    inheritOut: boolean; inheritErr: boolean; resolve: (v: any) => void;
  }): any => {
    const { FakeBuffer } = deps;
    const pipe = stdinPipe();
    const bytesOf = (d: any, enc?: string): Uint8Array => typeof d === 'string' ? FakeBuffer.from(d, enc) : d instanceof Uint8Array ? d : FakeBuffer.from(d);
    let outOpen = true, errOpen = true;
    const proc = deps.getProcess?.();
    // Delivered on a microtask, in order: the parent's listeners run in the parent,
    // not inside the child's write (an error in esbuild's reader came back to Go's
    // fs.write and panicked the service)
    const deliver = (fn: () => void) => queueMicrotask(() => {
      try { fn(); } catch (e) { (io.events['error'] || []).length ? (io.events['error'] || []).forEach((h) => h(e)) : reportError(e); }
    });
    const reportError = (e: any) => { const p = deps.getProcess?.(); p?.stderr?.write(`${e?.stack ?? e}\n`); };
    const out = (b: Uint8Array) => {
      const c = b.slice();
      deliver(() => {
        if (io.inheritOut) proc?.stdout?.write(c);
        else if (outOpen) (io.stdoutEvents['data'] || []).forEach((fn) => fn(FakeBuffer.from(c)));
      });
    };
    const err = (b: Uint8Array) => {
      const c = b.slice();
      deliver(() => {
        if (io.inheritErr) proc?.stderr?.write(c);
        else if (errOpen) (io.stderrEvents['data'] || []).forEach((fn) => fn(FakeBuffer.from(c)));
      });
    };
    child.stdin = {
      writable: true,
      write: (data: any, encOrCb?: any, cb?: any) => {
        pipe.write(bytesOf(data, typeof encOrCb === 'string' ? encOrCb : undefined));
        const done = typeof encOrCb === 'function' ? encOrCb : cb;
        if (done) queueMicrotask(() => done(null));
        return true;
      },
      end: (data?: any, encOrCb?: any, cb?: any) => {
        if (typeof data === 'function') { cb = data; data = undefined; }
        if (data !== undefined && data !== null) pipe.write(bytesOf(data, typeof encOrCb === 'string' ? encOrCb : undefined));
        pipe.end();
        const done = typeof encOrCb === 'function' ? encOrCb : cb;
        if (done) queueMicrotask(() => done());
      },
      destroy: () => { pipe.end(); },
      on: () => child.stdin, once: () => child.stdin, off: () => child.stdin, removeListener: () => child.stdin,
      ref: () => child.stdin, unref: () => child.stdin,
    };
    if (child.stdout) { child.stdout.destroy = () => { outOpen = false; return child.stdout; }; child.stdout.ref = child.stdout.unref = () => child.stdout; }
    if (child.stderr) { child.stderr.destroy = () => { errOpen = false; return child.stderr; }; child.stderr.ref = child.stderr.unref = () => child.stderr; }

    // The parent waits while the child is ref()'d
    let release: (() => void) | null = null;
    let exited = false;
    const hold = () => { if (!release && !exited) deps.pendingPromises.push(childWait(new Promise<void>((r) => { release = r; }))); };
    const unhold = () => { const r = release; release = null; r?.(); };
    child.ref = () => { hold(); return child; };
    child.unref = () => { unhold(); return child; };
    child.kill = () => { child.killed = true; pipe.end(); return true; };
    // the parent's writes still in flight before it started the child (not the waits added after)
    const before = deps.pendingPromises.slice();
    hold();
    proc?.once?.('exit', () => pipe.end());

    const sh = ctx.shell.fork();
    if (opts?.env) { sh.env = {}; for (const [k, v] of Object.entries(opts.env)) if (v !== undefined && v !== null) sh.env[k] = String(v); }
    const cwd = opts?.cwd ? ctx.fs.resolvePath(String(opts.cwd), ctx.cwd) : ctx.cwd;
    const cctx: CommandContext = {
      args, fs: ctx.fs, cwd, env: { ...sh.env }, stdin: '', stdout: '', stderr: '', shell: sh,
      stdinIsTTY: false, stdoutIsTTY: false,
      stdinStream: pipe.stream, stdoutBytes: out, stderrBytes: err,
    };
    (sh as any).cwd = cwd;
    const run = (async () => {
      // what the parent wrote is on disk for the child (fs writes are queued)
      if (before.length) await Promise.race([Promise.allSettled(before), new Promise((r) => setTimeout(r, 2000))]);
      return ctx.shell.commands.get('node')!.exec(cctx);
    })();
    run.then((code) => code, (e) => { cctx.stderr += String(e?.message ?? e) + '\n'; return 1; }).then((code: number) => {
      exited = true;
      // anything the child left in its ctx (an error report) goes out too
      if (cctx.stdout) out(new TextEncoder().encode(cctx.stdout));
      if (cctx.stderr) err(new TextEncoder().encode(cctx.stderr));
      deliver(() => {
        for (const ev of ['end', 'close']) { (io.stdoutEvents[ev] || []).forEach((fn) => fn()); (io.stderrEvents[ev] || []).forEach((fn) => fn()); }
        child.exitCode = code;
        (io.events['exit'] || []).forEach((fn) => fn(code, null));
        (io.events['close'] || []).forEach((fn) => fn(code, null));
        io.resolve({ stdout: '', stderr: '', exitCode: code });
        unhold();
      });
    });
    return child;
  };
  /**
   * A kernel guest's spawn() with piped stdin: a real child whose stdin the
   * parent writes as it goes and whose output comes as bytes when written
   * (esbuild's service speaks a binary protocol over them). The parent waits
   * for it only while it is ref()'d; an unref()'d one sees EOF when the
   * parent ends (the kernel closes the parent's end of its stdin).
   */
  const spawnGuestLive = (child: any, cmd: string, opts: any, io: {
    stdoutEvents: Record<string, Function[]>; stderrEvents: Record<string, Function[]>; events: Record<string, Function[]>;
    inheritOut: boolean; inheritErr: boolean; resolve: (v: any) => void;
    /** the program and its arguments, when it ran without a shell */
    argv?: string[];
  }): any => {
    const { FakeBuffer } = deps;
    const bytesOf = (d: any, enc?: string): Uint8Array => typeof d === 'string' ? FakeBuffer.from(d, enc) : d instanceof Uint8Array ? d : FakeBuffer.from(d);
    let outOpen = true, errOpen = true;
    const proc = deps.getProcess?.();
    // Delivered on a microtask, in order: the parent's listeners don't run inside the child's
    // poll (an error there is the parent's: its 'error' listeners, else its stderr; as spawnNodeLive)
    const deliver = (fn: () => void) => queueMicrotask(() => {
      try { fn(); } catch (e: any) { (io.events['error'] || []).length ? (io.events['error'] || []).forEach((h) => h(e)) : proc?.stderr?.write(`${e?.stack ?? e}\n`); }
    });
    let control: import('../../node-worker/child').ChildControl | null = null;
    const early: (Uint8Array | null)[] = []; // (writes before the child is there: null is end())
    const write = (b: Uint8Array) => { if (control) control.write(b); else early.push(b); };
    const end = () => { if (control) control.end(); else early.push(null); };
    child.stdin = {
      writable: true,
      write: (data: any, encOrCb?: any, cb?: any) => {
        write(bytesOf(data, typeof encOrCb === 'string' ? encOrCb : undefined));
        const done = typeof encOrCb === 'function' ? encOrCb : cb;
        if (done) queueMicrotask(() => done(null));
        return true;
      },
      end: (data?: any, encOrCb?: any, cb?: any) => {
        if (typeof data === 'function') { cb = data; data = undefined; }
        if (data !== undefined && data !== null) write(bytesOf(data, typeof encOrCb === 'string' ? encOrCb : undefined));
        end();
        const done = typeof encOrCb === 'function' ? encOrCb : cb;
        if (done) queueMicrotask(() => done());
      },
      destroy: () => { end(); },
      on: () => child.stdin, once: () => child.stdin, off: () => child.stdin, removeListener: () => child.stdin,
      ref: () => child.stdin, unref: () => child.stdin,
    };
    if (child.stdout) { child.stdout.destroy = () => { outOpen = false; return child.stdout; }; child.stdout.ref = child.stdout.unref = () => child.stdout; }
    if (child.stderr) { child.stderr.destroy = () => { errOpen = false; return child.stderr; }; child.stderr.ref = child.stderr.unref = () => child.stderr; }
    let release: (() => void) | null = null;
    let exited = false;
    const hold = () => { if (!release && !exited) deps.pendingPromises.push(childWait(new Promise<void>((r) => { release = r; }))); };
    const unhold = () => { const r = release; release = null; r?.(); };
    child.ref = () => { hold(); return child; };
    child.unref = () => { unhold(); return child; };
    const SIG: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
    child.kill = (sig?: string | number) => {
      const n = typeof sig === 'number' ? sig : SIG[sig ?? 'SIGTERM'] ?? 15;
      const ok = control?.kill(n) ?? false;
      if (ok) child.killed = true;
      return ok;
    };
    // stdio 'ipc' (fork()): child.send / 'message' / disconnect() over a socketpair (child.ts)
    const wantsIpc = Array.isArray(opts?.stdio) && opts.stdio.includes('ipc');
    let ipcIn: ((b: Uint8Array) => void) | null = null;
    const ipcGone = () => {
      if (!child.connected) return;
      child.connected = false;
      deliver(() => (io.events['disconnect'] || []).forEach((fn) => fn()));
    };
    if (wantsIpc) {
      child.connected = true;
      child.channel = { ref: () => child.channel, unref: () => child.channel };
      child.send = (message: unknown, ...rest: unknown[]) => {
        const cb = rest.find((a) => typeof a === 'function') as ((e: Error | null) => void) | undefined;
        if (!child.connected || !control) {
          const e = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
          queueMicrotask(() => (cb ? cb(e) : (io.events['error'] || []).forEach((fn) => fn(e))));
          return false;
        }
        control.send(new TextEncoder().encode(ipcLine(message)));
        if (cb) queueMicrotask(() => cb(null));
        return true;
      };
      child.disconnect = () => { if (child.connected) control?.disconnect(); };
      ipcIn = ipcReader((m) => deliver(() => (io.events['message'] || []).forEach((fn) => fn(m, undefined))));
    }
    hold();
    // (a forked node runs as itself, the channel its fd 3, with this process's environment unless given one)
    const direct = wantsIpc && io.argv && /(^|\/)node$/.test(io.argv[0]) ? ['node', ...io.argv.slice(1)] : undefined;
    const envGiven = opts?.env ?? (direct ? proc?.env : undefined);
    const env = envGiven ? Object.fromEntries(Object.entries(envGiven).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) : undefined;
    deps.guest!.runChild(cmd, {
      cwd: opts?.cwd ? ctx.fs.resolvePath(String(opts.cwd), ctx.cwd) : ctx.cwd,
      ...(env ? { env } : {}),
      onStdout: (b) => deliver(() => {
        if (io.inheritOut) proc?.stdout?.write(b);
        else if (outOpen) (io.stdoutEvents['data'] || []).forEach((fn) => fn(FakeBuffer.from(b)));
      }),
      onStderr: (b) => deliver(() => {
        if (io.inheritErr) proc?.stderr?.write(b);
        else if (errOpen) (io.stderrEvents['data'] || []).forEach((fn) => fn(FakeBuffer.from(b)));
      }),
      ...(ipcIn ? { ipc: (b: Uint8Array | null) => { if (b) ipcIn!(b); else ipcGone(); } } : {}),
      ...(direct ? { argv: direct } : {}),
      // (inherited output: this process's own fds, a terminal stays one for the child)
      inherit: [false, io.inheritOut, io.inheritErr],
      control: (c) => {
        control = c;
        child.pid = c.pid;
        for (const b of early.splice(0)) if (b) c.write(b); else c.end();
      },
    }).then((r) => deliver(() => {
      exited = true;
      fileCache.clear(); // files it changed are read again
      const code = r.status ?? 128 + (r.signal ?? 0);
      for (const ev of ['end', 'close']) { (io.stdoutEvents[ev] || []).forEach((fn) => fn()); (io.stderrEvents[ev] || []).forEach((fn) => fn()); }
      child.exitCode = r.status;
      child.signalCode = r.signal === null ? null : Object.keys(SIG).find((k) => SIG[k] === r.signal) ?? null;
      (io.events['exit'] || []).forEach((fn) => fn(r.status, child.signalCode));
      (io.events['close'] || []).forEach((fn) => fn(r.status, child.signalCode));
      io.resolve({ stdout: '', stderr: '', exitCode: code });
      unhold();
    }));
    return child;
  };
  /** stdio 'inherit' (all three: the child gets the terminal, as spawn's does) */
  const inheritOf = (opts: any): [boolean, boolean, boolean] => [0, 1, 2].map((i) => inherits(opts?.stdio, i)) as [boolean, boolean, boolean];
  /** An inherited stream's output is this process's (on its stdout/stderr), not the result's */
  const inherited = (r: { stdout: string; stderr: string; exitCode: number }, opts: any) => {
    const [, out, err] = inheritOf(opts);
    const proc = deps.getProcess?.();
    if (out && r.stdout) { proc?.stdout?.write(r.stdout); r = { ...r, stdout: '' }; }
    if (err && r.stderr) { proc?.stderr?.write(r.stderr); r = { ...r, stderr: '' }; }
    return r;
  };
  /** The `input` option as text (a string, Buffer or typed array) */
  const inputOf = (opts: any): string | undefined => {
    const v = opts?.input;
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') return v;
    if (v instanceof Uint8Array || ArrayBuffer.isView(v)) return new TextDecoder().decode(v as Uint8Array);
    return String(v);
  };
  /**
   * The *Sync calls as a kernel guest: the child runs to the end before this
   * returns (the worker blocks), so the result is the real one, not a thenable.
   */
  const guestSync = (cmd: string, opts: any) => {
    const r = deps.guest!.runChildSync(cmd, {
      inherit: [0, 1, 2].map((i) => inherits(opts?.stdio, i)) as [boolean, boolean, boolean],
      input: opts?.input === undefined || opts?.input === null ? undefined : typeof opts.input === 'string' ? opts.input : new Uint8Array(opts.input),
      cwd: opts?.cwd ? String(opts.cwd) : ctx.cwd,
      ...(opts?.env ? { env: Object.fromEntries(Object.entries(opts.env).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) } : {}),
    });
    fileCache.clear();
    const wantString = opts?.encoding && opts.encoding !== 'buffer';
    const wrap = (b: Uint8Array) => (wantString ? new TextDecoder().decode(b) : FakeBuffer.from(b));
    // stdio: 'inherit' → the parent's own stdout/stderr
    const proc = deps.getProcess?.();
    if (opts?.stdio === 'inherit' || (Array.isArray(opts?.stdio) && opts.stdio[1] === 'inherit')) { if (r.stdout.length) proc?.stdout?.write(new TextDecoder().decode(r.stdout)); r.stdout = new Uint8Array(0); }
    if (opts?.stdio === 'inherit' || (Array.isArray(opts?.stdio) && opts.stdio[2] === 'inherit')) { if (r.stderr.length) proc?.stderr?.write(new TextDecoder().decode(r.stderr)); r.stderr = new Uint8Array(0); }
    return { r, stdout: wrap(r.stdout), stderr: wrap(r.stderr) };
  };
  const guestThrow = (cmd: string, g: ReturnType<typeof guestSync>) => {
    if (g.r.status === 0) return;
    const err: any = new Error(`Command failed: ${cmd}${g.r.stderr.length ? '\n' + new TextDecoder().decode(g.r.stderr) : ''}`);
    Object.assign(err, { status: g.r.status, signal: g.r.signal, stdout: g.stdout, stderr: g.stderr, pid: g.r.pid, output: [null, g.stdout, g.stderr] });
    throw err;
  };
  const cpModule: any = {
    execSync: (cmd: string, opts?: any) => {
      // In browser, execSync cannot truly block. We return a placeholder
      // Buffer and queue the actual execution. Works correctly when the
      // result is used at top-level of an async script (node -e).
      // Handle cwd option
      let effectiveCmd = cmd;
      if (opts?.cwd) {
        effectiveCmd = `cd ${shellQuoteArg(String(opts.cwd))} && ${cmd}`;
      }
      if (deps.guest) { const g = guestSync(cmd, opts); guestThrow(cmd, g); return g.stdout; }
      // Synchronous fast-path for detection commands
      const syncResponse = inputOf(opts) === undefined ? getSyncResponse(effectiveCmd) : null;
      if (syncResponse) {
        // Throw on non-zero exit (bash semantics)
        if (syncResponse.status !== 0) {
          throw Object.assign(new Error(`Command failed: ${cmd}`), {
            status: syncResponse.status, stderr: syncResponse.stderr, stdout: syncResponse.stdout,
          });
        }
        const wantStr = opts?.encoding && opts.encoding !== 'buffer';
        if (wantStr) return syncResponse.stdout;
        const buf: any = FakeBuffer.from(syncResponse.stdout);
        buf.then = (resolve: any) => resolve(FakeBuffer.from(syncResponse.stdout));
        return buf;
      }
      let result = '';
      let resultErr = '';
      let resultCode = 0;
      const wantString = opts?.encoding && opts.encoding !== 'buffer';
      const p = execAsync(effectiveCmd, undefined, inputOf(opts), undefined, inheritOf(opts)).then(r => { r = inherited(r, opts); result = r.stdout; resultErr = r.stderr; resultCode = r.exitCode; });
      if (wantString) {
        const str: any = new String('');
        str.then = (resolve: any, reject: any) => p.then(() => {
          if (resultCode !== 0) reject(Object.assign(new Error(`Command failed: ${cmd}`), { status: resultCode, stderr: resultErr, stdout: result }));
          else resolve(result);
        }).catch(reject);
        return new Proxy(str, {
          get(target, prop) {
            if (prop === 'then') return str.then;
            const val = (result as any)[prop];
            if (typeof val === 'function') return val.bind(result);
            return val;
          },
        });
      }
      const buf: any = {
        toString: () => result,
        then: (resolve: any, reject: any) => p.then(() => {
          if (resultCode !== 0) reject(Object.assign(new Error(`Command failed: ${cmd}`), { status: resultCode, stderr: resultErr, stdout: result }));
          else resolve(FakeBuffer.from(result));
        }).catch(reject),
        [Symbol.toPrimitive]: () => result,
      };
      return buf;
    },
    spawnSync: (cmd: string, args?: string[], opts?: any) => {
      // Handle overload: spawnSync(cmd, opts) without args
      if (args && !Array.isArray(args)) { opts = args; args = undefined; }
      let fullCmd: string;
      if (isShellBin(cmd) && args) {
        fullCmd = extractShellArgs(args);
      } else {
        fullCmd = args ? `${cmd} ${shellQuoteArgs(args)}` : cmd;
      }
      // Handle cwd option
      if (opts?.cwd) {
        const cwdPath = String(opts.cwd);
        fullCmd = `cd ${shellQuoteArg(cwdPath)} && ${fullCmd}`;
      }
      if (deps.guest) {
        const g = guestSync(fullCmd, opts);
        return { pid: g.r.pid, output: [null, g.stdout, g.stderr], stdout: g.stdout, stderr: g.stderr, status: g.r.status, signal: g.r.signal === null ? null : (['', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM'][g.r.signal] || `SIG${g.r.signal}`) };
      }
      const wantString = opts?.encoding && opts.encoding !== 'buffer';
      const wrap = (s: string) => wantString ? s : FakeBuffer.from(s);
      // Synchronous fast-paths for version/detection checks that the CLI reads
      // without awaiting. Without this, stdout is '' when read synchronously.
      const syncResponse = inputOf(opts) === undefined ? getSyncResponse(fullCmd) : null;
      if (syncResponse) {
        const out = wrap(syncResponse.stdout);
        const err = wrap(syncResponse.stderr);
        const st = syncResponse.status;
        return {
          get stdout() { return out; },
          get stderr() { return err; },
          get status() { return st; },
          error: st !== 0 ? new Error(`spawnSync exited with ${st}`) : undefined as any,
          then: (resolve: any) => resolve({ pid: 0, output: [null, out, err], stdout: out, stderr: err, status: st, signal: null }),
        };
      }
      let stdout = '';
      let stderr = '';
      let status = 0;
      const p = execAsync(fullCmd, undefined, inputOf(opts), undefined, inheritOf(opts)).then(r => { r = inherited(r, opts); stdout = r.stdout; stderr = r.stderr; status = r.exitCode; });
      pendingPromises.push(p);
      return {
        get stdout() { return wrap(stdout); },
        get stderr() { return wrap(stderr); },
        get status() { return status; },
        get error() { return status !== 0 ? new Error(`spawnSync exited with ${status}`) : undefined; },
        // awaited (sync-await.ts): the whole result, as node's spawnSync returns it
        then: (resolve: any, reject: any) => p.then(() => resolve({
          pid: 0, output: [null, wrap(stdout), wrap(stderr)], stdout: wrap(stdout), stderr: wrap(stderr), status, signal: null,
        })).catch(reject),
      };
    },
    exec: (cmd: string, opts: any, cb?: any) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const childEvents: Record<string, Function[]> = {};
      const child: any = {
        pid: Math.floor(Math.random() * 10000) + 1000,
        stdout: { on: (ev: string, fn: Function) => { (childEvents['stdout_' + ev] ??= []).push(fn); return child.stdout; }, pipe: (d: any) => d },
        stderr: { on: (ev: string, fn: Function) => { (childEvents['stderr_' + ev] ??= []).push(fn); return child.stderr; }, pipe: (d: any) => d },
        stdin: { write: () => true, end: () => {}, on: () => child.stdin },
        on: (ev: string, fn: Function) => { (childEvents[ev] ??= []).push(fn); return child; },
        once: (ev: string, fn: Function) => child.on(ev, fn),
        kill: () => true,
      };
      const p = execAsync(cmd).then(r => {
        if (r.stdout) (childEvents['stdout_data'] || []).forEach(fn => fn(FakeBuffer.from(r.stdout)));
        (childEvents['stdout_end'] || []).forEach(fn => fn());
        if (r.stderr) (childEvents['stderr_data'] || []).forEach(fn => fn(FakeBuffer.from(r.stderr)));
        (childEvents['stderr_end'] || []).forEach(fn => fn());
        (childEvents['close'] || []).forEach(fn => fn(r.exitCode, null));
        callback?.(r.exitCode !== 0 ? Object.assign(new Error(`Exit code ${r.exitCode}`), { code: r.exitCode }) : null, r.stdout, r.stderr);
      }).catch(e => callback?.(e, '', ''));
      pendingPromises.push(childWait(p));
      return child;
    },
    execFile: (file: string, args: string[], opts: any, cb?: any) => {
      const callback = typeof opts === 'function' ? opts : cb;
      let cmd: string;
      if (isShellBin(file) && args) {
        cmd = extractShellArgs(args);
      } else {
        cmd = `${file} ${shellQuoteArgs(args || [])}`;
      }
      const isClipCmd = /^(pbcopy|xclip(\s|$)|xsel(\s|$)|wl-copy(\s|$)|clip(\.exe)?$)/.test(cmd.trim());
      let clipBuf = '';
      const childEvents: Record<string, Function[]> = {};
      const child: any = {
        pid: Math.floor(Math.random() * 10000) + 1000,
        stdout: { on: (ev: string, fn: Function) => { (childEvents['stdout_' + ev] ??= []).push(fn); return child.stdout; }, pipe: (d: any) => d },
        stderr: { on: (ev: string, fn: Function) => { (childEvents['stderr_' + ev] ??= []).push(fn); return child.stderr; }, pipe: (d: any) => d },
        stdin: {
          write: (data: any) => { if (isClipCmd) clipBuf += (typeof data === 'string' ? data : String(data)); return true; },
          end: () => { if (isClipCmd) toClipboard(clipBuf); },
          on: () => child.stdin,
        },
        on: (ev: string, fn: Function) => { (childEvents[ev] ??= []).push(fn); return child; },
        once: (ev: string, fn: Function) => child.on(ev, fn),
        kill: () => true,
      };
      const cmdP = isClipCmd
        ? new Promise<{ stdout: string; stderr: string; exitCode: number }>(resolve =>
            setTimeout(() => resolve({ stdout: '', stderr: '', exitCode: 0 }), 0))
        : execAsync(cmd);
      const p = cmdP.then(r => {
        if (r.stdout) (childEvents['stdout_data'] || []).forEach(fn => fn(FakeBuffer.from(r.stdout)));
        (childEvents['stdout_end'] || []).forEach(fn => fn());
        if (r.stderr) (childEvents['stderr_data'] || []).forEach(fn => fn(FakeBuffer.from(r.stderr)));
        (childEvents['stderr_end'] || []).forEach(fn => fn());
        (childEvents['close'] || []).forEach(fn => fn(r.exitCode, null));
        callback?.(r.exitCode !== 0 ? Object.assign(new Error(`Exit code ${r.exitCode}`), { code: r.exitCode }) : null, r.stdout, r.stderr);
      }).catch(e => {
        // CRITICAL: Always emit error+close events even when callback is null.
        // Without this, the CLI hangs forever waiting for the child process.
        (childEvents['error'] || []).forEach(fn => fn(e));
        (childEvents['stdout_end'] || []).forEach(fn => fn());
        (childEvents['stderr_end'] || []).forEach(fn => fn());
        (childEvents['close'] || []).forEach(fn => fn(1, null));
        callback?.(e, '', '');
      });
      pendingPromises.push(childWait(p));
      return child;
    },
    spawn: (cmd: string, args?: string[], opts?: any) => {
      // Handle overload: spawn(cmd, opts) without args
      if (args && !Array.isArray(args)) { opts = args; args = undefined; }
      let fullCmd: string;
      if (isShellBin(cmd) && args) {
        fullCmd = extractShellArgs(args);
      } else {
        fullCmd = args ? `${cmd} ${shellQuoteArgs(args)}` : cmd;
      }
      // Handle cwd option
      if (opts?.cwd) {
        fullCmd = `cd ${shellQuoteArg(String(opts.cwd))} && ${fullCmd}`;
      }
      // Detect stdio file descriptors — Claude Code's Bash tool opens output files
      // and passes them as stdio[1]/stdio[2]. We detect fd-like objects with .fd property
      // or 'pipe'/'inherit' strings and write output to the file after execution.
      let stdioOutFd: number | null = null;
      let stdioErrFd: number | null = null;
      if (opts?.stdio && Array.isArray(opts.stdio)) {
        const s1 = opts.stdio[1];
        const s2 = opts.stdio[2];
        if (s1 && typeof s1 === 'object' && typeof s1.fd === 'number') stdioOutFd = s1.fd;
        else if (typeof s1 === 'number' && s1 > 2) stdioOutFd = s1;
        if (s2 && typeof s2 === 'object' && typeof s2.fd === 'number') stdioErrFd = s2.fd;
        else if (typeof s2 === 'number' && s2 > 2) stdioErrFd = s2;
      }
      // Inherited stdout/stderr (pnpm's lifecycle scripts: stdio [0, 1, 2]) go to
      // the parent's, and the child has no stream for them (null, as in node)
      const inheritOut = inherits(opts?.stdio, 1) && stdioOutFd === null;
      const inheritErr = inherits(opts?.stdio, 2) && stdioErrFd === null;
      // Capture fd→path mapping NOW (before async exec) because closeSync may delete
      // the fd entry before the spawn promise resolves
      const fds = (globalThis as any).__shiroFds || {};
      const stdioOutPath = stdioOutFd !== null ? fds[stdioOutFd]?.path : null;
      const stdioErrPath = stdioErrFd !== null && stdioErrFd !== stdioOutFd ? fds[stdioErrFd]?.path : null;
      const events: Record<string, Function[]> = {};
      const stdoutEvents: Record<string, Function[]> = {};
      const stderrEvents: Record<string, Function[]> = {};
      // Detect clipboard commands (pbcopy, xclip, etc.) to shim with browser clipboard API.
      // Claude Code's "c to copy" runs: spawn('/bin/sh', ['-c', 'pbcopy'], {input: url})
      const isClipboardCmd = /^(pbcopy|xclip(\s|$)|xsel(\s|$)|wl-copy(\s|$)|clip(\.exe)?$)/.test(fullCmd.trim());
      let clipboardBuf = '';
      // Create async iterator for stream mocks so execa's getStream (for await...of) works.
      // Without this, execa can't read stdout/stderr and always gets empty output.
      const makeStreamIterator = (streamEvents: Record<string, Function[]>) => {
        return function() {
          const chunks: any[] = [];
          let done = false;
          let resolve: (() => void) | null = null;
          // Listen for data and end events
          (streamEvents['data'] ??= []).push((chunk: any) => { chunks.push(chunk); resolve?.(); });
          (streamEvents['end'] ??= []).push(() => { done = true; resolve?.(); });
          return {
            next(): Promise<{ value: any; done: boolean }> {
              if (chunks.length > 0) return Promise.resolve({ value: chunks.shift(), done: false });
              if (done) return Promise.resolve({ value: undefined, done: true });
              return new Promise(r => { resolve = () => { resolve = null; r(this.next()); }; });
            },
          };
        };
      };
      const killer = new AbortController();
      const child: any = {
        pid: Math.floor(Math.random() * 10000) + 1000,
        stdin: {
          write: (data: any) => { if (isClipboardCmd) clipboardBuf += (typeof data === 'string' ? data : String(data)); return true; },
          end: () => { if (isClipboardCmd) toClipboard(clipboardBuf); },
          on: () => child.stdin,
          destroy: () => {},
        },
        stdout: {
          on: (ev: string, fn: Function) => { (stdoutEvents[ev] ??= []).push(fn); return child.stdout; },
          once: (ev: string, fn: Function) => { (stdoutEvents[ev] ??= []).push(fn); return child.stdout; },
          off: (ev: string, fn: Function) => { stdoutEvents[ev] = (stdoutEvents[ev] || []).filter(f => f !== fn); return child.stdout; },
          removeListener: (ev: string, fn: Function) => child.stdout.off(ev, fn),
          removeAllListeners: (ev?: string) => { if (ev) delete stdoutEvents[ev]; else Object.keys(stdoutEvents).forEach(k => delete stdoutEvents[k]); return child.stdout; },
          pipe: (dest: any) => dest,
          setEncoding: () => child.stdout,
          destroy: () => child.stdout,
          [Symbol.asyncIterator]: makeStreamIterator(stdoutEvents),
        },
        stderr: {
          on: (ev: string, fn: Function) => { (stderrEvents[ev] ??= []).push(fn); return child.stderr; },
          once: (ev: string, fn: Function) => { (stderrEvents[ev] ??= []).push(fn); return child.stderr; },
          off: (ev: string, fn: Function) => { stderrEvents[ev] = (stderrEvents[ev] || []).filter(f => f !== fn); return child.stderr; },
          removeListener: (ev: string, fn: Function) => child.stderr.off(ev, fn),
          removeAllListeners: (ev?: string) => { if (ev) delete stderrEvents[ev]; else Object.keys(stderrEvents).forEach(k => delete stderrEvents[k]); return child.stderr; },
          pipe: (dest: any) => dest,
          setEncoding: () => child.stderr,
          destroy: () => child.stderr,
          [Symbol.asyncIterator]: makeStreamIterator(stderrEvents),
        },
        on: (ev: string, fn: Function) => { (events[ev] ??= []).push(fn); return child; },
        once: (ev: string, fn: Function) => { const w = (...a: any[]) => { child.off(ev, w); fn(...a); }; return child.on(ev, w); },
        off: (ev: string, fn: Function) => { events[ev] = (events[ev] || []).filter(f => f !== fn); return child; },
        removeListener: (ev: string, fn: Function) => child.off(ev, fn),
        removeAllListeners: (ev?: string) => { if (ev) delete events[ev]; else Object.keys(events).forEach(k => delete events[k]); return child; },
        emit: (ev: string, ...args: any[]) => { (events[ev] || []).forEach(fn => fn(...args)); },
        // (in the page: the forked shell's abort, which signals the kernel programs it runs)
        kill: (sig?: string | number) => {
          if (child.exitCode !== null) return false;
          const n = typeof sig === 'number' ? sig : ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[sig ?? 'SIGTERM'] ?? 15;
          killer.abort(Object.assign(new DOMException('The operation was aborted.', 'AbortError'), { signal: n }));
          child.killed = true;
          return true;
        },
        killed: false,
        exitCode: null as number | null,
        signalCode: null,
        connected: false,
        ref: () => child,
        unref: () => child,
      };
      if (inheritOut) child.stdout = null;
      if (inheritErr) child.stderr = null;
      // Make child thenable so `await child` works like execa — Claude Code's Bash tool
      // does `await child` which resolves immediately if there's no .then() method,
      // causing it to read the output file before spawn has completed.
      let _resolveChild: ((v: any) => void) | null = null;
      const _childPromise = new Promise<any>(r => { _resolveChild = r; });
      child.then = (resolve?: (v: any) => any, reject?: (e: any) => any) => _childPromise.then(resolve, reject);
      child.catch = (reject?: (e: any) => any) => _childPromise.catch(reject);
      child.finally = (fn?: () => void) => _childPromise.finally(fn);
      // For clipboard commands, resolve after a microtask to let stdin.write/end happen first
      // A guest's child: output reaches data listeners (or our stdout, for 'inherit') as it comes
      const live: Live | undefined = deps.guest && !isClipboardCmd && !stdioOutPath && !stdioErrPath ? {
        out: (t) => { if (inheritOut) deps.getProcess?.()?.stdout?.write(t); else (stdoutEvents['data'] || []).forEach(fn => fn(FakeBuffer.from(t))); },
        err: (t) => { if (inheritErr) deps.getProcess?.()?.stderr?.write(t); else (stderrEvents['data'] || []).forEach(fn => fn(FakeBuffer.from(t))); },
      } : undefined;
      // A guest's child with piped stdin: live pipes both ways, a real process
      if (deps.guest && !isClipboardCmd && !stdioOutPath && !stdioErrPath && !inherits(opts?.stdio, 0) && !ignores(opts?.stdio, 0)) {
        return spawnGuestLive(child, fullCmd, opts, { stdoutEvents, stderrEvents, events, inheritOut, inheritErr, resolve: (v) => _resolveChild?.(v), argv: !opts?.shell && args ? [cmd, ...args.map(String)] : undefined });
      }
      // A node child with piped stdio in the page: live pipes both ways (live-stdin.ts),
      // for programs that talk to it while it runs (esbuild's API and its --service)
      if (!deps.guest && !isClipboardCmd && !opts?.shell && args && /(^|\/)node$/.test(cmd) && !stdioOutPath && !stdioErrPath
        && !inherits(opts?.stdio, 0) && ctx.shell.commands.get('node')) {
        return spawnNodeLive(child, args, opts, { stdoutEvents, stderrEvents, events, inheritOut, inheritErr, resolve: (v) => _resolveChild?.(v) });
      }
      const cmdPromise = isClipboardCmd
        ? new Promise<{ stdout: string; stderr: string; exitCode: number }>(resolve =>
            setTimeout(() => resolve({ stdout: '', stderr: '', exitCode: 0 }), 0))
        : execAsync(fullCmd, opts?.env, undefined, live, [inherits(opts?.stdio, 0), inheritOut, inheritErr], killer);
      const p = cmdPromise.then(r => {
        const writePromises: Promise<any>[] = [];
        // Write output to stdio file paths FIRST (before emitting events, because
        // event handlers may call closeSync which deletes the fd→path mapping).
        // We use stdioOutPath/stdioErrPath captured at spawn time.
        if (stdioOutPath) {
          const existing = fileCache.get(stdioOutPath) || '';
          const newContent = existing + (r.stdout || '') + (stdioErrFd === stdioOutFd ? (r.stderr || '') : '');
          fileCache.set(stdioOutPath, newContent);
          fileMtimes.set(stdioOutPath, Date.now());
          const flush = ctx.fs.writeFile(stdioOutPath, newContent).catch(() => {});
          pendingPromises.push(flush);
          writePromises.push(flush);
        }
        if (stdioErrPath) {
          const existing = fileCache.get(stdioErrPath) || '';
          const newContent = existing + (r.stderr || '');
          fileCache.set(stdioErrPath, newContent);
          fileMtimes.set(stdioErrPath, Date.now());
          const flush = ctx.fs.writeFile(stdioErrPath, newContent).catch(() => {});
          pendingPromises.push(flush);
          writePromises.push(flush);
        }
        const proc = deps.getProcess?.();
        if (inheritOut && r.stdout && !live) proc?.stdout?.write(r.stdout);
        if (inheritErr && r.stderr && !live) proc?.stderr?.write(r.stderr);
        return Promise.all(writePromises).then(() => {
          if (r.stdout && !live) (stdoutEvents['data'] || []).forEach(fn => fn(FakeBuffer.from(r.stdout)));
          (stdoutEvents['end'] || []).forEach(fn => fn());
          (stdoutEvents['close'] || []).forEach(fn => fn());
          if (r.stderr && !live) (stderrEvents['data'] || []).forEach(fn => fn(FakeBuffer.from(r.stderr)));
          (stderrEvents['end'] || []).forEach(fn => fn());
          (stderrEvents['close'] || []).forEach(fn => fn());
          child.exitCode = r.exitCode;
          (events['close'] || []).forEach(fn => fn(r.exitCode, null));
          (events['exit'] || []).forEach(fn => fn(r.exitCode, null));
          _resolveChild?.({ stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode });
        });
      }).catch((err) => {
        (events['error'] || []).forEach(fn => fn(new Error(`spawn ${cmd} failed`)));
        (events['close'] || []).forEach(fn => fn(1, null));
        _resolveChild?.({ stdout: '', stderr: '', exitCode: 1 });
      });
      pendingPromises.push(childWait(p));
      return child;
    },
    execFileSync: (file: string, args?: string[], opts?: any) => {
      // Handle overload: execFileSync(file, opts) without args
      if (args && !Array.isArray(args)) { opts = args; args = undefined; }
      let fullCmd: string;
      if (isShellBin(file) && args) {
        fullCmd = extractShellArgs(args);
      } else {
        fullCmd = args ? `${file} ${shellQuoteArgs(args)}` : file;
      }
      if (deps.guest) { const g = guestSync(fullCmd, opts); guestThrow(fullCmd, g); return g.stdout; }
      // Synchronous fast-path for detection commands
      const syncResponse = inputOf(opts) === undefined ? getSyncResponse(fullCmd) : null;
      if (syncResponse) {
        const buf: any = FakeBuffer.from(syncResponse.stdout);
        buf.then = (resolve: any) => resolve(FakeBuffer.from(syncResponse.stdout));
        return buf;
      }
      let result = '';
      const p = execAsync(fullCmd, undefined, inputOf(opts)).then(r => { result = r.stdout; });
      pendingPromises.push(p);
      // Return thenable Buffer so await resolves to actual result
      const buf: any = FakeBuffer.from('');
      buf.then = (resolve: any, reject: any) => p.then(() => resolve(FakeBuffer.from(result))).catch(reject);
      return buf;
    },
    // fork() — spawn a new Node.js process (delegates to spawn)
    fork: (modulePath: string, args?: string[], options?: any) => {
      if (args && !Array.isArray(args)) { options = args; args = undefined; }
      if (deps.guest) {
        // A real node child with its IPC channel: stdout/stderr its parent's unless silent (as node), stdin a pipe
        const o = options ?? {};
        const given = o.stdio ?? (o.silent ? 'pipe' : ['pipe', 'inherit', 'inherit']);
        const stdio = (Array.isArray(given) ? [...given] : [given, given, given]).map((s: any, i: number) => (i === 0 && (s === 'inherit' || s === 0) ? 'pipe' : s));
        if (!stdio.includes('ipc')) stdio.push('ipc');
        return cpModule.spawn('node', [...(o.execArgv ?? []).map(String), modulePath, ...(args || []).map(String)], { ...o, stdio });
      }
      const nodeArgs = [modulePath, ...(args || [])];
      return cpModule.spawn('node', nodeArgs, { ...options, stdio: 'pipe' });
    },
  };
  // Add util.promisify.custom for exec/execFile to return { stdout, stderr }
  const customSym = Symbol.for('nodejs.util.promisify.custom');
  cpModule.exec[customSym] = (cmd: string, opts?: any) => {
    const p = execAsync(cmd).then(r => {
      if (r.exitCode !== 0) throw Object.assign(new Error(`Command failed: ${cmd}`), { code: r.exitCode, stdout: r.stdout, stderr: r.stderr });
      return { stdout: r.stdout, stderr: r.stderr };
    });
    pendingPromises.push(childWait(p.catch(() => {})));
    return p;
  };
  cpModule.execFile[customSym] = (file: string, args?: string[], opts?: any) => {
    let cmd: string;
    if (isShellBin(file) && args) {
      cmd = extractShellArgs(args);
    } else {
      cmd = `${file} ${shellQuoteArgs(args || [])}`;
    }
    const p = execAsync(cmd).then(r => {
      if (r.exitCode !== 0) throw Object.assign(new Error(`Command failed: ${cmd}`), { code: r.exitCode, stdout: r.stdout, stderr: r.stderr });
      return { stdout: r.stdout, stderr: r.stderr };
    });
    pendingPromises.push(childWait(p.catch(() => {})));
    return p;
  };
  return cpModule;
}
