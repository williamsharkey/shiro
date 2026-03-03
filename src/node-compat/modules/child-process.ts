import type { CommandContext } from '../../commands/index';

export interface ChildProcessDeps {
  ctx: CommandContext;
  fileCache: Map<string, string>;
  fileMtimes: Map<string, number>;
  pendingPromises: Promise<any>[];
  FakeBuffer: any;
}

export function createChildProcessModule(deps: ChildProcessDeps): any {
  const { ctx, fileCache, fileMtimes, pendingPromises, FakeBuffer } = deps;

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
      return { stdout: 'v20.0.0\n', stderr: '', status: 0 };
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
      if (flags === '-n') return { stdout: 'shiro\n', stderr: '', status: 0 };
      if (flags === '-r') return { stdout: '0.1.0\n', stderr: '', status: 0 };
      if (flags === '-a') return { stdout: 'Linux shiro 0.1.0 x86_64\n', stderr: '', status: 0 };
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
      if (key === 'user.email') return { stdout: 'user@shiro.computer\n', stderr: '', status: 0 };
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
  const isShellBin = (s: string) => /^\/bin\/(?:sh|bash|zsh)$/.test(s);
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
    const cIdx = args.findIndex(a => /^-\w*c$/.test(a));
    if (cIdx >= 0 && cIdx + 1 < args.length) return args.slice(cIdx + 1).join(' ');
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
  const execAsync = async (cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
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
        return { stdout: 'ripgrep 14.0.0 (shiro shim)\n', stderr: '', exitCode: 0 };
      }
      // Pass through to Shiro's builtin rg command (handles --files, --sort, all flags)
      normalized = `rg ${rgArgs}`;
    }

    // Suppress OAuth browser popup — it doesn't work in Shiro (wrong redirect domain).
    // Claude Code will fall back to showing the URL in terminal, which we make clickable.
    // The URL may be wrapped in single quotes by shellQuoteArgs, so strip them.
    const oauthOpenMatch = normalized.match(/^(open|xdg-open)\s+['"]*?(https:\/\/claude\.ai\/oauth\/\S+?)['"]*$/);
    if (oauthOpenMatch) {
      // The `open` URL has redirect_uri=http://localhost:PORT/callback (local server).
      // On Shiro this doesn't work — replace with the manual-flow redirect that
      // shows a code the user can paste back into the terminal.
      const oauthUrl = oauthOpenMatch[2].replace(
        /redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2F[^&]*/,
        'redirect_uri=' + encodeURIComponent('https://platform.claude.com/oauth/code/callback')
      );
      // Write clickable sign-in buttons to terminal
      if (ctx.terminal) {
        const copyUri = `shiro://copy?text=${encodeURIComponent(oauthUrl)}`;
        const copyBtn = `\x1b]8;;${copyUri}\x07\x1b[1;33m[ Copy URL ]\x1b[0m\x1b]8;;\x07`;
        const openBtn = `\x1b]8;;${oauthUrl}\x07\x1b[1;36m[ Open in Browser ]\x1b[0m\x1b]8;;\x07`;
        ctx.terminal.writeOutput(`\r\n  ${copyBtn}  ${openBtn}\r\n`);
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    }

    // Drain pending IDB writes so shell commands can see files written by
    // writeFileSync (which only updates fileCache + queues async IDB write).
    if (pendingPromises.length > 0) {
      await Promise.all(pendingPromises.splice(0));
    }

    let stdout = '';
    let stderr = '';
    const exitCode = await ctx.shell.execute(normalized, (s) => { stdout += s; }, (s) => { stderr += s; }, false, ctx.terminal, true);

    // Refresh fileCache from Shiro FS cache — shell commands may have created,
    // modified, or deleted files that fileCache still has stale entries for.
    for (const [path] of fileCache) {
      if (path.endsWith('/.')) continue; // skip dir markers
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
      // Synchronous fast-path for detection commands
      const syncResponse = getSyncResponse(effectiveCmd);
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
      const p = execAsync(effectiveCmd).then(r => { result = r.stdout; resultErr = r.stderr; resultCode = r.exitCode; });
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
      const wantString = opts?.encoding && opts.encoding !== 'buffer';
      const wrap = (s: string) => wantString ? s : FakeBuffer.from(s);
      // Synchronous fast-paths for version/detection checks that the CLI reads
      // without awaiting. Without this, stdout is '' when read synchronously.
      const syncResponse = getSyncResponse(fullCmd);
      if (syncResponse) {
        const out = wrap(syncResponse.stdout);
        const err = wrap(syncResponse.stderr);
        const st = syncResponse.status;
        return {
          get stdout() { return out; },
          get stderr() { return err; },
          get status() { return st; },
          error: st !== 0 ? new Error(`spawnSync exited with ${st}`) : undefined as any,
          then: (resolve: any) => resolve({ stdout: out, stderr: err, status: st }),
        };
      }
      let stdout = '';
      let stderr = '';
      let status = 0;
      const p = execAsync(fullCmd).then(r => { stdout = r.stdout; stderr = r.stderr; status = r.exitCode; });
      pendingPromises.push(p);
      return {
        get stdout() { return wrap(stdout); },
        get stderr() { return wrap(stderr); },
        get status() { return status; },
        get error() { return status !== 0 ? new Error(`spawnSync exited with ${status}`) : undefined; },
        then: (resolve: any, reject: any) => p.then(() => resolve({ stdout: wrap(stdout), stderr: wrap(stderr), status })).catch(reject),
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
      pendingPromises.push(p);
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
          end: () => { if (isClipCmd) navigator.clipboard.writeText(clipBuf).catch(() => {}); },
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
      pendingPromises.push(p);
      return child;
    },
    spawn: (cmd: string, args?: string[], opts?: any) => {
      let fullCmd: string;
      if (isShellBin(cmd) && args) {
        fullCmd = extractShellArgs(args);
      } else {
        fullCmd = args ? `${cmd} ${shellQuoteArgs(args)}` : cmd;
      }
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
      const child: any = {
        pid: Math.floor(Math.random() * 10000) + 1000,
        stdin: {
          write: (data: any) => { if (isClipboardCmd) clipboardBuf += (typeof data === 'string' ? data : String(data)); return true; },
          end: () => { if (isClipboardCmd) navigator.clipboard.writeText(clipboardBuf).catch(() => {}); },
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
        kill: () => true,
        killed: false,
        exitCode: null as number | null,
        signalCode: null,
        connected: false,
        ref: () => child,
        unref: () => child,
      };
      // For clipboard commands, resolve after a microtask to let stdin.write/end happen first
      const cmdPromise = isClipboardCmd
        ? new Promise<{ stdout: string; stderr: string; exitCode: number }>(resolve =>
            setTimeout(() => resolve({ stdout: '', stderr: '', exitCode: 0 }), 0))
        : execAsync(fullCmd);
      const p = cmdPromise.then(r => {
        if (r.stdout) (stdoutEvents['data'] || []).forEach(fn => fn(FakeBuffer.from(r.stdout)));
        (stdoutEvents['end'] || []).forEach(fn => fn());
        (stdoutEvents['close'] || []).forEach(fn => fn());
        if (r.stderr) (stderrEvents['data'] || []).forEach(fn => fn(FakeBuffer.from(r.stderr)));
        (stderrEvents['end'] || []).forEach(fn => fn());
        (stderrEvents['close'] || []).forEach(fn => fn());
        child.exitCode = r.exitCode;
        (events['close'] || []).forEach(fn => fn(r.exitCode, null));
        (events['exit'] || []).forEach(fn => fn(r.exitCode, null));
      }).catch((err) => {
        (events['error'] || []).forEach(fn => fn(new Error(`spawn ${cmd} failed`)));
        (events['close'] || []).forEach(fn => fn(1, null));
      });
      pendingPromises.push(p);
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
      // Synchronous fast-path for detection commands
      const syncResponse = getSyncResponse(fullCmd);
      if (syncResponse) {
        const buf: any = FakeBuffer.from(syncResponse.stdout);
        buf.then = (resolve: any) => resolve(FakeBuffer.from(syncResponse.stdout));
        return buf;
      }
      let result = '';
      const p = execAsync(fullCmd).then(r => { result = r.stdout; });
      pendingPromises.push(p);
      // Return thenable Buffer so await resolves to actual result
      const buf: any = FakeBuffer.from('');
      buf.then = (resolve: any, reject: any) => p.then(() => resolve(FakeBuffer.from(result))).catch(reject);
      return buf;
    },
    // fork() — spawn a new Node.js process (delegates to spawn)
    fork: (modulePath: string, args?: string[], options?: any) => {
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
    pendingPromises.push(p.catch(() => {}));
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
    pendingPromises.push(p.catch(() => {}));
    return p;
  };
  return cpModule;
}
