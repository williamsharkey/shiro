import type { CommandContext } from '../commands/index';
import type { SharedState } from './types';
import { ProcessExitError } from '../commands/jseval/utils';

/**
 * Create the fake process object for the Node.js compat layer.
 * Mirrors Node.js process with stdout, stderr, stdin, env, lifecycle methods.
 */
export function createFakeProcess(
  ctx: CommandContext,
  fileArgs: string[],
  scriptPath: string,
  stdoutBuf: string[],
  stderrBuf: string[],
  _st: SharedState,
  processEvents: Record<string, Function[]>,
  pendingPromises: Promise<any>[],
): any {
  const fp: any = {
    env: {
      ...ctx.env,
      MCP_CONNECTION_NONBLOCKING: '1',
      // Route API calls through CORS proxy when in browser
      ...(typeof window !== 'undefined' && !ctx.env['ANTHROPIC_BASE_URL'] ? {
        ANTHROPIC_BASE_URL: `${window.location.origin}/api/anthropic`,
      } : {}),
      // Suppress npm-to-native-installer warning (only relevant for Claude Code)
      ...(scriptPath?.includes('claude-code') ? {
        DISABLE_INSTALLATION_CHECKS: '1',
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      } : {}),
    } as Record<string, string>,
    cwd: () => ctx.shell.cwd,
    chdir: (dir: string) => { ctx.shell.cwd = ctx.fs.resolvePath(dir, ctx.shell.cwd); ctx.shell.env['PWD'] = ctx.shell.cwd; },
    exit: (c?: number) => {
      if (_st.exitCalled) throw new ProcessExitError(_st.exitCode); // Prevent re-entrant exit
      _st.exitCode = c ?? 0;
      _st.exitCalled = true;
      // Fire 'exit' event handlers (CLI registers cleanup here)
      try { (processEvents['exit'] || []).forEach(fn => fn(_st.exitCode)); } catch (_) {}
      _st.deferredExitResolve?.(_st.exitCode);
      throw new ProcessExitError(_st.exitCode);
    },
    argv: ['node', ...fileArgs],
    argv0: 'node',
    execArgv: [],
    execPath: '/usr/local/bin/node',
    platform: 'linux',
    arch: 'x64',
    version: 'v20.0.0',
    versions: { node: '20.0.0', v8: '11.3.244.8', modules: '115' },
    stdout: createStdout(ctx, stdoutBuf, _st),
    stderr: createStderr(ctx, stderrBuf, _st),
    stdin: createStdin(ctx, _st, processEvents),
    on: (event: string, fn: Function) => {
      (processEvents[event] ??= []).push(fn);
      return fp;
    },
    off: (event: string, fn: Function) => { processEvents[event] = (processEvents[event] || []).filter(f => f !== fn); return fp; },
    once: (event: string, fn: Function) => {
      const wrapper = (...args: any[]) => { fp.off(event, wrapper); fn(...args); };
      return fp.on(event, wrapper);
    },
    emit: (event: string, ...args: any[]) => {
      (processEvents[event] || []).forEach(fn => fn(...args));
    },
    nextTick: (fn: Function, ...args: any[]) => { queueMicrotask(() => fn(...args)); },
    hrtime: Object.assign(
      (prev?: [number, number]) => {
        const now = performance.now();
        const sec = Math.floor(now / 1000);
        const nsec = Math.floor((now % 1000) * 1e6);
        if (prev) {
          let ds = sec - prev[0];
          let dn = nsec - prev[1];
          if (dn < 0) { ds--; dn += 1e9; }
          return [ds, dn];
        }
        return [sec, nsec];
      },
      { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }
    ),
    listeners: (event: string) => [...(processEvents[event] || [])],
    listenerCount: (event: string) => (processEvents[event] || []).length,
    removeListener: (event: string, fn: Function) => { processEvents[event] = (processEvents[event] || []).filter((f: Function) => f !== fn); return fp; },
    removeAllListeners: (event?: string) => { if (event) { delete processEvents[event]; } else { Object.keys(processEvents).forEach(k => delete processEvents[k]); } return fp; },
    addListener: (event: string, fn: Function) => fp.on(event, fn),
    prependListener: (event: string, fn: Function) => { (processEvents[event] ??= []).unshift(fn); return fp; },
    eventNames: () => Object.keys(processEvents),
    setMaxListeners: () => fp,
    getMaxListeners: () => 10,
    rawListeners: (event: string) => [...(processEvents[event] || [])],
    pid: 1,
    ppid: 0,
    kill: (pid: number, signal?: string) => {
      // If killing our own process, treat as exit
      if (pid === 1) {
        // For SIGINT: emit event and let handlers decide (like real Node.js)
        if (signal === 'SIGINT' && processEvents['SIGINT']?.length) {
          try { (processEvents['SIGINT'] || []).forEach(fn => fn('SIGINT')); } catch (_) {}
          return true;
        }
        const code = 128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 0);
        if (!_st.exitCalled) {
          _st.exitCode = code;
          _st.exitCalled = true;
          try { (processEvents['exit'] || []).forEach(fn => fn(_st.exitCode)); } catch (_) {}
        }
        _st.deferredExitResolve?.(_st.exitCode);
      }
      return true;
    },
    title: 'node',
    connected: false,
    channel: undefined,
    config: { variables: {} },
    cpuUsage: () => ({ user: 0, system: 0 }),
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 0, sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0, minorPageFault: 0, majorPageFault: 0, swappedOut: 0, fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0, signalsCount: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0 }),
    uptime: () => performance.now() / 1000,
    umask: () => 0o22,
    getuid: () => 1000,
    getgid: () => 1000,
    geteuid: () => 1000,
    getegid: () => 1000,
    setuid: () => {},
    setgid: () => {},
    features: { inspector: false, debug: false, uv: true, ipv6: true, tls_alpn: true, tls_sni: true, tls_ocsp: true, tls: true },
    release: { name: 'node', sourceUrl: '', headersUrl: '', libUrl: '' },
    report: { getReport: () => ({}), directory: '', filename: '' },
    binding: (_name: string) => { throw new Error(`process.binding is not supported`); },
    _linkedBinding: (_name: string) => { throw new Error(`process._linkedBinding is not supported`); },
    allowedNodeEnvironmentFlags: new Set<string>(),
    debugPort: 9229,
    domain: null,
    throwDeprecation: false,
    noDeprecation: false,
  };

  // Add exitCode as a getter/setter (CLI reads and writes process.exitCode)
  Object.defineProperty(fp, 'exitCode', {
    get: () => _st.exitCalled ? _st.exitCode : undefined,
    set: (v: number | undefined) => { if (v !== undefined) _st.exitCode = v; },
    configurable: true,
    enumerable: true,
  });

  return fp;
}

/** Create process.stdout stream */
function createStdout(ctx: CommandContext, stdoutBuf: string[], _st: SharedState): any {
  const stdoutEvents: Record<string, Function[]> = {};
  const stdoutObj: any = {
    write: (s: string | Uint8Array, encodingOrCb?: string | Function, cb?: Function) => {
      let str = typeof s === 'string' ? s : new TextDecoder().decode(s);
      // Detect OAuth URL in Claude Code login flow and append a clickable link
      const oauthMatch = str.match(/(https:\/\/claude\.ai\/oauth\/authorize\S+)/);
      if (oauthMatch && ctx.terminal) {
        const url = oauthMatch[1];
        str += `\r\n\r\n  \x1b]8;;${url}\x07\x1b[1;36m[ Click here to sign in ]\x1b[0m\x1b]8;;\x07\r\n`;
      }
      stdoutBuf.push(str);
      // Stream to terminal in real-time if available
      if (ctx.terminal) {
        _st.streamedToTerminal = true;
        if (str.includes('\x1b[')) {
          ctx.terminal.writeOutput(str);
        } else {
          ctx.terminal.writeOutput(str.replace(/\r?\n/g, '\r\n'));
        }
      }
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (callback) queueMicrotask(() => (callback as Function)());
      return true;
    },
    isTTY: !!ctx.terminal,
    get columns() { return ctx.terminal ? ctx.terminal.getSize().cols : 80; },
    get rows() { return ctx.terminal ? ctx.terminal.getSize().rows : 24; },
    on: (ev: string, fn: Function) => {
      (stdoutEvents[ev] ??= []).push(fn);
      if (ev === 'resize' && ctx.terminal) {
        const cleanup = ctx.terminal.onResize(() => fn());
        (stdoutObj._resizeCleanups ??= []).push(cleanup);
      }
      return stdoutObj;
    },
    once: (ev: string, fn: Function) => { (stdoutEvents[ev] ??= []).push(fn); return stdoutObj; },
    off: (ev: string, fn: Function) => { stdoutEvents[ev] = (stdoutEvents[ev] || []).filter(f => f !== fn); return stdoutObj; },
    removeListener: (ev: string, fn: Function) => stdoutObj.off(ev, fn),
    removeAllListeners: (ev?: string) => {
      if (ev) delete stdoutEvents[ev]; else Object.keys(stdoutEvents).forEach(k => delete stdoutEvents[k]);
      if (!ev || ev === 'resize') { (stdoutObj._resizeCleanups || []).forEach((c: Function) => c()); stdoutObj._resizeCleanups = []; }
      return stdoutObj;
    },
    emit: (ev: string, ...args: any[]) => { (stdoutEvents[ev] || []).forEach(f => f(...args)); return false; },
    end: () => {},
    getColorDepth: () => ctx.terminal ? 24 : 1,
    hasColors: (count?: number) => ctx.terminal ? (count ? count <= 16777216 : true) : false,
    cursorTo: (x: number, y?: number | Function, cb?: Function) => {
      let seq = `\x1b[${x + 1}G`;
      if (typeof y === 'number') seq = `\x1b[${y + 1};${x + 1}H`;
      else if (typeof y === 'function') { stdoutObj.write(seq); y(); return true; }
      stdoutObj.write(seq);
      if (cb) cb();
      return true;
    },
    clearLine: (dir: number, cb?: Function) => {
      stdoutObj.write(dir === -1 ? '\x1b[1K' : dir === 1 ? '\x1b[0K' : '\x1b[2K');
      if (cb) cb();
      return true;
    },
    moveCursor: (dx: number, dy: number, cb?: Function) => {
      let seq = '';
      if (dx > 0) seq += `\x1b[${dx}C`;
      else if (dx < 0) seq += `\x1b[${-dx}D`;
      if (dy > 0) seq += `\x1b[${dy}B`;
      else if (dy < 0) seq += `\x1b[${-dy}A`;
      if (seq) stdoutObj.write(seq);
      if (cb) cb();
      return true;
    },
    clearScreenDown: (cb?: Function) => { stdoutObj.write('\x1b[J'); if (cb) cb(); return true; },
    writable: true,
    fd: 1,
    getWindowSize: () => [ctx.terminal ? ctx.terminal.getSize().cols : 80, ctx.terminal ? ctx.terminal.getSize().rows : 24],
    listeners: (ev: string) => [...(stdoutEvents[ev] || [])],
    listenerCount: (ev: string) => (stdoutEvents[ev] || []).length,
    eventNames: () => Object.keys(stdoutEvents),
    setMaxListeners: () => stdoutObj,
    cork: () => {},
    uncork: () => {},
  };
  return stdoutObj;
}

/** Create process.stderr stream */
function createStderr(ctx: CommandContext, stderrBuf: string[], _st: SharedState): any {
  const stderrEvts: Record<string, Function[]> = {};
  const stderrObj: any = {
    write: (s: string | Uint8Array, encodingOrCb?: string | Function, cb?: Function) => {
      const str = typeof s === 'string' ? s : new TextDecoder().decode(s);
      stderrBuf.push(str);
      if (ctx.terminal) {
        _st.streamedToTerminal = true;
        if (str.includes('\x1b[')) {
          ctx.terminal.writeOutput(str);
        } else {
          ctx.terminal.writeOutput(str.replace(/\r?\n/g, '\r\n'));
        }
      }
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (callback) queueMicrotask(() => (callback as Function)());
      return true;
    },
    isTTY: !!ctx.terminal,
    get columns() { return ctx.terminal ? ctx.terminal.getSize().cols : 80; },
    get rows() { return ctx.terminal ? ctx.terminal.getSize().rows : 24; },
    on: (ev: string, fn: Function) => { (stderrEvts[ev] ??= []).push(fn); return stderrObj; },
    once: (ev: string, fn: Function) => { (stderrEvts[ev] ??= []).push(fn); return stderrObj; },
    off: (ev: string, fn: Function) => { stderrEvts[ev] = (stderrEvts[ev] || []).filter(f => f !== fn); return stderrObj; },
    removeListener: (ev: string, fn: Function) => stderrObj.off(ev, fn),
    removeAllListeners: (ev?: string) => { if (ev) delete stderrEvts[ev]; else Object.keys(stderrEvts).forEach(k => delete stderrEvts[k]); return stderrObj; },
    emit: (ev: string, ...args: any[]) => { (stderrEvts[ev] || []).forEach(f => f(...args)); return false; },
    end: () => {},
    getColorDepth: () => ctx.terminal ? 24 : 1,
    hasColors: (count?: number) => ctx.terminal ? (count ? count <= 16777216 : true) : false,
    cursorTo: (x: number, y?: number, cb?: Function) => { if (cb) cb(); return true; },
    clearLine: (dir: number, cb?: Function) => { if (cb) cb(); return true; },
    moveCursor: (dx: number, dy: number, cb?: Function) => { if (cb) cb(); return true; },
    clearScreenDown: (cb?: Function) => { if (cb) cb(); return true; },
    writable: true,
    fd: 2,
    getWindowSize: () => [ctx.terminal ? ctx.terminal.getSize().cols : 80, ctx.terminal ? ctx.terminal.getSize().rows : 24],
    listeners: (ev: string) => [...(stderrEvts[ev] || [])],
    listenerCount: (ev: string) => (stderrEvts[ev] || []).length,
    setMaxListeners: () => stderrObj,
  };
  return stderrObj;
}

/** Create process.stdin stream */
function createStdin(ctx: CommandContext, _st: SharedState, processEvents: Record<string, Function[]>): any {
  const stdinEvents: Record<string, Function[]> = {};
  let stdinEnded = false;
  let stdinRawMode = false;
  const stdinReadBuffer: string[] = [];
  const stdinObj: any = {
    isTTY: !!ctx.terminal,
    fd: 0,
    on: (event: string, fn: Function) => {
      (stdinEvents[event] ??= []).push(fn);
      if (!ctx.terminal && event === 'end' && !stdinEnded) {
        stdinEnded = true;
        queueMicrotask(() => {
          if (ctx.stdin) {
            stdinReadBuffer.push(ctx.stdin);
            (stdinEvents['data'] || []).forEach(f => f(ctx.stdin));
            (stdinEvents['readable'] || []).forEach(f => f());
          }
          (stdinEvents['end'] || []).forEach(f => f());
          (stdinEvents['close'] || []).forEach(f => f());
        });
      }
      return stdinObj;
    },
    once: (event: string, fn: Function) => {
      const wrapper = (...args: any[]) => {
        stdinEvents[event] = (stdinEvents[event] || []).filter(f => f !== wrapper);
        fn(...args);
      };
      return stdinObj.on(event, wrapper);
    },
    off: (event: string, fn: Function) => {
      stdinEvents[event] = (stdinEvents[event] || []).filter(f => f !== fn); return stdinObj;
    },
    removeListener: (event: string, fn: Function) => stdinObj.off(event, fn),
    removeAllListeners: (event?: string) => {
      if (event) delete stdinEvents[event];
      else Object.keys(stdinEvents).forEach(k => delete stdinEvents[k]);
      return stdinObj;
    },
    emit: (event: string, ...args: any[]) => { (stdinEvents[event] || []).forEach(f => f(...args)); return false; },
    resume: () => {
      if (ctx.terminal && !stdinEnded) {
        const forceExit = () => {
          if (!_st.exitCalled) { _st.exitCode = 130; _st.exitCalled = true; }
          _st.deferredExitResolve?.(_st.exitCode);
        };
        ctx.terminal.enterStdinPassthrough((data: string) => {
          if (data.includes('\x03')) {
            try { (processEvents['SIGINT'] || []).forEach(fn => fn('SIGINT')); } catch (_) {}
          }
          stdinReadBuffer.push(data);
          (stdinEvents['data'] || []).forEach(f => f(data));
          (stdinEvents['readable'] || []).forEach(f => f());
        }, forceExit);
      }
      return stdinObj;
    },
    pause: () => stdinObj,
    read: (_size?: number) => {
      if (stdinReadBuffer.length === 0) return null;
      return stdinReadBuffer.shift()!;
    },
    setRawMode: (mode: boolean) => {
      stdinRawMode = mode;
      if (mode && ctx.terminal && !stdinEnded) {
        _st.isInteractiveMode = true;
        _st.ownsStdinPassthrough = true;
        if (_st.scriptTimeoutId) { clearTimeout(_st.scriptTimeoutId); _st.scriptTimeoutId = null; }
        const forceExit = () => {
          if (!_st.exitCalled) { _st.exitCode = 130; _st.exitCalled = true; }
          _st.deferredExitResolve?.(_st.exitCode);
        };
        ctx.terminal.enterStdinPassthrough((data: string) => {
          if (data.includes('\x03')) {
            try { (processEvents['SIGINT'] || []).forEach(fn => fn('SIGINT')); } catch (_) {}
          }
          stdinReadBuffer.push(data);
          (stdinEvents['data'] || []).forEach(f => f(data));
          (stdinEvents['readable'] || []).forEach(f => f());
        }, forceExit);
      } else if (!mode && ctx.terminal) {
        ctx.terminal.exitStdinPassthrough();
        if (_st.isInteractiveMode) {
          setTimeout(() => {
            if (!_st.exitCalled) {
              _st.exitCode = 0;
              _st.exitCalled = true;
              _st.deferredExitResolve?.(0);
            }
          }, 500);
        }
      }
      return stdinObj;
    },
    get isRaw() { return stdinRawMode; },
    setEncoding: () => stdinObj,
    destroy: () => {
      if (ctx.terminal) ctx.terminal.exitStdinPassthrough();
      stdinEnded = true;
      return stdinObj;
    },
    pipe: () => stdinObj,
    unpipe: () => stdinObj,
    readable: !!ctx.terminal,
    ref: () => stdinObj,
    unref: () => stdinObj,
    listeners: (event: string) => [...(stdinEvents[event] || [])],
    listenerCount: (event: string) => (stdinEvents[event] || []).length,
    eventNames: () => Object.keys(stdinEvents),
    prependListener: (event: string, fn: Function) => { (stdinEvents[event] ??= []).unshift(fn); return stdinObj; },
    setMaxListeners: () => stdinObj,
    getMaxListeners: () => 10,
    addListener: (event: string, fn: Function) => stdinObj.on(event, fn),
  };
  return stdinObj;
}
