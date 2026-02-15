import { Command, CommandContext } from './index';
import { virtualServer, VirtualRequest, VirtualResponse } from '../virtual-server';
import { iframeServer } from '../iframe-server';

// Synchronous SHA-256 implementation (Web Crypto is async-only, but Node's createHash is sync)
function sha256sync(data: Uint8Array): Uint8Array {
  const K: number[] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rr = (v: number, n: number) => (v >>> n) | (v << (32 - n));
  // Pre-processing: padding
  const bitLen = data.length * 8;
  const padLen = (((data.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen, false);
  // Process blocks
  let [h0, h1, h2, h3, h4, h5, h6, h7] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Int32Array(64);
  for (let i = 0; i < padLen; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getInt32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = rr(w[j-15], 7) ^ rr(w[j-15], 18) ^ (w[j-15] >>> 3);
      const s1 = rr(w[j-2], 17) ^ rr(w[j-2], 19) ^ (w[j-2] >>> 10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let j = 0; j < 64; j++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => odv.setUint32(i * 4, v, false));
  return out;
}

// Synchronous SHA-1 implementation
function sha1sync(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const padLen = (((data.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen, false);
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  const rl = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  const w = new Int32Array(80);
  for (let i = 0; i < padLen; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getInt32(i + j * 4, false);
    for (let j = 16; j < 80; j++) w[j] = rl(w[j-3] ^ w[j-8] ^ w[j-14] ^ w[j-16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (rl(a, 5) + f + e + k + w[j]) | 0;
      e = d; d = c; c = rl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((v, i) => odv.setUint32(i * 4, v, false));
  return out;
}

// FNV-1a fallback for non-critical hashes (md5 etc.)
function fnvHash(data: Uint8Array, len: number): Uint8Array {
  let h0 = 0x811c9dc5 >>> 0, h1 = 0x6c62272e >>> 0;
  for (let i = 0; i < data.length; i++) {
    h0 = (h0 ^ data[i]) >>> 0; h0 = Math.imul(h0, 0x01000193) >>> 0;
    h1 = (h1 ^ data[i]) >>> 0; h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  const result = new Uint8Array(len);
  const dv = new DataView(result.buffer);
  dv.setUint32(0, h0); dv.setUint32(4, h1);
  dv.setUint32(8, h0 ^ 0xa5a5a5a5); dv.setUint32(12, h1 ^ 0x5a5a5a5a);
  if (len > 16) { dv.setUint32(16, h0 ^ h1); for (let i = 20; i < len; i += 4) if (i + 3 < len) dv.setUint32(i, h0 + i); }
  return result;
}

/**
 * js-eval: Execute JavaScript in the browser's JS VM.
 * This gives Claude Code (via Spirit) and users direct access to the DOM,
 * browser APIs, and the full JavaScript runtime.
 *
 * Usage:
 *   js-eval 'document.title'
 *   js-eval '1 + 2'
 *   js-eval 'fetch("https://example.com").then(r => r.text())'
 *   echo 'console.log("hello")' | js-eval
 *
 * The evaluation context includes:
 *   - shiro.fs: the virtual filesystem
 *   - shiro.shell: the shell instance
 *   - shiro.env: environment variables
 *   - Full DOM access (document, window, etc.)
 */
export const jsEvalCmd: Command = {
  name: 'js-eval',
  description: 'Evaluate JavaScript expression in the browser VM',
  async exec(ctx: CommandContext): Promise<number> {
    let code = ctx.args.join(' ');

    // If no args, read from stdin
    if (!code.trim() && ctx.stdin) {
      code = ctx.stdin;
    }

    if (!code.trim()) {
      ctx.stderr += 'js-eval: no code provided\n';
      ctx.stderr += 'Usage: js-eval <expression>\n';
      return 1;
    }

    try {
      // Create a context object that scripts can use
      const shiroCtx = {
        fs: ctx.fs,
        shell: ctx.shell,
        env: ctx.env,
        cwd: ctx.cwd,
      };

      // Use AsyncFunction to support await in top-level expressions
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = new AsyncFunction('shiro', `
        const result = await (async () => { return (${code}); })().catch(async () => {
          // If expression eval fails, try as statements
          await (async () => { ${code} })();
          return undefined;
        });
        return result;
      `);

      const result = await fn(shiroCtx);

      if (result !== undefined) {
        const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        ctx.stdout += output + '\n';
      }
      return 0;
    } catch (e: any) {
      ctx.stderr += `js-eval: ${e.message}\n`;
      return 1;
    }
  },
};

/**
 * node: A Node.js-like command that executes JS files from the virtual filesystem.
 *
 * Usage:
 *   node script.js
 *   node -e 'console.log("hello")'
 *   node -p '1 + 2'    (print result)
 *
 * Provides a minimal Node-like environment:
 *   - console.log/warn/error write to stdout/stderr
 *   - process.env, process.cwd(), process.exit()
 *   - require() is not available (use dynamic import or js-eval for browser modules)
 */
export const nodeCmd: Command = {
  name: 'node',
  description: 'Execute JavaScript files (browser JS VM)',
  async exec(ctx: CommandContext): Promise<number> {
    let code = '';
    let printResult = false;

    // Parse args — once we see a script file, everything after is script args
    const fileArgs: string[] = [];
    let foundScript = false;
    for (let i = 0; i < ctx.args.length; i++) {
      if (foundScript) {
        // After script path, everything is a script argument
        fileArgs.push(ctx.args[i]);
      } else if (ctx.args[i] === '-e' || ctx.args[i] === '--eval') {
        code = ctx.args[++i] || '';
      } else if (ctx.args[i] === '-p' || ctx.args[i] === '--print') {
        code = ctx.args[++i] || '';
        printResult = true;
      } else if (ctx.args[i] === '--help' || ctx.args[i] === '-h') {
        ctx.stdout += 'Usage: node [options] [script.js] [arguments]\n';
        ctx.stdout += '  -e, --eval <code>   Evaluate code\n';
        ctx.stdout += '  -p, --print <code>  Evaluate and print result\n';
        ctx.stdout += '\nNote: Runs in browser JS VM, not real Node.js.\n';
        ctx.stdout += 'Full DOM/browser API access available.\n';
        return 0;
      } else {
        fileArgs.push(ctx.args[i]);
        foundScript = true; // First non-flag arg is the script path
      }
    }

    // If no -e flag, read from file
    let scriptPath = '';
    if (!code && fileArgs.length > 0) {
      scriptPath = ctx.fs.resolvePath(fileArgs[0], ctx.cwd);
      try {
        code = await ctx.fs.readFile(scriptPath, 'utf8') as string;
      } catch (e: any) {
        ctx.stderr += `node: ${e.message}\n`;
        return 1;
      }
    }

    // If no file and no -e, read from stdin
    if (!code && ctx.stdin) {
      code = ctx.stdin;
    }

    if (!code) {
      ctx.stderr += 'node: no input provided\n';
      return 1;
    }

    // Suppress unhandled rejections from CLI force-exit patterns
    // (process.exit → catch → process.kill → catch → throw "unreachable")
    // and WASM compile errors (tree-sitter uses WASM features not supported in all browsers).
    let _nodeStderrBuf: string[] | null = null; // Set once stderrBuf is available
    const suppressRejection = (event: PromiseRejectionEvent) => {
      const msg = event.reason?.message || String(event.reason || '');
      if (event.reason?._isProcessExit || msg === 'unreachable' || msg.startsWith('Aborted(') || msg === 'need dylink section') {
        event.preventDefault();
      } else {
        // Log non-suppressed rejections to stderr so they're visible in tool output
        const errStr = msg || 'Unknown error';
        _nodeStderrBuf?.push(`UnhandledPromiseRejection: ${errStr}`);
        if (ctx.terminal) ctx.terminal.writeOutput(`\x1b[31mUnhandledPromiseRejection: ${errStr}\x1b[0m\r\n`);
        event.preventDefault();
      }
    };

    // Save originals for CORS proxy interception (must be in outer scope for catch block)
    const _origFetch = globalThis.fetch;
    const _origXHR = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined;
    const _prevST = globalThis.setTimeout;
    const _prevCT = globalThis.clearTimeout;
    let _ownsStdinPassthrough = false; // Track if THIS invocation set up stdin passthrough

    try {
      // Build a minimal Node-like environment
      let exitCode = 0;
      let exitCalled = false;

      const stdoutBuf: string[] = [];
      const stderrBuf: string[] = [];
      _nodeStderrBuf = stderrBuf; // Wire up for unhandled rejection logging
      const pendingPromises: Promise<any>[] = []; // Track async operations like app.listen()
      let streamedToTerminal = false; // True if output was streamed directly to terminal
      let isInteractiveMode = false;        // Set when stdin.setRawMode(true) called (ink)
      let scriptTimeoutId: any = null;       // Handle for cancelling SCRIPT_TIMEOUT

      const fakeConsole: any = {
        log: (...args: any[]) => {
          const s = args.map(formatArg).join(' ');
          stdoutBuf.push(s);
          if (ctx.terminal) { streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
        },
        info: (...args: any[]) => {
          const s = args.map(formatArg).join(' ');
          stdoutBuf.push(s);
          if (ctx.terminal) { streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
        },
        warn: (...args: any[]) => { stderrBuf.push(args.map(formatArg).join(' ')); },
        error: (...args: any[]) => { stderrBuf.push(args.map(formatArg).join(' ')); },
        dir: (obj: any) => {
          const s = JSON.stringify(obj, null, 2);
          stdoutBuf.push(s);
          if (ctx.terminal) { streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
        },
        debug: (...args: any[]) => { fakeConsole.log(...args); },
        trace: (...args: any[]) => { fakeConsole.log(...args); },
        assert: (val: any, ...args: any[]) => { if (!val) fakeConsole.error('Assertion failed:', ...args); },
        time: () => {}, timeEnd: () => {}, timeLog: () => {},
        count: () => {}, countReset: () => {},
        group: () => {}, groupEnd: () => {}, groupCollapsed: () => {},
        clear: () => { if (ctx.terminal) ctx.terminal.writeOutput('\x1b[2J\x1b[H'); },
        table: (...args: any[]) => { fakeConsole.log(...args); },
      };
      // Console constructor — Node.js API: new console.Console(stdout, stderr)
      class FakeConsoleClass {
        _stdout: any; _stderr: any;
        constructor(stdoutOrOpts?: any, stderr?: any) {
          if (stdoutOrOpts && typeof stdoutOrOpts === 'object' && stdoutOrOpts.stdout) {
            this._stdout = stdoutOrOpts.stdout;
            this._stderr = stdoutOrOpts.stderr || stdoutOrOpts.stdout;
          } else {
            this._stdout = stdoutOrOpts || fakeProcess?.stdout;
            this._stderr = stderr || stdoutOrOpts || fakeProcess?.stderr;
          }
        }
        log(...args: any[]) { const s = args.map(formatArg).join(' ') + '\n'; if (this._stdout?.write) this._stdout.write(s); else { stdoutBuf.push(s.replace(/\n$/, '')); if (ctx.terminal) { streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n')); } } }
        info(...args: any[]) { this.log(...args); }
        warn(...args: any[]) { const s = args.map(formatArg).join(' ') + '\n'; if (this._stderr?.write) this._stderr.write(s); else { stderrBuf.push(s.replace(/\n$/, '')); } }
        error(...args: any[]) { this.warn(...args); }
        dir(obj: any) { this.log(obj); }
        debug(...args: any[]) { this.log(...args); }
        trace(...args: any[]) { this.log(...args); }
        assert(val: any, ...args: any[]) { if (!val) this.error('Assertion failed:', ...args); }
        time() {} timeEnd() {} timeLog() {}
        count() {} countReset() {}
        group() {} groupEnd() {} groupCollapsed() {}
        clear() { fakeConsole.clear(); }
        table(...args: any[]) { this.log(...args); }
      }
      fakeConsole.Console = FakeConsoleClass;

      const processEvents: Record<string, Function[]> = {};
      // Deferred exit: resolves when process.exit is called from async code
      let deferredExitResolve: ((code: number) => void) | null = null;
      const deferredExitPromise = new Promise<number>((resolve) => { deferredExitResolve = resolve; });
      const fakeProcess = {
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
          if (exitCalled) throw new ProcessExitError(exitCode); // Prevent re-entrant exit
          exitCode = c ?? 0;
          exitCalled = true;
          // Fire 'beforeExit' if present
          // Fire 'exit' event handlers (CLI registers cleanup here)
          try { (processEvents['exit'] || []).forEach(fn => fn(exitCode)); } catch (_) {}
          deferredExitResolve?.(exitCode);
          throw new ProcessExitError(exitCode);
        },
        argv: ['node', ...fileArgs],
        argv0: 'node',
        execArgv: [],
        execPath: '/usr/local/bin/node',
        platform: 'linux',
        arch: 'x64',
        version: 'v20.0.0',
        versions: { node: '20.0.0', v8: '11.3.244.8', modules: '115' },
        stdout: (() => {
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
              // Stream to terminal in real-time if available (enables streaming for claude -p, etc.)
              if (ctx.terminal) {
                streamedToTerminal = true;
                // If output contains ANSI escape sequences, pass through unchanged —
                // programs using ANSI cursor control handle their own line endings.
                // Only convert bare \n to \r\n for simple text output.
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
              // Hook resize events to terminal's resize callback
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
              // Clean up resize hooks
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
        })(),
        stderr: (() => {
          const stderrEvts: Record<string, Function[]> = {};
          const stderrObj: any = {
            write: (s: string | Uint8Array, encodingOrCb?: string | Function, cb?: Function) => {
              const str = typeof s === 'string' ? s : new TextDecoder().decode(s);
              stderrBuf.push(str);
              if (ctx.terminal) {
                streamedToTerminal = true;
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
        })(),
        stdin: (() => {
          const stdinEvents: Record<string, Function[]> = {};
          let stdinEnded = false;
          let stdinRawMode = false;
          const stdinReadBuffer: string[] = []; // Buffer for readable stream interface
          const stdinObj: any = {
            isTTY: !!ctx.terminal,
            fd: 0,
            on: (event: string, fn: Function) => {
              (stdinEvents[event] ??= []).push(fn);
              // When terminal is available (interactive), don't auto-close stdin.
              // Instead, bridge terminal input to stdin data events.
              if (!ctx.terminal && event === 'end' && !stdinEnded) {
                // Non-interactive: deliver any piped data then close stdin
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
              // When resumed with terminal available, start bridging terminal input
              if (ctx.terminal && !stdinEnded) {
                const forceExit = () => {
                  if (!exitCalled) { exitCode = 130; exitCalled = true; }
                  deferredExitResolve?.(exitCode);
                };
                ctx.terminal.enterStdinPassthrough((data: string) => {
                  // Emit SIGINT when Ctrl+C received (like real TTY driver)
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
              // ink calls setRawMode(true) — activate stdin passthrough for raw keypresses
              if (mode && ctx.terminal && !stdinEnded) {
                isInteractiveMode = true;
                _ownsStdinPassthrough = true;
                // Cancel script timeout — interactive apps run indefinitely
                if (scriptTimeoutId) { clearTimeout(scriptTimeoutId); scriptTimeoutId = null; }
                const forceExit = () => {
                  if (!exitCalled) { exitCode = 130; exitCalled = true; }
                  deferredExitResolve?.(exitCode);
                };
                ctx.terminal.enterStdinPassthrough((data: string) => {
                  // Emit SIGINT when Ctrl+C received (like real TTY driver)
                  if (data.includes('\x03')) {
                    try { (processEvents['SIGINT'] || []).forEach(fn => fn('SIGINT')); } catch (_) {}
                  }
                  // Support both push (data events) and pull (readable + read()) interfaces
                  stdinReadBuffer.push(data);
                  (stdinEvents['data'] || []).forEach(f => f(data));
                  (stdinEvents['readable'] || []).forEach(f => f());
                }, forceExit);
              } else if (!mode && ctx.terminal) {
                ctx.terminal.exitStdinPassthrough();
                // Ink calls setRawMode(false) when unmounting (e.g., /exit).
                // In real Node.js the event loop drains and process exits naturally.
                // In our VM we must explicitly resolve the deferred exit promise.
                if (isInteractiveMode) {
                  setTimeout(() => {
                    if (!exitCalled) {
                      exitCode = 0;
                      exitCalled = true;
                      deferredExitResolve?.(0);
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
        })(),
        on: (event: string, fn: Function) => {
          (processEvents[event] ??= []).push(fn);
          return fakeProcess;
        },
        off: (event: string, fn: Function) => { processEvents[event] = (processEvents[event] || []).filter(f => f !== fn); return fakeProcess; },
        once: (event: string, fn: Function) => {
          const wrapper = (...args: any[]) => { fakeProcess.off(event, wrapper); fn(...args); };
          return fakeProcess.on(event, wrapper);
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
        removeListener: (event: string, fn: Function) => { processEvents[event] = (processEvents[event] || []).filter((f: Function) => f !== fn); return fakeProcess; },
        removeAllListeners: (event?: string) => { if (event) { delete processEvents[event]; } else { Object.keys(processEvents).forEach(k => delete processEvents[k]); } return fakeProcess; },
        addListener: (event: string, fn: Function) => fakeProcess.on(event, fn),
        prependListener: (event: string, fn: Function) => { (processEvents[event] ??= []).unshift(fn); return fakeProcess; },
        eventNames: () => Object.keys(processEvents),
        setMaxListeners: () => fakeProcess,
        getMaxListeners: () => 10,
        rawListeners: (event: string) => [...(processEvents[event] || [])],
        pid: 1,
        ppid: 0,
        kill: (pid: number, signal?: string) => {
          // If killing our own process, treat as exit (CLI does this as fallback after process.exit fails)
          // Don't throw — kill() is called asynchronously from force-exit paths (e.g. CLI's _J6)
          // where the throw would escape as an unhandled rejection
          if (pid === 1) {
            // For SIGINT: emit event and let handlers decide (like real Node.js)
            if (signal === 'SIGINT' && processEvents['SIGINT']?.length) {
              try { (processEvents['SIGINT'] || []).forEach(fn => fn('SIGINT')); } catch (_) {}
              return true;
            }
            const code = 128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 0);
            if (!exitCalled) {
              exitCode = code;
              exitCalled = true;
              try { (processEvents['exit'] || []).forEach(fn => fn(exitCode)); } catch (_) {}
            }
            deferredExitResolve?.(exitCode);
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
      Object.defineProperty(fakeProcess, 'exitCode', {
        get: () => exitCalled ? exitCode : undefined,
        set: (v: number | undefined) => { if (v !== undefined) exitCode = v; },
        configurable: true,
        enumerable: true,
      });

      // CommonJS require() with pre-loaded file cache
      const fileCache = new Map<string, string>();
      const fileMtimes = new Map<string, number>(); // path → mtime ms (from preload or writeFileSync)
      const moduleCache = new Map<string, { exports: any }>();

      // Sync operation watchdog — detects runaway sync loops that would freeze the tab.
      // Resets on each microtask boundary so normal async code is unaffected.
      let syncOpCount = 0;
      const SYNC_OP_LIMIT = 50_000; // ~50k sync FS calls without yielding
      let syncResetScheduled = false;
      function tickSyncOps() {
        if (++syncOpCount > SYNC_OP_LIMIT) {
          syncOpCount = 0;
          throw new Error(
            `ENOMEM: too many synchronous filesystem operations without yielding (${SYNC_OP_LIMIT}). ` +
            `Use async fs methods (fs.promises.readdir, etc.) for recursive directory traversal.`
          );
        }
        if (!syncResetScheduled) {
          syncResetScheduled = true;
          Promise.resolve().then(() => { syncOpCount = 0; syncResetScheduled = false; });
        }
      }

      // Pre-load node_modules (Shiro readdir returns string[])
      async function preloadDir(dir: string, depth = 0, maxDepth = 5) {
        if (depth > maxDepth) return;
        try {
          const entries = await ctx.fs.readdir(dir);
          // no-op: depth-0 logging removed
          for (const name of entries) {
            if (name === '.git') continue;
            // Skip node_modules inside project dirs (handled separately)
            if (name === 'node_modules' && depth > 0) continue;
            const fp = dir + '/' + name;
            try {
              const st = await ctx.fs.stat(fp);
              if (st.isDirectory()) {
                fileMtimes.set(fp, st.mtime?.getTime?.() || Date.now());
                await preloadDir(fp, depth + 1, maxDepth);
              } else if (st.size < 16777216) { // 16MB limit (for large bundled packages like claude-code)
                const content = await ctx.fs.readFile(fp, 'utf8');
                fileCache.set(fp, content as string);
                fileMtimes.set(fp, st.mtime?.getTime?.() || Date.now());
              }
            } catch { /* skip */ }
          }
        } catch (e: any) {
          if (depth === 0) console.warn(`[preload] readdir('${dir}') FAILED: ${e.message}`);
        }
      }

      // Ensure home directory and common config dirs exist
      const homeDir = ctx.env['HOME'] || '/home/user';
      // Repair corrupted directory nodes (can happen if writeFile/rename overwrites a dir)
      for (const dirPath of ['/', '/home', homeDir, '/tmp']) {
        try {
          const st = await ctx.fs.stat(dirPath);
          if (!st.isDirectory()) {
            console.warn(`[init] Repairing corrupted dir node: ${dirPath}`);
            // Force-recreate as directory by deleting the bad file node first
            try { await ctx.fs.unlink(dirPath); } catch {}
            await ctx.fs.mkdir(dirPath, { recursive: true });
          }
        } catch {
          // Doesn't exist, create it
          try { await ctx.fs.mkdir(dirPath, { recursive: true }); } catch {}
        }
      }
      try { await ctx.fs.mkdir(homeDir, { recursive: true }); } catch {}
      try { await ctx.fs.mkdir('/tmp', { recursive: true }); } catch {}

      // Replay localStorage WAL — recover config files that didn't flush to IndexedDB before page close
      try {
        const walKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('wal:')) walKeys.push(key);
        }
        let walReplayed = 0, walSkipped = 0;
        for (const key of walKeys) {
          const path = key.slice(4); // strip 'wal:' prefix
          // Skip .tmp files — they're transient atomic write artifacts
          if (path.includes('.tmp.')) {
            localStorage.removeItem(key);
            walSkipped++;
            continue;
          }
          const data = localStorage.getItem(key);
          if (data !== null) {
            // Ensure parent dir exists
            const parentDir = path.substring(0, path.lastIndexOf('/'));
            try { await ctx.fs.mkdir(parentDir, { recursive: true }); } catch {}
            await ctx.fs.writeFile(path, data);
            walReplayed++;
          }
          localStorage.removeItem(key); // Clean up after successful replay
        }
        if (walReplayed || walSkipped) {
          console.warn(`[wal] Replayed ${walReplayed} files, skipped ${walSkipped} .tmp files`);
        }
      } catch (e: any) {
        console.warn(`[wal] Replay error: ${e.message}`);
      }
      // Clean up stale .tmp files from atomic writes (they pollute readdir)
      try {
        const homeEntries = await ctx.fs.readdir(homeDir);
        let tmpCleaned = 0;
        for (const name of homeEntries) {
          if (name.includes('.tmp.')) {
            try { await ctx.fs.unlink(homeDir + '/' + name); tmpCleaned++; } catch {}
          }
        }
        if (tmpCleaned) console.warn(`[init] Cleaned ${tmpCleaned} stale .tmp files from ${homeDir}`);
      } catch {}
      try { await ctx.fs.mkdir(homeDir + '/.claude', { recursive: true }); } catch {}
      try { await ctx.fs.mkdir(homeDir + '/.claude/projects', { recursive: true }); } catch {}
      try { await ctx.fs.mkdir(homeDir + '/.claude/statsig', { recursive: true }); } catch {}
      try { await ctx.fs.mkdir(homeDir + '/.config', { recursive: true }); } catch {}
      // Create minimal Claude Code settings if not present
      try {
        await ctx.fs.stat(homeDir + '/.claude/settings.json');
      } catch {
        try { await ctx.fs.writeFile(homeDir + '/.claude/settings.json', '{}'); } catch {}
      }
      // Create empty statsig cache to prevent network calls
      try {
        await ctx.fs.stat(homeDir + '/.claude/statsig/cache.json');
      } catch {
        try { await ctx.fs.writeFile(homeDir + '/.claude/statsig/cache.json', '{}'); } catch {}
      }

      // Pre-load files from common locations
      const preloadDirs = [ctx.cwd];
      if (homeDir !== ctx.cwd) preloadDirs.push(homeDir);
      preloadDirs.push('/tmp');
      preloadDirs.push(homeDir + '/.claude');
      preloadDirs.push(homeDir + '/.config');
      // preload dirs: cwd, home, /tmp, ~/.claude, ~/.config

      for (const dir of preloadDirs) {
        await preloadDir(dir, 0, 5);
        // Ensure directory markers exist in fileCache so statSync/existsSync sees them
        // Even empty directories need to be recognized (e.g., CWD and HOME)
        try {
          const st = await ctx.fs.stat(dir);
          if (st.isDirectory()) {
            fileCache.set(dir + '/.', ''); // marker for directory existence
          }
        } catch { /* skip if dir doesn't exist */ }
      }

      // Explicitly preload critical CLI config files (safety net if preloadDir missed them)
      const criticalFiles = [
        homeDir + '/.claude.json',
        homeDir + '/.claude/.credentials.json',
        homeDir + '/.claude/.config.json',
        homeDir + '/.claude/settings.json',
        homeDir + '/.claude/settings.local.json',
      ];
      for (const fp of criticalFiles) {
        if (!fileCache.has(fp)) {
          try {
            const content = await ctx.fs.readFile(fp, 'utf8');
            fileCache.set(fp, content as string);
          } catch { /* file doesn't exist yet, that's OK */ }
        }
      }

      // Pre-flight OAuth token refresh for Claude Code CLI
      // The CLI checks expiresAt before making API calls and tries to refresh via
      // platform.claude.com — but the fetch interceptor isn't installed yet at that point,
      // so the refresh fails (CORS). We refresh here before the CLI starts.
      if (scriptPath?.includes('claude-code')) {
        const credsPath = homeDir + '/.claude/.credentials.json';
        const credsStr = fileCache.get(credsPath);
        if (credsStr) {
          try {
            const creds = JSON.parse(credsStr);
            const oauth = creds.claudeAiOauth;
            // Refresh if token expires within 5 minutes
            if (oauth?.refreshToken && oauth.expiresAt && (oauth.expiresAt - Date.now() < 300000)) {
              console.log(`[node] OAuth token expires in ${Math.round((oauth.expiresAt - Date.now()) / 1000)}s, refreshing...`);
              const proxyOrigin = typeof window !== 'undefined' ? window.location.origin : '';
              const tokenUrl = proxyOrigin + '/api/platform/v1/oauth/token';
              const body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: oauth.refreshToken,
                client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
              });
              const resp = await fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
              });
              if (resp.ok) {
                const data = await resp.json();
                oauth.accessToken = data.access_token;
                oauth.refreshToken = data.refresh_token || oauth.refreshToken;
                oauth.expiresAt = Date.now() + (data.expires_in || 28800) * 1000;
                if (data.scope) oauth.scopes = data.scope.split(' ');
                const newCredsStr = JSON.stringify(creds);
                fileCache.set(credsPath, newCredsStr);
                // Persist to filesystem so it survives page reloads
                await ctx.fs.writeFile(credsPath, newCredsStr);
                console.log(`[node] OAuth token refreshed, expires in ${data.expires_in || 28800}s`);
              } else {
                console.warn(`[node] OAuth token refresh failed: ${resp.status} ${await resp.text().catch(() => '')}`);
              }
            }
          } catch (e: any) {
            console.warn(`[node] OAuth token refresh error: ${e.message}`);
          }
        }
      }

      console.log(`[node] ${fileCache.size} files preloaded`);

      // Pre-load node_modules — walk up from cwd, with deeper recursion
      let nmSearch = ctx.cwd;
      while (nmSearch) {
        const nmDir = nmSearch === '/' ? '/node_modules' : nmSearch + '/node_modules';
        try {
          const entries = await ctx.fs.readdir(nmDir);
          for (const name of entries) {
            await preloadDir(nmDir + '/' + name, 0, 10);
          }
        } catch { /* no node_modules at this level */ }
        const parent = nmSearch.substring(0, nmSearch.lastIndexOf('/')) || '';
        if (parent === nmSearch || !parent) break;
        nmSearch = parent;
      }

      // Pre-load global node_modules (/usr/local/lib/node_modules)
      try {
        const globalNmDir = '/usr/local/lib/node_modules';
        const globalEntries = await ctx.fs.readdir(globalNmDir);
        for (const name of globalEntries) {
          await preloadDir(globalNmDir + '/' + name, 0, 10);
        }
      } catch { /* no global node_modules */ }

      // If running a script file, ensure its project directory is fully loaded
      if (scriptPath) {
        // Find project root (directory containing package.json, or script's parent dir)
        let projectRoot = scriptPath.substring(0, scriptPath.lastIndexOf('/')) || ctx.cwd;
        let searchDir = projectRoot;
        while (searchDir && searchDir !== homeDir && searchDir !== '/') {
          try {
            await ctx.fs.stat(searchDir + '/package.json');
            projectRoot = searchDir;
            break;
          } catch {
            const parentDir = searchDir.substring(0, searchDir.lastIndexOf('/')) || '';
            if (parentDir === searchDir || !parentDir) break;
            searchDir = parentDir;
          }
        }
        // Preload the entire project with deeper recursion
        await preloadDir(projectRoot, 0, 10);
      }

      // Buffer shim — must be a constructor with prototype for safe-buffer compatibility
      function FakeBuffer(arg?: any, encodingOrOffset?: any, length?: any): any {
        if (typeof arg === 'number') {
          return FakeBuffer.alloc(arg);
        }
        return FakeBuffer.from(arg, encodingOrOffset);
      }
      FakeBuffer.prototype = Object.create(Uint8Array.prototype);
      FakeBuffer.prototype.constructor = FakeBuffer;
      FakeBuffer.prototype.toString = function(encoding?: string, start?: number, end?: number) {
        const slice = (start !== undefined || end !== undefined)
          ? this.subarray(start ?? 0, end ?? this.length)
          : this;
        if (encoding === 'base64' || encoding === 'base64url') {
          let str = '';
          for (let i = 0; i < slice.length; i++) str += String.fromCharCode(slice[i]);
          const b64 = btoa(str);
          if (encoding === 'base64url') return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          return b64;
        }
        if (encoding === 'hex') {
          return Array.from(slice as Uint8Array).map((b) => b.toString(16).padStart(2, '0')).join('');
        }
        if (encoding === 'latin1' || encoding === 'binary') {
          let str = '';
          for (let i = 0; i < slice.length; i++) str += String.fromCharCode(slice[i]);
          return str;
        }
        return new TextDecoder().decode(slice);
      };
      FakeBuffer.prototype.write = function(str: string, offset?: number, length?: number, encoding?: string) {
        const bytes = new TextEncoder().encode(str);
        const off = offset ?? 0;
        const len = Math.min(length ?? bytes.length, bytes.length, this.length - off);
        for (let i = 0; i < len; i++) this[off + i] = bytes[i];
        return len;
      };
      FakeBuffer.prototype.copy = function(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number) {
        const tStart = targetStart ?? 0;
        const sStart = sourceStart ?? 0;
        const sEnd = sourceEnd ?? this.length;
        for (let i = 0; i < sEnd - sStart && tStart + i < target.length; i++) {
          target[tStart + i] = this[sStart + i];
        }
        return Math.min(sEnd - sStart, target.length - tStart);
      };
      FakeBuffer.prototype.trim = function() { return this.toString().trim(); };
      FakeBuffer.prototype.trimEnd = function() { return this.toString().trimEnd(); };
      FakeBuffer.prototype.trimStart = function() { return this.toString().trimStart(); };
      FakeBuffer.prototype.split = function(sep: any, limit?: number) { return this.toString().split(sep, limit); };
      FakeBuffer.prototype.replace = function(search: any, replacement: any) { return this.toString().replace(search, replacement); };
      FakeBuffer.prototype.startsWith = function(s: string) { return this.toString().startsWith(s); };
      FakeBuffer.prototype.endsWith = function(s: string) { return this.toString().endsWith(s); };
      FakeBuffer.prototype.includes = function(s: any) { if (typeof s === 'string') return this.toString().includes(s); return Uint8Array.prototype.includes.call(this, s); };
      FakeBuffer.prototype.equals = function(other: Uint8Array) {
        if (this.length !== other.length) return false;
        for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
        return true;
      };
      FakeBuffer.prototype.compare = function(other: Uint8Array) {
        const len = Math.min(this.length, other.length);
        for (let i = 0; i < len; i++) {
          if (this[i] < other[i]) return -1;
          if (this[i] > other[i]) return 1;
        }
        return this.length < other.length ? -1 : this.length > other.length ? 1 : 0;
      };
      FakeBuffer.prototype.readUInt8 = function(offset: number) { return this[offset]; };
      FakeBuffer.prototype.readUInt16BE = function(offset: number) { return (this[offset] << 8) | this[offset + 1]; };
      FakeBuffer.prototype.readUInt16LE = function(offset: number) { return this[offset] | (this[offset + 1] << 8); };
      FakeBuffer.prototype.readUInt32BE = function(offset: number) { return ((this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]) >>> 0; };
      FakeBuffer.prototype.readUInt32LE = function(offset: number) { return (this[offset] | (this[offset+1] << 8) | (this[offset+2] << 16) | (this[offset+3] << 24)) >>> 0; };
      FakeBuffer.prototype.readInt8 = function(offset: number) { return this[offset] > 127 ? this[offset] - 256 : this[offset]; };
      FakeBuffer.prototype.readInt16BE = function(offset: number) { const v = (this[offset] << 8) | this[offset + 1]; return v > 32767 ? v - 65536 : v; };
      FakeBuffer.prototype.readInt32BE = function(offset: number) { return (this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]; };
      FakeBuffer.prototype.writeUInt8 = function(value: number, offset: number) { this[offset] = value & 0xff; return offset + 1; };
      FakeBuffer.prototype.writeUInt16BE = function(value: number, offset: number) { this[offset] = (value >> 8) & 0xff; this[offset+1] = value & 0xff; return offset + 2; };
      FakeBuffer.prototype.writeUInt32BE = function(value: number, offset: number) { this[offset] = (value >> 24) & 0xff; this[offset+1] = (value >> 16) & 0xff; this[offset+2] = (value >> 8) & 0xff; this[offset+3] = value & 0xff; return offset + 4; };
      FakeBuffer.prototype.slice = function(start?: number, end?: number) {
        const sliced = this.subarray(start, end);
        Object.setPrototypeOf(sliced, FakeBuffer.prototype);
        return sliced;
      };
      FakeBuffer.prototype.toJSON = function() {
        return { type: 'Buffer', data: Array.from(this) };
      };
      FakeBuffer.from = (input: any, encoding?: string): any => {
        let bytes: Uint8Array;
        if (typeof input === 'string') {
          if (encoding === 'base64' || encoding === 'base64url') {
            const binary = atob(encoding === 'base64url' ? input.replace(/-/g, '+').replace(/_/g, '/') : input);
            bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          } else if (encoding === 'hex') {
            const hex = input.replace(/[^0-9a-fA-F]/g, '');
            bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
          } else if (encoding === 'latin1' || encoding === 'binary' || encoding === 'ascii') {
            bytes = new Uint8Array(input.length);
            for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i) & 0xff;
          } else {
            bytes = new TextEncoder().encode(input);
          }
        } else if (input instanceof Uint8Array) {
          bytes = new Uint8Array(input);
        } else if (Array.isArray(input)) {
          bytes = new Uint8Array(input);
        } else {
          bytes = new Uint8Array(0);
        }
        Object.setPrototypeOf(bytes, FakeBuffer.prototype);
        return bytes;
      };
      FakeBuffer.alloc = (size: number, fill?: any) => {
        const bytes = new Uint8Array(size);
        if (fill !== undefined) bytes.fill(typeof fill === 'number' ? fill : 0);
        Object.setPrototypeOf(bytes, FakeBuffer.prototype);
        return bytes;
      };
      FakeBuffer.allocUnsafe = (size: number) => FakeBuffer.alloc(size);
      FakeBuffer.allocUnsafeSlow = (size: number) => FakeBuffer.alloc(size);
      FakeBuffer.compare = (a: Uint8Array, b: Uint8Array) => {
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
          if (a[i] < b[i]) return -1;
          if (a[i] > b[i]) return 1;
        }
        return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
      };
      FakeBuffer.isBuffer = (obj: any) => obj instanceof Uint8Array;
      FakeBuffer.isEncoding = (enc: string) => ['utf8', 'utf-8', 'ascii', 'base64', 'base64url', 'hex', 'binary', 'latin1', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'].includes(enc?.toLowerCase());
      FakeBuffer.byteLength = (str: string, encoding?: string) => FakeBuffer.from(str, encoding).length;
      FakeBuffer.concat = (list: Uint8Array[], totalLength?: number) => {
        const total = totalLength ?? list.reduce((n: number, b: Uint8Array) => n + b.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const buf of list) { result.set(buf, offset); offset += buf.length; }
        Object.setPrototypeOf(result, FakeBuffer.prototype);
        return result;
      };

      // Built-in Node.js module shims (maps to Shiro VFS/shell)
      const _builtinCache = new Map<string, any>();
      function getBuiltinModule(name: string): any | null {
        // Normalize node: prefix for caching
        const cacheKey = name.startsWith('node:') ? name.slice(5) : name;
        if (_builtinCache.has(cacheKey)) return _builtinCache.get(cacheKey);
        const mod = _getBuiltinModuleImpl(name);
        if (mod !== null) _builtinCache.set(cacheKey, mod);
        return mod;
      }
      function _getBuiltinModuleImpl(name: string): any | null {
        switch (name) {
          case 'path':
          case 'node:path': {
            const pathMod: any = {
              join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
              resolve: (...parts: string[]) => {
                let p = parts.reduce((a, b) => b.startsWith('/') ? b : a + '/' + b);
                return ctx.fs.resolvePath(p, ctx.cwd);
              },
              dirname: (p: string) => p.substring(0, p.lastIndexOf('/')) || '/',
              basename: (p: string, ext?: string) => {
                const base = p.split('/').pop() || '';
                return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
              },
              extname: (p: string) => { const m = p.match(/\.[^./]+$/); return m ? m[0] : ''; },
              isAbsolute: (p: string) => p.startsWith('/'),
              normalize: (p: string) => ctx.fs.resolvePath(p, '/'),
              relative: (from: string, to: string) => {
                const f = from.split('/').filter(Boolean);
                const t = to.split('/').filter(Boolean);
                let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
                return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/') || '.';
              },
              sep: '/',
              delimiter: ':',
              parse: (p: string) => ({
                root: p.startsWith('/') ? '/' : '',
                dir: p.substring(0, p.lastIndexOf('/')),
                base: p.split('/').pop() || '',
                ext: (p.match(/\.[^./]+$/) || [''])[0],
                name: (p.split('/').pop() || '').replace(/\.[^.]+$/, ''),
              }),
              format: (obj: any) => (obj.dir ? obj.dir + '/' : '') + (obj.base || obj.name + (obj.ext || '')),
              toNamespacedPath: (p: string) => p,
            };
            pathMod.posix = pathMod;
            pathMod.win32 = pathMod;
            pathMod.default = pathMod;
            return pathMod;
          }
          case 'fs':
          case 'node:fs': {
            // Synchronous shims that use cached data or throw
            const fsShim: any = {
              readFileSync: (p: string, opts?: any) => {
                tickSyncOps();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                let cached = fileCache.get(resolved) ?? fileCache.get(resolved + '.js');
                // Fallback: check Shiro's FS in-memory cache for files created by
                // shell commands (git clone, echo, sed) that bypass nodeCmd's fileCache
                if (cached === undefined) {
                  cached = ctx.fs.readCached(resolved) ?? ctx.fs.readCached(resolved + '.js');
                  if (cached !== undefined) fileCache.set(resolved, cached); // promote to fileCache
                }
                if (cached === undefined) {
                    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
                }
                const encoding = typeof opts === 'string' ? opts : opts?.encoding;
                if (encoding === 'utf8' || encoding === 'utf-8' || encoding === 'utf8') return cached;
                if (!encoding) return FakeBuffer.from(cached);
                return cached;
              },
              writeFileSync: (p: string, data: string | Uint8Array) => {
                tickSyncOps();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const strData = typeof data === 'string' ? data : new TextDecoder().decode(data);
                fileCache.set(resolved, strData);
                fileMtimes.set(resolved, Date.now());
                // Track VFS write so it completes before script exit
                pendingPromises.push(ctx.fs.writeFile(resolved, strData).catch(() => {}));
                // localStorage WAL for critical config files (survives page close before IndexedDB flushes)
                // Skip .tmp files — they'll be WAL'd when renamed to their final name
                if ((resolved.startsWith(homeDir + '/.claude') || resolved === homeDir + '/.claude.json') && !resolved.includes('.tmp.')) {
                  try { localStorage.setItem('wal:' + resolved, strData); } catch {}
                }
              },
              existsSync: (p: string) => {
                tickSyncOps();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                if (fileCache.has(resolved) || fileCache.has(resolved + '.js') || fileCache.has(resolved + '/index.js')) return true;
                // Check for directory sentinel (from mkdirSync)
                if (fileCache.has(resolved + '/.')) return true;
                // Check if path is a directory (has files under it)
                if ([...fileCache.keys()].some(k => k.startsWith(resolved + '/'))) return true;
                // Fallback: check Shiro FS cache for files created by shell commands
                if (ctx.fs.readCached(resolved) !== undefined) return true;
                // Fallback: check Shiro FS cache for directories
                if (ctx.fs.readdirCached(resolved) !== undefined) return true;
                return false;
              },
              statSync: (p: string, opts?: any) => {
                tickSyncOps();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                let isFile = fileCache.has(resolved);
                // Fallback: check Shiro FS cache for files created by shell commands
                if (!isFile && ctx.fs.readCached(resolved) !== undefined) {
                  isFile = true;
                  fileCache.set(resolved, ctx.fs.readCached(resolved)!); // promote
                }
                let isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
                // Fallback: check Shiro FS cache for directories
                if (!isDir && ctx.fs.readdirCached(resolved) !== undefined) {
                  isDir = true;
                }
                if (!isFile && !isDir) {
                  if (opts?.throwIfNoEntry === false) return undefined;
                  throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
                }
                const mtime = new Date(fileMtimes.get(resolved) || Date.now());
                const size = isFile ? (fileCache.get(resolved) || '').length : 0;
                return {
                  isFile: () => isFile,
                  isDirectory: () => isDir && !isFile,
                  isSymbolicLink: () => false,
                  isBlockDevice: () => false,
                  isCharacterDevice: () => false,
                  isFIFO: () => false,
                  isSocket: () => false,
                  size,
                  mtime, ctime: mtime, atime: mtime, birthtime: mtime,
                  mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
                  dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
                  blksize: 4096, blocks: Math.ceil(size / 512),
                  mode: isFile ? 0o100644 : 0o40755,
                };
              },
              readdirSync: (p: string, opts?: any) => {
                tickSyncOps();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const prefix = resolved === '/' ? '/' : resolved + '/';
                const entries = new Set<string>();
                const dirSet = new Set<string>();
                for (const key of fileCache.keys()) {
                  if (key.startsWith(prefix)) {
                    const rest = key.slice(prefix.length);
                    const first = rest.split('/')[0];
                    if (first) {
                      entries.add(first);
                      if (rest.includes('/')) dirSet.add(first);
                    }
                  }
                }
                // Fallback: merge entries from Shiro FS cache (files from shell commands)
                const fsCached = ctx.fs.readdirCached(resolved);
                if (fsCached) {
                  for (const name of fsCached) {
                    entries.add(name);
                    // Detect directories from Shiro FS cache (readdirCached returns entries for dirs)
                    if (!dirSet.has(name)) {
                      const childPath = resolved === '/' ? '/' + name : resolved + '/' + name;
                      // If it has sub-entries in FS cache, it's a directory
                      if (ctx.fs.readdirCached(childPath) !== undefined) {
                        dirSet.add(name);
                      }
                      // Also check fileCache for directory sentinel
                      if (fileCache.has(childPath + '/.')) {
                        dirSet.add(name);
                      }
                    }
                  }
                }
                const sorted = [...entries].sort();
                if (opts?.withFileTypes) {
                  return sorted.map(name => ({
                    name,
                    isFile: () => !dirSet.has(name),
                    isDirectory: () => dirSet.has(name),
                    isSymbolicLink: () => false,
                    isBlockDevice: () => false,
                    isCharacterDevice: () => false,
                    isFIFO: () => false,
                    isSocket: () => false,
                  }));
                }
                return sorted;
              },
              mkdirSync: (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Mark directory in fileCache so existsSync/statSync can find it
                // Use a sentinel value to distinguish from files
                if (opts?.recursive) {
                  // Create all intermediate directories in cache
                  const parts = resolved.split('/').filter(Boolean);
                  let cur = '';
                  for (const part of parts) {
                    cur += '/' + part;
                    if (!fileCache.has(cur + '/.')) fileCache.set(cur + '/.', '');
                  }
                } else {
                  fileCache.set(resolved + '/.', '');
                }
                pendingPromises.push(ctx.fs.mkdir(resolved, opts).catch(() => {}));
              },
              unlinkSync: (p: string) => {
                ctx.fs.unlink(ctx.fs.resolvePath(p, ctx.cwd)).catch(() => {});
              },
              copyFileSync: (src: string, dst: string) => {
                const srcRes = ctx.fs.resolvePath(src, ctx.cwd);
                const dstRes = ctx.fs.resolvePath(dst, ctx.cwd);
                const cached = fileCache.get(srcRes);
                if (cached !== undefined) {
                  fileCache.set(dstRes, cached);
                  pendingPromises.push(ctx.fs.writeFile(dstRes, cached).catch(() => {}));
                } else {
                  pendingPromises.push(ctx.fs.readFile(srcRes, 'utf8').then((data: any) => ctx.fs.writeFile(dstRes, data)).catch(() => {}));
                }
              },
              renameSync: (oldP: string, newP: string) => {
                const oldRes = ctx.fs.resolvePath(oldP, ctx.cwd);
                const newRes = ctx.fs.resolvePath(newP, ctx.cwd);
                // Update fileCache: move content from old path to new path
                const content = fileCache.get(oldRes);
                if (content !== undefined) {
                  fileCache.set(newRes, content);
                  fileCache.delete(oldRes);
                  fileMtimes.set(newRes, Date.now());
                  fileMtimes.delete(oldRes);
                  // Write directly to new path — avoids race where IDB write for
                  // the source hasn't completed yet (atomic write pattern: write .tmp → rename)
                  pendingPromises.push(
                    ctx.fs.writeFile(newRes, content)
                      .then(() => ctx.fs.unlink(oldRes).catch(() => {}))
                      .catch(() => {})
                  );
                  // Update WAL: remove .tmp entry, add final file
                  if (newRes.startsWith(homeDir + '/.claude') || newRes === homeDir + '/.claude.json') {
                    try {
                      localStorage.removeItem('wal:' + oldRes);
                      localStorage.setItem('wal:' + newRes, content);
                    } catch {}
                  }
                } else {
                  // Content not in fileCache — read from Shiro FS cache or IDB will handle it
                  const fsCached = ctx.fs.readCached(oldRes);
                  if (fsCached !== undefined) {
                    fileCache.set(newRes, fsCached);
                    fileMtimes.set(newRes, Date.now());
                  }
                  pendingPromises.push(ctx.fs.rename(oldRes, newRes).catch(() => {}));
                }
              },
              realpathSync: (p: string) => {
                tickSyncOps();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Verify path exists (file or directory)
                const isFile = fileCache.has(resolved);
                const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
                if (!isFile && !isDir) throw new Error(`ENOENT: no such file or directory, realpath '${p}'`);
                return resolved;
              },
              accessSync: (p: string) => {
                tickSyncOps();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const isFile = fileCache.has(resolved);
                const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
                if (!isFile && !isDir) throw new Error(`ENOENT: no such file or directory, access '${p}'`);
              },
              lstatSync: (p: string, opts?: any) => {
                tickSyncOps();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const isFile = fileCache.has(resolved);
                const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
                if (!isFile && !isDir) {
                  if (opts?.throwIfNoEntry === false) return undefined;
                  throw new Error(`ENOENT: no such file or directory, lstat '${p}'`);
                }
                const mtime = new Date(fileMtimes.get(resolved) || Date.now());
                const size = isFile ? (fileCache.get(resolved) || '').length : 0;
                return {
                  isFile: () => isFile,
                  isDirectory: () => isDir && !isFile,
                  isSymbolicLink: () => false,
                  isBlockDevice: () => false,
                  isCharacterDevice: () => false,
                  isFIFO: () => false,
                  isSocket: () => false,
                  size,
                  mtime, ctime: mtime, atime: mtime, birthtime: mtime,
                  mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
                  dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
                  blksize: 4096, blocks: Math.ceil(size / 512),
                  mode: isFile ? 0o100644 : 0o40755,
                };
              },
              chmodSync: () => {},
              chownSync: () => {},
              // File descriptor based sync operations (minimal stubs for CLI compatibility)
              openSync: (p: string, flags?: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const fd = 100 + Math.floor(Math.random() * 9900);
                // Store mapping for writeSync/readSync/closeSync
                (globalThis as any).__shiroFds = (globalThis as any).__shiroFds || {};
                const f = flags || 'r';
                (globalThis as any).__shiroFds[fd] = { path: resolved, flags: f, offset: 0 };
                // 'w' / 'w+' / 'wx' flags truncate the file on open (POSIX behavior)
                if (f.includes('w')) {
                  fileCache.set(resolved, '');
                  fileMtimes.set(resolved, Date.now());
                }
                return fd;
              },
              writeSync: (fd: number, data: string | Uint8Array) => {
                const fdInfo = (globalThis as any).__shiroFds?.[fd];
                if (fdInfo) {
                  const existing = fileCache.get(fdInfo.path) || '';
                  const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
                  const newContent = existing + str;
                  fileCache.set(fdInfo.path, newContent);
                  fileMtimes.set(fdInfo.path, Date.now());
                  pendingPromises.push(ctx.fs.writeFile(fdInfo.path, newContent).catch(() => {}));
                }
                return typeof data === 'string' ? data.length : data.length;
              },
              readSync: (fd: number, buf: Uint8Array, offset?: number, length?: number, position?: number) => {
                const fdInfo = (globalThis as any).__shiroFds?.[fd];
                if (!fdInfo) return 0;
                const content = fileCache.get(fdInfo.path) || '';
                const bytes = new TextEncoder().encode(content);
                const pos = position ?? fdInfo.offset;
                const len = Math.min(length ?? buf.length, bytes.length - pos);
                for (let i = 0; i < len; i++) buf[(offset ?? 0) + i] = bytes[pos + i];
                fdInfo.offset = pos + len;
                return len;
              },
              closeSync: (fd: number) => {
                if ((globalThis as any).__shiroFds?.[fd]) delete (globalThis as any).__shiroFds[fd];
              },
              fsyncSync: () => {},
              fdatasyncSync: () => {},
              utimesSync: () => {},
              rmSync: (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                if (opts?.recursive) {
                  // Remove directory and all contents
                  const prefix = resolved + '/';
                  for (const key of [...fileCache.keys()]) {
                    if (key === resolved || key.startsWith(prefix)) {
                      fileCache.delete(key);
                      ctx.fs.unlink(key).catch(() => {});
                    }
                  }
                } else {
                  fileCache.delete(resolved);
                  ctx.fs.unlink(resolved).catch(() => {});
                }
              },
              rmdirSync: (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                ctx.fs.rmdir(resolved).catch(() => {});
              },
              appendFileSync: (p: string, data: string | Uint8Array) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const existing = fileCache.get(resolved) || '';
                const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
                fileCache.set(resolved, existing + str);
                pendingPromises.push(ctx.fs.writeFile(resolved, existing + str).catch(() => {}));
              },
              symlinkSync: (target: string, path: string) => {
                const resolved = ctx.fs.resolvePath(path, ctx.cwd);
                const targetResolved = ctx.fs.resolvePath(target, ctx.cwd);
                // Symlinks in VFS: just copy the target reference
                const content = fileCache.get(targetResolved);
                if (content !== undefined) fileCache.set(resolved, content);
              },
              createReadStream: (p: string, opts?: any) => {
                const s = getBuiltinModule('stream');
                const rs = new s.Readable();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const encoding = opts?.encoding || (typeof opts === 'string' ? opts : null);
                ctx.fs.readFile(resolved, encoding || 'utf8').then((data: any) => {
                  if (typeof data === 'string') {
                    rs.emit('data', encoding ? data : FakeBuffer.from(data));
                  } else {
                    rs.emit('data', data);
                  }
                  rs.emit('end');
                  rs.emit('close');
                }).catch((e: any) => {
                  rs.emit('error', e);
                });
                return rs;
              },
              createWriteStream: (p: string, _opts?: any) => {
                const s = getBuiltinModule('stream');
                const chunks: string[] = [];
                const ws = new s.Writable();
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                ws.write = function(chunk: any, enc?: any, cb?: any) {
                  const callback = typeof enc === 'function' ? enc : cb;
                  chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
                  if (callback) callback();
                  return true;
                };
                ws.end = function(chunk?: any, enc?: any, cb?: any) {
                  const callback = typeof chunk === 'function' ? chunk : typeof enc === 'function' ? enc : cb;
                  if (chunk && typeof chunk !== 'function') {
                    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
                  }
                  const content = chunks.join('');
                  fileCache.set(resolved, content);
                  fileMtimes.set(resolved, Date.now());
                  pendingPromises.push(ctx.fs.writeFile(resolved, content).then(() => {
                    ws.emit('finish');
                    ws.emit('close');
                    if (callback) callback();
                  }).catch((e: any) => ws.emit('error', e)));
                };
                return ws;
              },
              constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
              // Callback-style async fs methods (used by graceful-fs, fs-extra)
              readFile: (p: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache first — sync writes may have updated it
                const cached = fileCache.get(resolved);
                if (cached !== undefined) {
                  // Use queueMicrotask for consistent async behavior
                  queueMicrotask(() => callback?.(null, cached));
                  return;
                }
                ctx.fs.readFile(resolved, 'utf8')
                  .then((data: any) => callback?.(null, data))
                  .catch((e: any) => callback?.(e));
              },
              writeFile: (p: string, data: any, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const strData = typeof data === 'string' ? data : new TextDecoder().decode(data);
                // Update fileCache so subsequent sync reads see the new data
                fileCache.set(resolved, strData);
                fileMtimes.set(resolved, Date.now());
                pendingPromises.push(ctx.fs.writeFile(resolved, strData).catch(() => {}));
                queueMicrotask(() => callback?.(null));
              },
              stat: (p: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache first (matches statSync behavior) — avoids IDB round-trip
                const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
                const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
                if (isFile || isDir) {
                  const mtime = new Date(fileMtimes.get(resolved) || Date.now());
                  const size = isFile ? (fileCache.get(resolved) || '').length : 0;
                  queueMicrotask(() => callback?.(null, {
                    isFile: () => isFile && !isDir, isDirectory: () => isDir,
                    isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
                    size, mtime, ctime: mtime, atime: mtime, birthtime: mtime,
                    mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
                    dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512),
                    mode: (isDir) ? 0o40755 : 0o100644,
                  }));
                  return;
                }
                ctx.fs.stat(resolved)
                  .then((s: any) => callback?.(null, s))
                  .catch((e: any) => callback?.(e));
              },
              lstat: (p: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache first (same as stat — no real symlinks in Shiro)
                const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
                const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
                if (isFile || isDir) {
                  const mtime = new Date(fileMtimes.get(resolved) || Date.now());
                  const size = isFile ? (fileCache.get(resolved) || '').length : 0;
                  queueMicrotask(() => callback?.(null, {
                    isFile: () => isFile && !isDir, isDirectory: () => isDir,
                    isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
                    size, mtime, ctime: mtime, atime: mtime, birthtime: mtime,
                    mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
                    dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512),
                    mode: (isDir) ? 0o40755 : 0o100644,
                  }));
                  return;
                }
                ctx.fs.stat(resolved)
                  .then((s: any) => callback?.(null, s))
                  .catch((e: any) => callback?.(e));
              },
              readdir: (p: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                const opts = typeof optsOrCb === 'object' ? optsOrCb : {};
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache first (matches readdirSync behavior)
                const prefix = resolved === '/' ? '/' : resolved + '/';
                const cacheEntries = new Set<string>();
                const cacheDirSet = new Set<string>();
                for (const key of fileCache.keys()) {
                  if (key.startsWith(prefix)) {
                    const rest = key.slice(prefix.length);
                    const first = rest.split('/')[0];
                    if (first && first !== '.') {
                      cacheEntries.add(first);
                      if (rest.includes('/')) cacheDirSet.add(first);
                    }
                  }
                }
                // Also check Shiro FS cache
                const fsCachedEntries = ctx.fs.readdirCached(resolved);
                if (fsCachedEntries) {
                  for (const e of fsCachedEntries) cacheEntries.add(e);
                }
                if (cacheEntries.size > 0) {
                  const entries = [...cacheEntries].sort();
                  if (opts?.withFileTypes) {
                    const dirents = entries.map(name => {
                      const childPath = resolved + '/' + name;
                      const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || ctx.fs.readdirCached(childPath) !== undefined;
                      return { name, isFile: () => !childIsDir, isDirectory: () => childIsDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };
                    });
                    queueMicrotask(() => callback?.(null, dirents));
                  } else {
                    queueMicrotask(() => callback?.(null, entries));
                  }
                  return;
                }
                ctx.fs.readdir(resolved)
                  .then(async (entries: any) => {
                    if (opts?.withFileTypes) {
                      const dirents = [];
                      for (const name of entries) {
                        try {
                          const st = await ctx.fs.stat(resolved + '/' + name);
                          dirents.push({ name, isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink?.() || false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false });
                        } catch { dirents.push({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false }); }
                      }
                      callback?.(null, dirents);
                    } else { callback?.(null, entries); }
                  })
                  .catch((e: any) => callback?.(e));
              },
              mkdir: (p: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                ctx.fs.mkdir(ctx.fs.resolvePath(p, ctx.cwd), typeof optsOrCb === 'object' ? optsOrCb : undefined)
                  .then(() => callback?.(null))
                  .catch((e: any) => callback?.(e));
              },
              unlink: (p: string, cb?: any) => {
                ctx.fs.unlink(ctx.fs.resolvePath(p, ctx.cwd))
                  .then(() => cb?.(null))
                  .catch((e: any) => cb?.(e));
              },
              rmdir: (p: string, cb?: any) => {
                ctx.fs.unlink(ctx.fs.resolvePath(p, ctx.cwd))
                  .then(() => cb?.(null))
                  .catch((e: any) => cb?.(e));
              },
              rename: (oldP: string, newP: string, cb?: any) => {
                ctx.fs.rename(ctx.fs.resolvePath(oldP, ctx.cwd), ctx.fs.resolvePath(newP, ctx.cwd))
                  .then(() => cb?.(null))
                  .catch((e: any) => cb?.(e));
              },
              access: (p: string, modeOrCb?: any, cb?: any) => {
                const callback = typeof modeOrCb === 'function' ? modeOrCb : cb;
                ctx.fs.exists(ctx.fs.resolvePath(p, ctx.cwd))
                  .then((exists: boolean) => exists ? callback?.(null) : callback?.(new Error(`ENOENT: no such file or directory, access '${p}'`)))
                  .catch((e: any) => callback?.(e));
              },
              chmod: (_p: string, _m: any, cb?: any) => { cb?.(null); },
              chown: (_p: string, _u: any, _g: any, cb?: any) => { cb?.(null); },
              link: (src: string, dst: string, cb?: any) => {
                ctx.fs.symlink(ctx.fs.resolvePath(src, ctx.cwd), ctx.fs.resolvePath(dst, ctx.cwd))
                  .then(() => cb?.(null))
                  .catch((e: any) => cb?.(e));
              },
              symlink: (target: string, path: string, typeOrCb?: any, cb?: any) => {
                const callback = typeof typeOrCb === 'function' ? typeOrCb : cb;
                ctx.fs.symlink(ctx.fs.resolvePath(target, ctx.cwd), ctx.fs.resolvePath(path, ctx.cwd))
                  .then(() => callback?.(null))
                  .catch((e: any) => callback?.(e));
              },
              readlink: (p: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                callback?.(null, ctx.fs.resolvePath(p, ctx.cwd));
              },
              close: (_fd: number, cb?: any) => { cb?.(null); },
              open: (p: string, flags: any, modeOrCb?: any, cb?: any) => {
                const callback = typeof modeOrCb === 'function' ? modeOrCb : cb;
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const fd = 100 + Math.floor(Math.random() * 9900);
                (globalThis as any).__shiroFds = (globalThis as any).__shiroFds || {};
                const f = typeof flags === 'string' ? flags : 'r';
                (globalThis as any).__shiroFds[fd] = { path: resolved, flags: f, offset: 0 };
                if (f.includes('w')) {
                  fileCache.set(resolved, '');
                  fileMtimes.set(resolved, Date.now());
                }
                callback?.(null, fd);
              },
              read: (fd: number, buf: any, off: number, len: number, pos: any, cb?: any) => {
                const fdInfo = (globalThis as any).__shiroFds?.[fd];
                if (!fdInfo) { cb?.(null, 0, buf); return; }
                const content = fileCache.get(fdInfo.path) || '';
                const bytes = new TextEncoder().encode(content);
                const p2 = pos ?? fdInfo.offset;
                const n = Math.min(len, bytes.length - p2);
                for (let i = 0; i < n; i++) buf[(off ?? 0) + i] = bytes[p2 + i];
                fdInfo.offset = p2 + n;
                cb?.(null, n, buf);
              },
              write: (fd: number, buf: any, off: number, len: number, pos: any, cb?: any) => {
                const fdInfo = (globalThis as any).__shiroFds?.[fd];
                if (fdInfo) {
                  const existing = fileCache.get(fdInfo.path) || '';
                  const str = typeof buf === 'string' ? buf : new TextDecoder().decode(buf instanceof Uint8Array ? buf.slice(off, off + len) : buf);
                  const newContent = existing + str;
                  fileCache.set(fdInfo.path, newContent);
                  fileMtimes.set(fdInfo.path, Date.now());
                  pendingPromises.push(ctx.fs.writeFile(fdInfo.path, newContent).catch(() => {}));
                }
                cb?.(null, len, buf);
              },
              copyFile: (src: string, dst: string, flagsOrCb?: any, cb?: any) => {
                const callback = typeof flagsOrCb === 'function' ? flagsOrCb : cb;
                ctx.fs.readFile(ctx.fs.resolvePath(src, ctx.cwd), 'utf8')
                  .then((data: any) => ctx.fs.writeFile(ctx.fs.resolvePath(dst, ctx.cwd), data))
                  .then(() => callback?.(null))
                  .catch((e: any) => callback?.(e));
              },
              appendFile: (p: string, data: any, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                ctx.fs.readFile(resolved, 'utf8').catch(() => '')
                  .then((existing: any) => ctx.fs.writeFile(resolved, (existing || '') + data))
                  .then(() => callback?.(null))
                  .catch((e: any) => callback?.(e));
              },
              truncate: (p: string, lenOrCb?: any, cb?: any) => {
                const callback = typeof lenOrCb === 'function' ? lenOrCb : cb;
                ctx.fs.writeFile(ctx.fs.resolvePath(p, ctx.cwd), '')
                  .then(() => callback?.(null))
                  .catch((e: any) => callback?.(e));
              },
              utimes: (_p: string, _a: any, _m: any, cb?: any) => { cb?.(null); },
              futimes: (_fd: number, _a: any, _m: any, cb?: any) => { cb?.(null); },
              fstat: (_fd: number, cb?: any) => { cb?.(null, { isFile: () => true, isDirectory: () => false, size: 0, mtime: new Date() }); },
              fsync: (_fd: number, cb?: any) => { cb?.(null); },
              fdatasync: (_fd: number, cb?: any) => { cb?.(null); },
              fchmod: (_fd: number, _m: any, cb?: any) => { cb?.(null); },
              fchown: (_fd: number, _u: any, _g: any, cb?: any) => { cb?.(null); },
              ftruncate: (fd: number, lenOrCb?: any, cb?: any) => {
                const callback = typeof lenOrCb === 'function' ? lenOrCb : cb;
                const fdInfo = (globalThis as any).__shiroFds?.[fd];
                if (fdInfo) {
                  const len = typeof lenOrCb === 'number' ? lenOrCb : 0;
                  const existing = fileCache.get(fdInfo.path) || '';
                  const truncated = existing.slice(0, len);
                  fileCache.set(fdInfo.path, truncated);
                  pendingPromises.push(ctx.fs.writeFile(fdInfo.path, truncated).catch(() => {}));
                }
                callback?.(null);
              },
              lchmod: (_p: string, _m: any, cb?: any) => { cb?.(null); },
              lchown: (_p: string, _u: any, _g: any, cb?: any) => { cb?.(null); },
              mkdtemp: (prefix: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                const dir = `${prefix}${Math.random().toString(36).slice(2)}`;
                ctx.fs.mkdir(dir, { recursive: true }).then(() => callback?.(null, dir)).catch((e: any) => callback?.(e));
              },
              rm: (p: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                ctx.fs.unlink(ctx.fs.resolvePath(p, ctx.cwd))
                  .then(() => callback?.(null))
                  .catch((e: any) => callback?.(e));
              },
              opendir: (p: string, optsOrCb?: any, cb?: any) => {
                const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
                callback?.(null, { read: (readCb: any) => { readCb(null, null); }, close: (closeCb: any) => { closeCb?.(null); } });
              },
              exists: (p: string, cb?: any) => {
                ctx.fs.exists(ctx.fs.resolvePath(p, ctx.cwd))
                  .then((exists: boolean) => cb?.(exists))
                  .catch(() => cb?.(false));
              },
              watch: (_p: string, _opts?: any, _listener?: any) => {
                const watcher: any = { close: () => {}, on: () => watcher, once: () => watcher, ref: () => watcher, unref: () => watcher };
                return watcher;
              },
              watchFile: (_p: string, _opts?: any, _listener?: any) => {},
              unwatchFile: (_p: string, _listener?: any) => {},
              // Async promises API
              promises: {
                readFile: async (p: string, opts?: any) => {
                  const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                  const encoding = typeof opts === 'string' ? opts : opts?.encoding;
                  // Check fileCache first (may have data from writeFileSync not yet flushed)
                  const cached = fileCache.get(resolved);
                  if (cached !== undefined) {
                    if (encoding === 'utf8' || encoding === 'utf-8') return cached;
                    return FakeBuffer.from(cached);
                  }
                  return await ctx.fs.readFile(resolved, encoding || 'utf8');
                },
                writeFile: async (p: string, data: any) => {
                  const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                  const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
                  fileCache.set(resolved, content); // Keep fileCache in sync for readFileSync/renameSync
                  fileMtimes.set(resolved, Date.now());
                  await ctx.fs.writeFile(resolved, content);
                },
                readdir: async (p: string, opts?: any) => {
                  const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                  // Merge fileCache + Shiro FS cache + IDB entries
                  const prefix = resolved === '/' ? '/' : resolved + '/';
                  const cacheEntries = new Set<string>();
                  const cacheDirSet = new Set<string>();
                  for (const key of fileCache.keys()) {
                    if (key.startsWith(prefix)) {
                      const rest = key.slice(prefix.length);
                      const first = rest.split('/')[0];
                      if (first && first !== '.') { cacheEntries.add(first); if (rest.includes('/')) cacheDirSet.add(first); }
                    }
                  }
                  const fsCached = ctx.fs.readdirCached(resolved);
                  if (fsCached) for (const e of fsCached) cacheEntries.add(e);
                  try { const idb = await ctx.fs.readdir(resolved); for (const e of idb) cacheEntries.add(e); } catch {}
                  const entries = [...cacheEntries].sort();
                  if (opts?.withFileTypes) {
                    return entries.map(name => {
                      const childPath = resolved + '/' + name;
                      const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || [...fileCache.keys()].some(k => k.startsWith(childPath + '/')) || ctx.fs.readdirCached(childPath) !== undefined;
                      return { name, isFile: () => !childIsDir, isDirectory: () => childIsDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };
                    });
                  }
                  return entries;
                },
                stat: async (p: string) => {
                  const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                  const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
                  const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
                  if (isFile || isDir) {
                    const mtime = new Date(fileMtimes.get(resolved) || Date.now());
                    const size = isFile ? (fileCache.get(resolved) || '').length : 0;
                    return { isFile: () => isFile && !isDir, isDirectory: () => isDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, size, mtime, ctime: mtime, atime: mtime, birthtime: mtime, mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(), dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512), mode: isDir ? 0o40755 : 0o100644 };
                  }
                  return ctx.fs.stat(resolved);
                },
                mkdir: async (p: string, opts?: any) => ctx.fs.mkdir(ctx.fs.resolvePath(p, ctx.cwd), opts),
                unlink: async (p: string) => ctx.fs.unlink(ctx.fs.resolvePath(p, ctx.cwd)),
                access: async (p: string) => {
                  const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                  if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readCached(resolved) !== undefined || ctx.fs.readdirCached(resolved) !== undefined) return;
                  const exists = await ctx.fs.exists(resolved);
                  if (!exists) throw new Error(`ENOENT: no such file or directory, access '${p}'`);
                },
              },
            };
            // realpath and realpath.native need special handling (function with properties)
            const realpathFn: any = (p: string, optsOrCb?: any, cb?: any) => {
              const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
              const resolved = ctx.fs.resolvePath(p, ctx.cwd);
              callback?.(null, resolved);
            };
            realpathFn.native = (p: string, optsOrCb?: any, cb?: any) => {
              const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
              const resolved = ctx.fs.resolvePath(p, ctx.cwd);
              callback?.(null, resolved);
            };
            fsShim.realpath = realpathFn;
            // Also add realpathSync.native
            const origRealpathSync = fsShim.realpathSync;
            origRealpathSync.native = origRealpathSync;
            return fsShim;
          }
          case 'fs/promises':
          case 'node:fs/promises': {
            // Async fs promises API
            return {
              readFile: async (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache first (may have data from writeFileSync not yet flushed)
                const cached = fileCache.get(resolved);
                const encoding = typeof opts === 'string' ? opts : opts?.encoding;
                if (cached !== undefined) {
                  if (encoding === 'utf8' || encoding === 'utf-8') return cached;
                  return FakeBuffer.from(cached);
                }
                const data = await ctx.fs.readFile(resolved);
                if (encoding === 'utf8' || encoding === 'utf-8') {
                  return typeof data === 'string' ? data : new TextDecoder().decode(data);
                }
                return typeof data === 'string' ? FakeBuffer.from(data) : FakeBuffer.from(data);
              },
              writeFile: async (p: string, data: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
                fileCache.set(resolved, content); // Keep fileCache in sync for readFileSync
                await ctx.fs.writeFile(resolved, content);
                // localStorage WAL for critical config files
                if (resolved.startsWith(homeDir + '/.claude') || resolved === homeDir + '/.claude.json') {
                  try { localStorage.setItem('wal:' + resolved, content); } catch {}
                }
              },
              readdir: async (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache first (matches readdirSync)
                const prefix = resolved === '/' ? '/' : resolved + '/';
                const cacheEntries = new Set<string>();
                const cacheDirSet = new Set<string>();
                for (const key of fileCache.keys()) {
                  if (key.startsWith(prefix)) {
                    const rest = key.slice(prefix.length);
                    const first = rest.split('/')[0];
                    if (first && first !== '.') {
                      cacheEntries.add(first);
                      if (rest.includes('/')) cacheDirSet.add(first);
                    }
                  }
                }
                const fsCachedEntries = ctx.fs.readdirCached(resolved);
                if (fsCachedEntries) for (const e of fsCachedEntries) cacheEntries.add(e);
                // Also merge IDB entries
                try {
                  const idbEntries = await ctx.fs.readdir(resolved);
                  for (const e of idbEntries) cacheEntries.add(e);
                } catch {}
                const entries = [...cacheEntries].sort();
                if (opts?.withFileTypes) {
                  const dirents = entries.map(name => {
                    const childPath = resolved + '/' + name;
                    const childIsDir = cacheDirSet.has(name) || fileCache.has(childPath + '/.') || [...fileCache.keys()].some(k => k.startsWith(childPath + '/')) || ctx.fs.readdirCached(childPath) !== undefined;
                    return { name, isFile: () => !childIsDir, isDirectory: () => childIsDir, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, parentPath: resolved, path: resolved };
                  });
                  return dirents;
                }
                return entries;
              },
              stat: async (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache first (matches statSync behavior)
                const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
                const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
                if (isFile || isDir) {
                  const mtime = new Date(fileMtimes.get(resolved) || Date.now());
                  const size = isFile ? (fileCache.get(resolved) || '').length : 0;
                  return {
                    isFile: () => isFile && !isDir, isDirectory: () => isDir,
                    isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
                    size, mtime, ctime: mtime, atime: mtime, birthtime: mtime,
                    mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
                    dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512),
                    mode: isDir ? 0o40755 : 0o100644,
                  };
                }
                return await ctx.fs.stat(resolved);
              },
              mkdir: async (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                await ctx.fs.mkdir(resolved, opts);
              },
              unlink: async (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                await ctx.fs.unlink(resolved);
              },
              rm: async (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                await ctx.fs.unlink(resolved);
              },
              access: async (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache/dirs before going to IDB
                if (fileCache.has(resolved) || fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readCached(resolved) !== undefined || ctx.fs.readdirCached(resolved) !== undefined) return;
                const exists = await ctx.fs.exists(resolved);
                if (!exists) throw new Error(`ENOENT: no such file or directory, access '${p}'`);
              },
              lstat: async (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check fileCache first (same as stat)
                const isFile = fileCache.has(resolved) || ctx.fs.readCached(resolved) !== undefined;
                const isDir = fileCache.has(resolved + '/.') || [...fileCache.keys()].some(k => k.startsWith(resolved + '/')) || ctx.fs.readdirCached(resolved) !== undefined;
                if (isFile || isDir) {
                  const mtime = new Date(fileMtimes.get(resolved) || Date.now());
                  const size = isFile ? (fileCache.get(resolved) || '').length : 0;
                  return {
                    isFile: () => isFile && !isDir, isDirectory: () => isDir,
                    isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
                    size, mtime, ctime: mtime, atime: mtime, birthtime: mtime,
                    mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), atimeMs: mtime.getTime(), birthtimeMs: mtime.getTime(),
                    dev: 0, ino: 0, nlink: 1, uid: 1000, gid: 1000, rdev: 0, blksize: 4096, blocks: Math.ceil(size / 512),
                    mode: isDir ? 0o40755 : 0o100644,
                  };
                }
                return await ctx.fs.stat(resolved);
              },
              chmod: async () => {},
              rename: async (oldP: string, newP: string) => {
                const oldRes = ctx.fs.resolvePath(oldP, ctx.cwd);
                const newRes = ctx.fs.resolvePath(newP, ctx.cwd);
                // Update fileCache so subsequent sync reads see the moved content
                const content = fileCache.get(oldRes);
                if (content !== undefined) {
                  fileCache.set(newRes, content);
                  fileCache.delete(oldRes);
                  fileMtimes.set(newRes, Date.now());
                  fileMtimes.delete(oldRes);
                }
                await ctx.fs.rename(oldRes, newRes);
              },
              copyFile: async (src: string, dst: string) => {
                const data = await ctx.fs.readFile(ctx.fs.resolvePath(src, ctx.cwd));
                const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
                await ctx.fs.writeFile(ctx.fs.resolvePath(dst, ctx.cwd), content);
              },
              appendFile: async (p: string, data: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                let existing = '';
                try { const d = await ctx.fs.readFile(resolved); existing = typeof d === 'string' ? d : new TextDecoder().decode(d); } catch {}
                const append = typeof data === 'string' ? data : new TextDecoder().decode(data);
                await ctx.fs.writeFile(resolved, existing + append);
              },
              symlink: async (target: string, path: string) => {
                await ctx.fs.symlink(ctx.fs.resolvePath(target, ctx.cwd), ctx.fs.resolvePath(path, ctx.cwd));
              },
              readlink: async (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                return await ctx.fs.readlink(resolved);
              },
              realpath: async (p: string) => {
                return ctx.fs.resolvePath(p, ctx.cwd);
              },
              rmdir: async (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                await ctx.fs.unlink(resolved);
              },
              utimes: async () => {},
              mkdtemp: async (prefix: string) => {
                const dir = `${prefix}${Math.random().toString(36).slice(2)}`;
                await ctx.fs.mkdir(dir, { recursive: true });
                return dir;
              },
              open: async (p: string, _flags?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                return {
                  fd: 0,
                  readFile: async (opts?: any) => {
                    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
                    // Check fileCache first (consistent with readFileSync)
                    const cached = fileCache.get(resolved);
                    if (cached !== undefined) {
                      if (!encoding || encoding === 'utf8' || encoding === 'utf-8') return cached;
                      return FakeBuffer.from(cached);
                    }
                    return ctx.fs.readFile(resolved, encoding || 'utf8');
                  },
                  writeFile: async (data: any) => {
                    const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
                    fileCache.set(resolved, content); // Keep fileCache in sync for readFileSync/renameSync
                    await ctx.fs.writeFile(resolved, content);
                  },
                  close: async () => {},
                  stat: async () => ctx.fs.stat(resolved),
                  chmod: async () => {},
                };
              },
              watch: async function*(_p: string, _opts?: any) { /* no-op async generator */ },
              constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
            };
          }
          case 'child_process':
          case 'node:child_process': {
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
              // echo
              if (/^echo\s/.test(trimmed) || trimmed === 'echo') {
                const echoArg = trimmed === 'echo' ? '' : trimmed.slice(5);
                // Expand env vars in echo args
                const expanded = echoArg.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, k: string) => ctx.env[k] || '');
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
                // rg --files → find (rg --files is a file listing mode, not search)
                if (rgArgs.match(/--files\b/)) {
                  const rest = rgArgs.replace(/--files\s*/g, '').replace(/--hidden\s*/g, '').replace(/--glob\s+\S+\s*/g, '').trim();
                  const dir = rest || '.';
                  normalized = `find ${dir} -type f`;
                } else {
                  // Pass through to Shiro's builtin rg command (preserves all flags)
                  normalized = `rg ${rgArgs}`;
                }
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

              return { stdout, stderr, exitCode };
            };
            const cpModule: any = {
              execSync: (cmd: string, opts?: any) => {
                // In browser, execSync cannot truly block. We return a placeholder
                // Buffer and queue the actual execution. Works correctly when the
                // result is used at top-level of an async script (node -e).
                // Synchronous fast-path for detection commands
                const syncResponse = getSyncResponse(cmd);
                if (syncResponse) {
                  const wantStr = opts?.encoding && opts.encoding !== 'buffer';
                  if (wantStr) return syncResponse.stdout;
                  const buf: any = FakeBuffer.from(syncResponse.stdout);
                  buf.then = (resolve: any) => resolve(FakeBuffer.from(syncResponse.stdout));
                  return buf;
                }
                let result = '';
                const wantString = opts?.encoding && opts.encoding !== 'buffer';
                const p = execAsync(cmd).then(r => { result = r.stdout; });
                if (wantString) {
                  // Return a string-like thenable (has .split, .trim, etc.)
                  const str: any = new String('');
                  str.then = (resolve: any, reject: any) => p.then(() => resolve(result)).catch(reject);
                  // Proxy to make property access return from resolved result
                  return new Proxy(str, {
                    get(target, prop) {
                      if (prop === 'then') return str.then;
                      // Delegate to the result string once resolved
                      const val = (result as any)[prop];
                      if (typeof val === 'function') return val.bind(result);
                      return val;
                    },
                  });
                }
                // Create a thenable Buffer-like that resolves when awaited
                const buf: any = {
                  toString: () => result,
                  then: (resolve: any, reject: any) => p.then(() => resolve(FakeBuffer.from(result))).catch(reject),
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
                    error: undefined as any,
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
          case 'os':
          case 'node:os': return {
            platform: () => 'linux',
            arch: () => 'x64',
            homedir: () => ctx.env['HOME'] || '/home/user',
            tmpdir: () => '/tmp',
            hostname: () => 'shiro',
            type: () => 'Shiro',
            release: () => '0.1.0',
            cpus: () => {
              const count = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
              const cpu = { model: 'Browser vCPU', speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } };
              return Array.from({ length: count }, () => ({ ...cpu }));
            },
            totalmem: () => 0,
            freemem: () => 0,
            EOL: '\n',
            userInfo: () => ({ username: 'user', homedir: ctx.env['HOME'] || '/home/user', shell: '/bin/sh', uid: 1000, gid: 1000 }),
            networkInterfaces: () => ({}),
            endianness: () => 'LE',
            loadavg: () => [0, 0, 0],
            uptime: () => performance.now() / 1000,
            machine: () => 'x86_64',
            availableParallelism: () => (navigator?.hardwareConcurrency || 4),
            version: () => 'Shiro 0.1.0',
            devNull: '/dev/null',
            constants: {
              signals: {
                SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
                SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
                SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19,
                SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25,
                SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGINFO: 29, SIGSYS: 31,
              },
              errno: {},
              priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
            },
          };
          case 'util':
          case 'node:util': {
            const _inspect = (obj: any, opts?: any): string => {
              if (obj === null) return 'null';
              if (obj === undefined) return 'undefined';
              if (typeof obj === 'string') return opts?.stylize ? opts.stylize(`'${obj}'`, 'string') : `'${obj}'`;
              if (typeof obj === 'number' || typeof obj === 'boolean' || typeof obj === 'bigint') return String(obj);
              if (typeof obj === 'function') return `[Function: ${obj.name || 'anonymous'}]`;
              if (typeof obj === 'symbol') return obj.toString();
              if (obj instanceof Date) return obj.toISOString();
              if (obj instanceof RegExp) return obj.toString();
              if (obj instanceof Error) return `${obj.name}: ${obj.message}`;
              if (ArrayBuffer.isView(obj)) return `<Buffer ${Array.from(obj as Uint8Array).slice(0, 50).map(b => b.toString(16).padStart(2, '0')).join(' ')}${(obj as Uint8Array).length > 50 ? ' ...' : ''}>`;
              try { return JSON.stringify(obj, null, 2); } catch { return '[Circular]'; }
            };
            _inspect.custom = Symbol.for('nodejs.util.inspect.custom');
            _inspect.styles = {};
            _inspect.colors = {};
            _inspect.defaultOptions = { depth: 2, colors: false };
            const _format = (fmt: any, ...args: any[]): string => {
              if (typeof fmt !== 'string') return [fmt, ...args].map(a => typeof a === 'object' ? _inspect(a) : String(a)).join(' ');
              let i = 0;
              const str = fmt.replace(/%[sdjifoO%]/g, (m: string) => {
                if (m === '%%') return '%';
                if (i >= args.length) return m;
                const a = args[i++];
                switch (m) {
                  case '%s': return String(a);
                  case '%d': case '%i': return parseInt(a, 10).toString();
                  case '%f': return parseFloat(a).toString();
                  case '%j': try { return JSON.stringify(a); } catch { return '[Circular]'; }
                  case '%o': case '%O': return _inspect(a);
                  default: return m;
                }
              });
              const rest = args.slice(i).map(a => typeof a === 'object' ? _inspect(a) : String(a));
              return rest.length ? str + ' ' + rest.join(' ') : str;
            };
            return {
            promisify: (fn: any) => {
              // Check for custom promisify implementation (e.g., child_process.exec)
              const customSym = Symbol.for('nodejs.util.promisify.custom');
              if (fn[customSym]) return fn[customSym];
              return (...args: any[]) => new Promise((resolve, reject) => {
                fn(...args, (err: any, result: any) => err ? reject(err) : resolve(result));
              });
            },
            callbackify: (fn: Function) => (...args: any[]) => {
              const cb = args.pop();
              fn(...args).then((r: any) => cb(null, r)).catch((e: any) => cb(e));
            },
            inspect: _inspect,
            format: _format,
            types: {
              isDate: (v: any) => v instanceof Date,
              isRegExp: (v: any) => v instanceof RegExp,
              isCryptoKey: (key: any) => typeof CryptoKey !== 'undefined' && key instanceof CryptoKey,
              isTypedArray: (v: any) => ArrayBuffer.isView(v) && !(v instanceof DataView),
              isNativeError: (v: any) => v instanceof Error,
              isPromise: (v: any) => v instanceof Promise,
              isProxy: (_v: any) => false,
              isAnyArrayBuffer: (v: any) => v instanceof ArrayBuffer || v instanceof SharedArrayBuffer,
              isArrayBuffer: (v: any) => v instanceof ArrayBuffer,
              isSharedArrayBuffer: (v: any) => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer,
              isDataView: (v: any) => v instanceof DataView,
              isMap: (v: any) => v instanceof Map,
              isSet: (v: any) => v instanceof Set,
              isWeakMap: (v: any) => v instanceof WeakMap,
              isWeakSet: (v: any) => v instanceof WeakSet,
              isUint8Array: (v: any) => v instanceof Uint8Array,
              isUint16Array: (v: any) => v instanceof Uint16Array,
              isUint32Array: (v: any) => v instanceof Uint32Array,
              isInt8Array: (v: any) => v instanceof Int8Array,
              isInt16Array: (v: any) => v instanceof Int16Array,
              isInt32Array: (v: any) => v instanceof Int32Array,
              isFloat32Array: (v: any) => v instanceof Float32Array,
              isFloat64Array: (v: any) => v instanceof Float64Array,
              isBigInt64Array: (v: any) => typeof BigInt64Array !== 'undefined' && v instanceof BigInt64Array,
              isBigUint64Array: (v: any) => typeof BigUint64Array !== 'undefined' && v instanceof BigUint64Array,
              isGeneratorFunction: (v: any) => v?.constructor?.name === 'GeneratorFunction',
              isAsyncFunction: (v: any) => v?.constructor?.name === 'AsyncFunction',
              isStringObject: (v: any) => typeof v === 'object' && v instanceof String,
              isNumberObject: (v: any) => typeof v === 'object' && v instanceof Number,
              isBooleanObject: (v: any) => typeof v === 'object' && v instanceof Boolean,
              isSymbolObject: (v: any) => typeof v === 'object' && Object.prototype.toString.call(v) === '[object Symbol]',
            },
            deprecate: (fn: Function, _msg: string) => fn, // Return function unchanged, skip warning
            inherits: (ctor: any, superCtor: any) => {
              if (superCtor && superCtor.prototype) {
                ctor.super_ = superCtor;
                ctor.prototype = Object.create(superCtor.prototype, {
                  constructor: { value: ctor, writable: true, configurable: true }
                });
              }
            },
            isArray: Array.isArray,
            isBuffer: (obj: any) => obj instanceof Uint8Array,
            isString: (obj: any) => typeof obj === 'string',
            isNumber: (obj: any) => typeof obj === 'number',
            isBoolean: (obj: any) => typeof obj === 'boolean',
            isObject: (obj: any) => obj !== null && typeof obj === 'object',
            isFunction: (obj: any) => typeof obj === 'function',
            isNull: (obj: any) => obj === null,
            isUndefined: (obj: any) => obj === undefined,
            isNullOrUndefined: (obj: any) => obj == null,
            isPrimitive: (obj: any) => obj === null || (typeof obj !== 'object' && typeof obj !== 'function'),
            isDeepStrictEqual: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b),
            debuglog: (_section: string) => Object.assign((..._args: any[]) => {}, { enabled: false }),
            debug: (_section: string) => Object.assign((..._args: any[]) => {}, { enabled: false }),
            getSystemErrorName: (err: number) => `ERRNO_${err}`,
            toUSVString: (s: string) => s,
            stripVTControlCharacters: (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g, ''),
            styleText: (_style: string, text: string) => text,
            TextEncoder,
            TextDecoder,
          };
          }
          case 'events':
          case 'node:events': {
            class EventEmitter {
              _events: Record<string, Function[]> = {};
              _maxListeners: number = 10;
              on(event: string, fn: Function) { (this._events[event] ??= []).push(fn); return this; }
              addListener(event: string, fn: Function) { return this.on(event, fn); }
              off(event: string, fn: Function) { this._events[event] = (this._events[event] || []).filter(f => f !== fn); return this; }
              removeListener(event: string, fn: Function) { return this.off(event, fn); }
              emit(event: string, ...args: any[]) { (this._events[event] || []).forEach(fn => fn(...args)); return true; }
              once(event: string, fn: Function) {
                const wrapper = (...args: any[]) => { this.off(event, wrapper); fn(...args); };
                return this.on(event, wrapper);
              }
              prependListener(event: string, fn: Function) { (this._events[event] ??= []).unshift(fn); return this; }
              removeAllListeners(event?: string) { if (event) delete this._events[event]; else this._events = {}; return this; }
              listeners(event: string) { return [...(this._events[event] || [])]; }
              rawListeners(event: string) { return [...(this._events[event] || [])]; }
              listenerCount(event: string) { return (this._events[event] || []).length; }
              eventNames() { return Object.keys(this._events); }
              setMaxListeners(n: number) { this._maxListeners = n; return this; }
              getMaxListeners() { return this._maxListeners; }
            }
            // The events module default export IS EventEmitter (allows `class Foo extends require('events')`)
            const mod: any = EventEmitter;
            mod.EventEmitter = EventEmitter;
            mod.default = EventEmitter;
            // Static helpers used by some libraries
            mod.once = async (emitter: any, event: string) => {
              return new Promise<any[]>((resolve) => {
                emitter.once(event, (...args: any[]) => resolve(args));
              });
            };
            mod.on = (emitter: any, event: string) => {
              const events: any[] = [];
              emitter.on(event, (...args: any[]) => events.push(args));
              return { [Symbol.asyncIterator]: async function*() { while (true) { if (events.length) yield events.shift(); else await new Promise(r => setTimeout(r, 10)); } } };
            };
            mod.getEventListeners = (emitter: any, event: string) => emitter.listeners?.(event) || [];
            mod.getMaxListeners = (emitter: any) => emitter.getMaxListeners?.() || 10;
            mod.setMaxListeners = (n: number, ...emitters: any[]) => { emitters.forEach(e => e.setMaxListeners?.(n)); };
            mod.defaultMaxListeners = 10;
            mod.listenerCount = (emitter: any, event: string) => emitter.listenerCount?.(event) || 0;
            return mod;
          }
          case 'url':
          case 'node:url': return {
            URL: globalThis.URL,
            URLSearchParams: globalThis.URLSearchParams,
            parse: (urlStr: string) => {
              try {
                const u = new URL(urlStr);
                return {
                  protocol: u.protocol,
                  slashes: u.protocol.endsWith(':'),
                  auth: u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null,
                  host: u.host,
                  hostname: u.hostname,
                  port: u.port || null,
                  pathname: u.pathname,
                  search: u.search || null,
                  query: u.search ? u.search.slice(1) : null,
                  hash: u.hash || null,
                  path: u.pathname + (u.search || ''),
                  href: u.href,
                };
              } catch { return { protocol: null, hostname: null, pathname: urlStr, path: urlStr, href: urlStr }; }
            },
            format: (urlObj: any) => {
              if (urlObj instanceof URL || urlObj.toString) return urlObj.toString();
              const { protocol, hostname, port, pathname, search, hash } = urlObj;
              return `${protocol || ''}//${hostname || ''}${port ? ':' + port : ''}${pathname || '/'}${search || ''}${hash || ''}`;
            },
            resolve: (from: string, to: string) => new URL(to, from).href,
            fileURLToPath: (url: string | URL) => {
              const u = typeof url === 'string' ? url : url.href;
              if (u.startsWith('file://')) return decodeURIComponent(u.slice(7));
              return u;
            },
            pathToFileURL: (path: string) => new URL('file://' + encodeURI(path)),
          };
          case 'buffer':
          case 'node:buffer': return {
            Buffer: FakeBuffer,
            Blob: typeof globalThis.Blob !== 'undefined' ? globalThis.Blob : class Blob { constructor(parts?: any[], opts?: any) {} text() { return Promise.resolve(''); } arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } },
            File: typeof globalThis.File !== 'undefined' ? globalThis.File : class File { name = ''; constructor(parts: any[], name: string, opts?: any) { this.name = name; } },
            btoa: typeof globalThis.btoa !== 'undefined' ? globalThis.btoa : (s: string) => s,
            atob: typeof globalThis.atob !== 'undefined' ? globalThis.atob : (s: string) => s,
            constants: { MAX_LENGTH: 2147483647, MAX_STRING_LENGTH: 536870888 },
            kMaxLength: 2147483647,
            SlowBuffer: FakeBuffer,
            isUtf8: (buf: Uint8Array) => { try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; } },
            isAscii: (buf: Uint8Array) => { for (let i = 0; i < buf.length; i++) if (buf[i] > 127) return false; return true; },
          };
          case 'stream':
          case 'node:stream': {
            // Stream shim with Transform for libraries like iconv-lite
            const streamModule: any = {};

            const Stream = function(this: any) { this._events = {}; this.destroyed = false; } as any;
            Stream.prototype.pipe = function(dest: any) { return dest; };
            Stream.prototype.on = function(event: string, cb: Function) { (this._events[event] ??= []).push(cb); return this; };
            Stream.prototype.once = function(event: string, cb: Function) { const w = (...a: any[]) => { this.off(event, w); cb(...a); }; return this.on(event, w); };
            Stream.prototype.emit = function(event: string, ...args: any[]) { (this._events[event] || []).forEach((fn: Function) => fn(...args)); return (this._events[event] || []).length > 0; };
            Stream.prototype.off = function(event: string, cb: Function) { this._events[event] = (this._events[event] || []).filter((f: Function) => f !== cb); return this; };
            Stream.prototype.removeListener = function(event: string, cb: Function) { return this.off(event, cb); };
            Stream.prototype.addListener = function(event: string, cb: Function) { return this.on(event, cb); };
            Stream.prototype.removeAllListeners = function(event?: string) { if (event) delete this._events[event]; else this._events = {}; return this; };
            Stream.prototype.listeners = function(event: string) { return [...(this._events[event] || [])]; };
            Stream.prototype.listenerCount = function(event: string) { return (this._events[event] || []).length; };
            Stream.prototype.setMaxListeners = function() { return this; };
            Stream.prototype.prependListener = function(event: string, cb: Function) { (this._events[event] ??= []).unshift(cb); return this; };
            Stream.prototype.eventNames = function() { return Object.keys(this._events); };
            streamModule.Stream = Stream;

            const Readable = function(this: any, opts?: any) { Stream.call(this); this.readable = true; this._readableState = { flowing: null, ended: false, objectMode: opts?.objectMode || false }; } as any;
            Readable.prototype = Object.create(Stream.prototype);
            Readable.prototype.constructor = Readable;
            Readable.prototype._read = function() {};
            Readable.prototype.push = function(_chunk: any) { return true; };
            Readable.prototype.read = function() { return null; };
            Readable.prototype.setEncoding = function(_enc: string) { return this; };
            Readable.prototype.pause = function() { if (this._readableState) this._readableState.flowing = false; return this; };
            Readable.prototype.resume = function() { if (this._readableState) this._readableState.flowing = true; return this; };
            Readable.prototype.isPaused = function() { return this._readableState ? this._readableState.flowing === false : false; };
            Readable.prototype.unshift = function(_chunk: any) {};
            Readable.prototype.wrap = function(_stream: any) { return this; };
            Readable.prototype.destroy = function(err?: any) { this.destroyed = true; if (err) this.emit('error', err); this.emit('close'); return this; };
            Readable.prototype[Symbol.asyncIterator] = async function*() {};
            Readable.from = (iterable: any) => {
              const stream = new Readable();
              (async () => {
                try {
                  for await (const chunk of iterable) {
                    stream.push(chunk);
                  }
                  stream.push(null);
                } catch (e) {
                  stream.emit('error', e);
                }
              })();
              return stream;
            };
            streamModule.Readable = Readable;

            const Writable = function(this: any, opts?: any) { Stream.call(this); this.writable = true; this._writableState = { ended: false, objectMode: opts?.objectMode || false }; } as any;
            Writable.prototype = Object.create(Stream.prototype);
            Writable.prototype.constructor = Writable;
            Writable.prototype._write = function(_chunk: any, _encoding: string, callback: Function) { callback(); };
            Writable.prototype.write = function(_chunk: any, _encoding?: any, _cb?: any) { const cb = typeof _encoding === 'function' ? _encoding : _cb; if (cb) cb(); return true; };
            Writable.prototype.end = function(_chunk?: any, _encoding?: any, _cb?: any) { const cb = typeof _chunk === 'function' ? _chunk : typeof _encoding === 'function' ? _encoding : _cb; if (cb) cb(); this.emit('finish'); };
            Writable.prototype.destroy = function(err?: any) { this.destroyed = true; if (err) this.emit('error', err); this.emit('close'); return this; };
            Writable.prototype.cork = function() {};
            Writable.prototype.uncork = function() {};
            Writable.prototype.setDefaultEncoding = function() { return this; };
            streamModule.Writable = Writable;

            const Duplex = function(this: any, opts?: any) { Readable.call(this, opts); this.writable = true; this._writableState = { ended: false, objectMode: opts?.objectMode || false }; } as any;
            Duplex.prototype = Object.create(Readable.prototype);
            Object.assign(Duplex.prototype, Writable.prototype);
            Duplex.prototype.constructor = Duplex;
            streamModule.Duplex = Duplex;

            const Transform = function(this: any, opts?: any) { Duplex.call(this, opts); } as any;
            Transform.prototype = Object.create(Duplex.prototype);
            Transform.prototype.constructor = Transform;
            Transform.prototype._transform = function(_chunk: any, _encoding: string, callback: Function) { callback(); };
            Transform.prototype._flush = function(callback: Function) { callback(); };
            streamModule.Transform = Transform;

            const PassThrough = function(this: any, opts?: any) { Transform.call(this, opts); } as any;
            PassThrough.prototype = Object.create(Transform.prototype);
            PassThrough.prototype.constructor = PassThrough;
            streamModule.PassThrough = PassThrough;

            // pipeline/finished — used by many Node.js libraries
            streamModule.pipeline = (...args: any[]) => {
              const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
              if (cb) setTimeout(() => cb(null), 0);
              return args[args.length - 1]; // Return last stream
            };
            streamModule.finished = (stream: any, opts: any, cb?: Function) => {
              const callback = typeof opts === 'function' ? opts : cb;
              if (callback) setTimeout(() => callback(null), 0);
              return () => {}; // cleanup function
            };
            streamModule.promises = {
              pipeline: async (...streams: any[]) => streams[streams.length - 1],
              finished: async () => {},
            };
            // Make the module itself a constructor (for `const Stream = require('stream')`)
            streamModule.default = Stream;
            // Node.js stream module is itself a constructor with a prototype
            streamModule.prototype = Stream.prototype;
            streamModule.isErrored = (s: any) => !!s?.destroyed;
            streamModule.isDisturbed = (s: any) => !!s?._readableState?.reading;
            streamModule.isReadable = (s: any) => s instanceof Readable;
            streamModule.isWritable = (s: any) => s instanceof Writable;
            return streamModule;
          }
          case 'crypto':
          case 'node:crypto': return {
            randomBytes: (n: number, cb?: Function) => {
              const bytes = new Uint8Array(n);
              crypto.getRandomValues(bytes);
              Object.setPrototypeOf(bytes, FakeBuffer.prototype);
              if (cb) { setTimeout(() => cb(null, bytes), 0); return; }
              return bytes;
            },
            createHash: (algo: string) => {
              const chunks: Uint8Array[] = [];
              const hashObj: any = {
                update: (d: string | Uint8Array, encoding?: string) => {
                  if (typeof d === 'string') {
                    if (encoding === 'hex') {
                      const hex = d.replace(/[^0-9a-fA-F]/g, '');
                      const bytes = new Uint8Array(hex.length / 2);
                      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
                      chunks.push(bytes);
                    } else {
                      chunks.push(new TextEncoder().encode(d));
                    }
                  } else {
                    chunks.push(d instanceof Uint8Array ? d : new Uint8Array(d));
                  }
                  return hashObj;
                },
                digest: (enc?: string) => {
                  const total = chunks.reduce((n, c) => n + c.length, 0);
                  const all = new Uint8Array(total);
                  let off = 0;
                  for (const c of chunks) { all.set(c, off); off += c.length; }
                  // Real SHA-256 (synchronous implementation for PKCE etc.)
                  const result = (algo === 'sha256' || algo === 'sha-256') ? sha256sync(all)
                    : algo === 'sha1' || algo === 'sha-1' ? sha1sync(all)
                    : fnvHash(all, algo === 'md5' ? 16 : 32);
                  if (enc === 'hex') return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
                  if (enc === 'base64' || enc === 'base64url') { let s = ''; for (let i = 0; i < result.length; i++) s += String.fromCharCode(result[i]); const b64 = btoa(s); return enc === 'base64url' ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64; }
                  Object.setPrototypeOf(result, FakeBuffer.prototype);
                  return result;
                },
              };
              return hashObj;
            },
            createHmac: (algo: string, key: string | Uint8Array) => {
              // Simple HMAC shim — same as createHash but XOR key into data
              const hash = (getBuiltinModule('crypto') as any).createHash(algo);
              const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
              hash.update(keyBytes);
              return hash;
            },
            randomUUID: () => crypto.randomUUID(),
            randomFillSync: (buf: Uint8Array) => { crypto.getRandomValues(buf); return buf; },
            timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
              if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
              let result = 0;
              for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
              return result === 0;
            },
            getHashes: () => ['sha1', 'sha256', 'sha384', 'sha512', 'md5'],
            getCiphers: () => ['aes-256-cbc', 'aes-128-cbc', 'aes-256-gcm'],
            createPrivateKey: (key: any) => ({ type: 'private', export: () => key }),
            createPublicKey: (key: any) => ({ type: 'public', export: () => key }),
            createSecretKey: (key: any) => ({ type: 'secret', export: () => key }),
            KeyObject: class KeyObject { type = 'secret'; constructor(type?: string) { if (type) this.type = type; } export() { return new Uint8Array(0); } },
            // Web Crypto API for jose and other crypto libraries
            webcrypto: crypto,
            subtle: crypto.subtle,
          };
          case 'http':
          case 'node:http':
          case 'https':
          case 'node:https': {
            // HTTP server shim using Shiro's virtual server
            const createServer = (handler?: (req: any, res: any) => void) => {
              let requestHandler = handler;
              let cleanupFn: (() => void) | null = null;
              let listeningPort: number | null = null;

              const server: any = {
                _events: {} as Record<string, Function[]>,
                listening: false,
                on(event: string, cb: Function) {
                  if (event === 'request' && !requestHandler) {
                    requestHandler = cb as any;
                  }
                  (this._events[event] ??= []).push(cb);
                  return this;
                },
                once(event: string, cb: Function) {
                  const wrapper = (...args: any[]) => {
                    this.off(event, wrapper);
                    cb(...args);
                  };
                  return this.on(event, wrapper);
                },
                off(event: string, cb: Function) {
                  if (this._events[event]) {
                    this._events[event] = this._events[event].filter((f: Function) => f !== cb);
                  }
                  return this;
                },
                removeListener(event: string, cb: Function) { return this.off(event, cb); },
                removeAllListeners(event?: string) {
                  if (event) delete this._events[event];
                  else this._events = {};
                  return this;
                },
                addListener(event: string, cb: Function) { return this.on(event, cb); },
                listeners(event: string) { return [...(this._events[event] || [])]; },
                listenerCount(event: string) { return (this._events[event] || []).length; },
                emit(event: string, ...args: any[]) {
                  (this._events[event] || []).forEach((fn: Function) => fn(...args));
                  return (this._events[event] || []).length > 0;
                },
                ref() { return this; },
                unref() { return this; },
                setTimeout() { return this; },
                maxConnections: Infinity,
                connections: 0,
                listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void) {
                  const cb = typeof hostOrCallback === 'function' ? hostOrCallback : callback;
                  // Port 0 means "pick a random available port"
                  if (port === 0) port = 30000 + Math.floor(Math.random() * 10000);
                  listeningPort = port;

                  // Use iframe-based server for visibility
                  const handler = async (vReq: any) => {
                    return new Promise<any>((resolve) => {
                      // Build Node-like request object
                      const req: any = {
                        method: vReq.method,
                        url: vReq.path + (Object.keys(vReq.query || {}).length ? '?' + new URLSearchParams(vReq.query).toString() : ''),
                        headers: vReq.headers || {},
                        query: vReq.query || {},
                        body: vReq.body,
                        on(event: string, handler: Function) {
                          if (event === 'data' && vReq.body) {
                            setTimeout(() => handler(vReq.body), 0);
                          }
                          if (event === 'end') {
                            setTimeout(() => handler(), 0);
                          }
                          return this;
                        },
                      };

                      // Build Node-like response object
                      let statusCode = 200;
                      let responseHeaders: Record<string, string> = {};
                      let responseBody = '';

                      const res: any = {
                        statusCode: 200,
                        setHeader(name: string, value: string) {
                          responseHeaders[name.toLowerCase()] = value;
                        },
                        getHeader(name: string) {
                          return responseHeaders[name.toLowerCase()];
                        },
                        writeHead(code: number, headers?: Record<string, string>) {
                          statusCode = code;
                          if (headers) {
                            for (const [k, v] of Object.entries(headers)) {
                              responseHeaders[k.toLowerCase()] = v;
                            }
                          }
                          return this;
                        },
                        write(chunk: string) {
                          responseBody += chunk;
                          return true;
                        },
                        end(data?: string) {
                          if (data) responseBody += data;
                          resolve({
                            status: statusCode,
                            headers: responseHeaders,
                            body: responseBody,
                          });
                        },
                        // Express-style helpers
                        status(code: number) {
                          statusCode = code;
                          return this;
                        },
                        json(data: any) {
                          responseHeaders['content-type'] = 'application/json';
                          this.end(JSON.stringify(data));
                        },
                        send(data: any) {
                          if (typeof data === 'object') {
                            this.json(data);
                          } else {
                            this.end(String(data));
                          }
                        },
                      };

                      // Call the request handler
                      if (requestHandler) {
                        try {
                          requestHandler(req, res);
                        } catch (err: any) {
                          resolve({
                            status: 500,
                            body: `Server error: ${err.message}`,
                          });
                        }
                      } else {
                        resolve({ status: 404, body: 'No handler' });
                      }
                    });
                  };

                  // Register with iframe server
                  cleanupFn = iframeServer.serve(port, handler, `http:${port}`);
                  fakeConsole.log(`Server listening on port ${port}`);

                  // Show iframe if terminal supports it
                  const terminal = (ctx.shell as any)._terminal;
                  if (terminal && typeof terminal.getIframeContainer === 'function') {
                    const container = terminal.getIframeContainer();
                    iframeServer.createIframe(port, container, { height: '300px' })
                      .then(() => fakeConsole.log('Browser window opened'))
                      .catch((err: Error) => fakeConsole.warn('Could not open browser:', err.message));
                  }

                  server.listening = true;
                  // Fire callback async (like real Node.js nextTick)
                  setTimeout(() => {
                    server.emit('listening');
                    cb?.();
                  }, 0);

                  return this;
                },
                close(cb?: () => void) {
                  server.listening = false;
                  if (cleanupFn) {
                    cleanupFn();
                    cleanupFn = null;
                  }
                  if (listeningPort) {
                    fakeConsole.log(`Server on port ${listeningPort} closed`);
                    listeningPort = null;
                  }
                  server.emit('close');
                  cb?.();
                  return this;
                },
                address() {
                  return listeningPort ? { port: listeningPort, address: '0.0.0.0' } : null;
                },
                closeAllConnections() { /* no-op stub */ },
                closeIdleConnections() { /* no-op stub */ },
                getConnections(cb?: Function) { cb?.(null, 0); },
              };
              return server;
            };

            // IncomingMessage — needed for class extends
            class IncomingMessage {
              headers: Record<string, string> = {};
              method = 'GET';
              url = '/';
              statusCode = 200;
              httpVersion = '1.1';
              on(_e: string, _fn: Function) { return this; }
              once(_e: string, _fn: Function) { return this; }
              pipe(dest: any) { return dest; }
            }

            // Agent — used as base class by AWS SDK, gRPC, etc.
            class Agent {
              maxSockets = Infinity;
              maxFreeSockets = 256;
              options: any = {};
              requests: any = {};
              sockets: any = {};
              freeSockets: any = {};
              constructor(opts?: any) { if (opts) this.options = opts; }
              destroy() {}
              createConnection(opts: any, cb: Function) { cb(null, new (getBuiltinModule('net') as any).Socket()); }
            }

            // ClientRequest — uses browser fetch to make real HTTP requests
            class FetchClientRequest {
              _events: Record<string, Function[]> = {};
              _headers: Record<string, string> = {};
              _body: string[] = [];
              _opts: any;
              _ended = false;
              _aborted = false;
              _timeout = 0;
              _abortController: AbortController | null = null;

              constructor(opts: any) {
                this._opts = opts;
                if (opts.headers) {
                  for (const [k, v] of Object.entries(opts.headers)) {
                    this._headers[k.toLowerCase()] = String(v);
                  }
                }
                if (opts.timeout) this._timeout = opts.timeout;
              }
              on(ev: string, fn: Function) { (this._events[ev] ??= []).push(fn); return this; }
              once(ev: string, fn: Function) {
                const wrapper = (...args: any[]) => {
                  this._events[ev] = (this._events[ev] || []).filter(f => f !== wrapper);
                  fn(...args);
                };
                return this.on(ev, wrapper);
              }
              emit(ev: string, ...args: any[]) { (this._events[ev] || []).forEach(f => f(...args)); }
              setHeader(name: string, value: string) { this._headers[name.toLowerCase()] = String(value); }
              getHeader(name: string) { return this._headers[name.toLowerCase()]; }
              removeHeader(name: string) { delete this._headers[name.toLowerCase()]; }
              write(chunk: string | Uint8Array) {
                this._body.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
                return true;
              }
              end(data?: string | Uint8Array) {
                if (this._ended) return;
                this._ended = true;
                if (data) this.write(data);
                if (this._aborted) return;

                // Build URL from opts
                const o = this._opts;
                const isHttps = name === 'https' || name === 'node:https';
                const protocol = o.protocol || (isHttps ? 'https:' : 'http:');
                const host = o.hostname || o.host || 'localhost';
                const port = o.port ? `:${o.port}` : '';
                const path = o.path || '/';
                const url = `${protocol}//${host}${port}${path}`;

                // Use AbortController for timeout support
                this._abortController = new AbortController();
                const timeoutMs = this._timeout || 30000; // default 30s timeout
                const timeoutId = setTimeout(() => {
                  this._abortController?.abort();
                  this.emit('timeout');
                }, timeoutMs);

                const fetchOpts: RequestInit = {
                  method: o.method || 'GET',
                  headers: this._headers,
                  signal: this._abortController.signal,
                };
                if (this._body.length > 0 && o.method !== 'GET' && o.method !== 'HEAD') {
                  fetchOpts.body = this._body.join('');
                }

                globalThis.fetch(url, fetchOpts).then(async (resp) => {
                  clearTimeout(timeoutId);
                  // Build IncomingMessage-like response
                  const resHeaders: Record<string, string> = {};
                  resp.headers.forEach((v, k) => { resHeaders[k] = v; });
                  const body = resp.body;

                  const res: any = new IncomingMessage();
                  res.statusCode = resp.status;
                  res.statusMessage = resp.statusText;
                  res.headers = resHeaders;
                  res.httpVersion = '1.1';

                  const resEvents: Record<string, Function[]> = {};
                  res.on = (ev: string, fn: Function) => { (resEvents[ev] ??= []).push(fn); return res; };
                  res.once = (ev: string, fn: Function) => { return res.on(ev, fn); };
                  res.removeListener = (ev: string, fn: Function) => { resEvents[ev] = (resEvents[ev] || []).filter(f => f !== fn); return res; };
                  res.removeAllListeners = (ev?: string) => { if (ev) delete resEvents[ev]; else Object.keys(resEvents).forEach(k => delete resEvents[k]); return res; };
                  res.pipe = (dest: any) => {
                    res.on('data', (chunk: any) => dest.write(chunk));
                    res.on('end', () => { if (dest.end) dest.end(); });
                    return dest;
                  };
                  res.resume = () => res;
                  res.destroy = () => res;
                  res.setEncoding = (_enc: string) => res;

                  // Emit response callback
                  this.emit('response', res);

                  // Stream body data
                  if (body) {
                    const reader = body.getReader();
                    const pump = async () => {
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        (resEvents['data'] || []).forEach(fn => fn(value));
                      }
                      (resEvents['end'] || []).forEach(fn => fn());
                      (resEvents['close'] || []).forEach(fn => fn());
                    };
                    pump().catch(err => {
                      (resEvents['error'] || []).forEach(fn => fn(err));
                    });
                  } else {
                    queueMicrotask(() => {
                      (resEvents['end'] || []).forEach(fn => fn());
                      (resEvents['close'] || []).forEach(fn => fn());
                    });
                  }
                }).catch(err => {
                  clearTimeout(timeoutId);
                  this.emit('error', err);
                });
              }
              abort() { this._aborted = true; this._abortController?.abort(); this.emit('abort'); }
              destroy(err?: Error) { this._aborted = true; this._abortController?.abort(); if (err) this.emit('error', err); }
              setTimeout(ms: number, cb?: Function) { this._timeout = ms; if (cb) this.on('timeout', cb); return this; }
              flushHeaders() {}
              setNoDelay() {}
              setSocketKeepAlive() {}
            }

            const makeRequest = (optsOrUrl: any, cbOrOpts?: any, cb?: Function) => {
              let opts: any;
              let callback: Function | undefined;
              if (typeof optsOrUrl === 'string') {
                const u = new URL(optsOrUrl);
                opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' };
                callback = typeof cbOrOpts === 'function' ? cbOrOpts : cb;
                if (typeof cbOrOpts === 'object') Object.assign(opts, cbOrOpts);
              } else if (optsOrUrl instanceof URL) {
                opts = { protocol: optsOrUrl.protocol, hostname: optsOrUrl.hostname, port: optsOrUrl.port, path: optsOrUrl.pathname + optsOrUrl.search, method: 'GET' };
                callback = typeof cbOrOpts === 'function' ? cbOrOpts : cb;
              } else {
                opts = optsOrUrl;
                callback = typeof cbOrOpts === 'function' ? cbOrOpts : cb;
              }
              const req = new FetchClientRequest(opts);
              if (callback) req.on('response', callback);
              return req;
            };

            const makeGet = (optsOrUrl: any, cbOrOpts?: any, cb?: Function) => {
              const req = makeRequest(optsOrUrl, cbOrOpts, cb);
              req.end();
              return req;
            };

            const STATUS_CODES: Record<number, string> = {
              200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
              302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
              403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
              500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
            };

            const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];

            return {
              createServer,
              Server: function(handler?: any) { return createServer(handler); },
              request: makeRequest,
              get: makeGet,
              IncomingMessage,
              ServerResponse: class ServerResponse {},
              ClientRequest: FetchClientRequest,
              Agent,
              globalAgent: new Agent(),
              STATUS_CODES,
              METHODS,
            };
          }
          case 'dotenv':
          case 'dotenv/config': {
            // dotenv shim - reads .env file and populates process.env
            const config = (options?: { path?: string }) => {
              const envPath = options?.path || '.env';
              const resolved = ctx.fs.resolvePath(envPath, ctx.cwd);
              const content = fileCache.get(resolved);
              if (content) {
                for (const line of content.split('\n')) {
                  const trimmed = line.trim();
                  if (!trimmed || trimmed.startsWith('#')) continue;
                  const eqIdx = trimmed.indexOf('=');
                  if (eqIdx > 0) {
                    const key = trimmed.slice(0, eqIdx).trim();
                    let value = trimmed.slice(eqIdx + 1).trim();
                    // Remove quotes
                    if ((value.startsWith('"') && value.endsWith('"')) ||
                        (value.startsWith("'") && value.endsWith("'"))) {
                      value = value.slice(1, -1);
                    }
                    ctx.env[key] = value;
                    fakeProcess.env[key] = value;
                  }
                }
              }
              return { parsed: ctx.env };
            };
            // Auto-run config when imported as 'dotenv/config'
            if (name === 'dotenv/config') {
              config();
            }
            return { config, parse: (src: string) => {
              const result: Record<string, string> = {};
              for (const line of src.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                  const key = trimmed.slice(0, eqIdx).trim();
                  let value = trimmed.slice(eqIdx + 1).trim();
                  if ((value.startsWith('"') && value.endsWith('"')) ||
                      (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                  }
                  result[key] = value;
                }
              }
              return result;
            }};
          }
          case 'tslib': {
            // tslib shim - TypeScript helper library used by many packages
            const __importDefault = (mod: any) => (mod && mod.__esModule) ? mod : { default: mod };
            const __importStar = (mod: any) => {
              if (mod && mod.__esModule) return mod;
              const result: any = {};
              if (mod != null) for (const k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
              result.default = mod;
              return result;
            };
            const __awaiter = (_this: any, _args: any, _P: any, generator: any) => {
              return new Promise((resolve, reject) => {
                function fulfilled(value: any) { try { step(generator.next(value)); } catch (e) { reject(e); } }
                function rejected(value: any) { try { step(generator.throw(value)); } catch (e) { reject(e); } }
                function step(result: any) { result.done ? resolve(result.value) : Promise.resolve(result.value).then(fulfilled, rejected); }
                step((generator = generator.apply(_this, _args || [])).next());
              });
            };
            const __generator = (_this: any, body: any) => {
              // Simplified generator - just return the body function result
              let f: any, y: any, t: any, g: any;
              return g = { next: verb(0), throw: verb(1), return: verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
              function verb(n: any) { return function(v: any) { return step([n, v]); }; }
              function step(op: any) {
                if (f) throw new TypeError("Generator is already executing.");
                while (g && (g = 0, op[0] && (_ = 0)), _) try {
                  if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
                  if (y = 0, t) op = [op[0] & 2, t.value];
                  switch (op[0]) {
                    case 0: case 1: t = op; break;
                    case 4: _.label++; return { value: op[1], done: false };
                    case 5: _.label++; y = op[1]; op = [0]; continue;
                    case 7: op = _.ops.pop(); _.trys.pop(); continue;
                    default:
                      if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                      if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                      if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                      if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                      if (t[2]) _.ops.pop();
                      _.trys.pop(); continue;
                  }
                  op = body.call(_this, _);
                } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
                if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
              }
              let _: any = { label: 0, sent: () => t[0] & 1 ? t[1] : t[1], trys: [] as any[], ops: [] as any[] };
            };
            const __spreadArray = (to: any[], from: any[], _pack?: any) => {
              return to.concat(Array.prototype.slice.call(from));
            };
            const __assign = Object.assign;
            const __rest = (s: any, e: any) => {
              const t: any = {};
              for (const p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];
              return t;
            };
            const __extends = (d: any, b: any) => {
              if (typeof b !== "function" && b !== null)
                throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
              Object.setPrototypeOf(d, b);
              d.prototype = b === null ? Object.create(b) : Object.create(b.prototype);
              d.prototype.constructor = d;
            };
            const __exportStar = (m: any, o: any) => {
              for (const p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p)) o[p] = m[p];
            };
            const __createBinding = (o: any, m: any, k: any, k2?: any) => {
              if (k2 === undefined) k2 = k;
              Object.defineProperty(o, k2, { enumerable: true, get: () => m[k] });
            };
            const __values = (o: any) => {
              const s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s];
              let i = 0;
              if (m) return m.call(o);
              if (o && typeof o.length === "number") return {
                next: () => ({ value: o && o[i++], done: !o || i >= o.length })
              };
              throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
            };
            const __read = (o: any, n?: number) => {
              const ar: any[] = [];
              for (let i = 0, r: any; i < (n === undefined ? o.length : n); i++) {
                r = o[i];
                ar.push(r);
              }
              return ar;
            };
            const __spread = (...args: any[]) => {
              const ar: any[] = [];
              for (const a of args) ar.push(...a);
              return ar;
            };
            const __decorate = (decorators: any[], target: any, key?: any, desc?: any) => {
              let c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
              for (let i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
              if (c > 3 && r) Object.defineProperty(target, key, r);
              return r;
            };
            const __param = (paramIndex: number, decorator: any) => (target: any, key: any) => decorator(target, key, paramIndex);
            const __metadata = (_metadataKey: any, _metadataValue: any) => (_target: any, _key: any) => {};
            return {
              __importDefault, __importStar, __awaiter, __generator,
              __spreadArray, __assign, __rest, __extends,
              __exportStar, __createBinding, __values, __read, __spread,
              __decorate, __param, __metadata,
              __esModule: true,
            };
          }
          case 'cookie-parser': {
            // cookie-parser middleware shim
            const cookieParser = (secret?: string) => {
              return (req: any, res: any, next: Function) => {
                req.cookies = {};
                req.signedCookies = {};
                const cookieHeader = req.headers?.cookie || req.get?.('cookie') || '';
                if (cookieHeader) {
                  for (const part of cookieHeader.split(';')) {
                    const [key, ...rest] = part.trim().split('=');
                    if (key) {
                      const value = rest.join('=');
                      req.cookies[key.trim()] = decodeURIComponent(value || '');
                    }
                  }
                }
                next?.();
              };
            };
            return Object.assign(cookieParser, { default: cookieParser });
          }
          case 'cors': {
            // cors middleware shim
            const cors = (options?: any) => {
              return (req: any, res: any, next: Function) => {
                const origin = options?.origin || '*';
                res.setHeader?.('Access-Control-Allow-Origin', origin);
                res.setHeader?.('Access-Control-Allow-Methods', options?.methods || 'GET,HEAD,PUT,PATCH,POST,DELETE');
                res.setHeader?.('Access-Control-Allow-Headers', options?.allowedHeaders || 'Content-Type,Authorization');
                if (options?.credentials) {
                  res.setHeader?.('Access-Control-Allow-Credentials', 'true');
                }
                if (req.method === 'OPTIONS') {
                  res.status?.(204).end?.();
                  return;
                }
                next?.();
              };
            };
            return Object.assign(cors, { default: cors });
          }
          case 'express-jwt': {
            // express-jwt middleware shim
            const expressjwt = (options: any) => {
              const { secret, algorithms, credentialsRequired = true, requestProperty = 'auth', getToken } = options;
              return (req: any, res: any, next: Function) => {
                try {
                  // Get token from custom function or Authorization header
                  let token = getToken ? getToken(req) : null;
                  if (!token) {
                    const authHeader = req.headers?.authorization || req.get?.('authorization');
                    if (authHeader?.startsWith('Bearer ')) {
                      token = authHeader.slice(7);
                    }
                  }

                  if (!token) {
                    // No token present
                    if (credentialsRequired) {
                      const err: any = new Error('No authorization token was found');
                      err.name = 'UnauthorizedError';
                      err.status = 401;
                      return next(err);
                    }
                    // credentialsRequired: false - just continue without setting auth
                    return next();
                  }

                  // Decode JWT (without verification for now - simplified shim)
                  // In browser we can't easily verify HS256 signatures
                  const parts = token.split('.');
                  if (parts.length === 3) {
                    try {
                      const payload = JSON.parse(atob(parts[1]));
                      req[requestProperty] = payload;
                    } catch {
                      if (credentialsRequired) {
                        const err: any = new Error('Invalid token');
                        err.name = 'UnauthorizedError';
                        err.status = 401;
                        return next(err);
                      }
                    }
                  }
                  next();
                } catch (err) {
                  next(err);
                }
              };
            };
            return { expressjwt, default: expressjwt };
          }
          case 'sharp': {
            // sharp image processing stub - native module can't run in browser
            // Returns a chainable API that passes through or returns placeholder data
            const sharp = (input?: any) => {
              const instance: any = {
                resize: () => instance,
                rotate: () => instance,
                flip: () => instance,
                flop: () => instance,
                sharpen: () => instance,
                median: () => instance,
                blur: () => instance,
                flatten: () => instance,
                gamma: () => instance,
                negate: () => instance,
                normalise: () => instance,
                normalize: () => instance,
                clahe: () => instance,
                convolve: () => instance,
                threshold: () => instance,
                linear: () => instance,
                recomb: () => instance,
                modulate: () => instance,
                tint: () => instance,
                greyscale: () => instance,
                grayscale: () => instance,
                toColourspace: () => instance,
                toColorspace: () => instance,
                removeAlpha: () => instance,
                ensureAlpha: () => instance,
                extractChannel: () => instance,
                joinChannel: () => instance,
                bandbool: () => instance,
                extract: () => instance,
                trim: () => instance,
                extend: () => instance,
                composite: () => instance,
                jpeg: () => instance,
                png: () => instance,
                webp: () => instance,
                avif: () => instance,
                heif: () => instance,
                tiff: () => instance,
                gif: () => instance,
                jp2: () => instance,
                raw: () => instance,
                tile: () => instance,
                timeout: () => instance,
                withMetadata: () => instance,
                clone: () => sharp(input),
                metadata: async () => ({ width: 100, height: 100, format: 'png' }),
                stats: async () => ({ channels: [] }),
                toBuffer: async () => input || new Uint8Array(0),
                toFile: async (path: string) => ({ size: 0, width: 100, height: 100 }),
                pipe: (dest: any) => dest,
              };
              return instance;
            };
            sharp.cache = () => {};
            sharp.concurrency = () => 1;
            sharp.counters = () => ({});
            sharp.simd = () => false;
            sharp.format = { jpeg: {}, png: {}, webp: {} };
            sharp.versions = { sharp: '0.0.0-shiro-stub' };
            return Object.assign(sharp, { default: sharp });
          }
          case 'querystring':
          case 'node:querystring': return {
            parse: (str: string) => {
              const obj: Record<string, string> = {};
              for (const pair of str.split('&')) {
                const [k, v] = pair.split('=');
                if (k) obj[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
              }
              return obj;
            },
            stringify: (obj: Record<string, any>) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
            encode: (obj: Record<string, any>) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
            decode: (str: string) => {
              const obj: Record<string, string> = {};
              for (const pair of str.split('&')) {
                const [k, v] = pair.split('=');
                if (k) obj[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
              }
              return obj;
            },
            escape: encodeURIComponent,
            unescape: decodeURIComponent,
          };

          case 'string_decoder':
          case 'node:string_decoder': {
            class StringDecoder {
              encoding: string;
              constructor(encoding = 'utf8') { this.encoding = encoding; }
              write(buf: any): string { return new TextDecoder(this.encoding).decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf)); }
              end(buf?: any): string { return buf ? this.write(buf) : ''; }
            }
            return { StringDecoder };
          }

          case 'constants':
          case 'node:constants': return {
            O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128,
            O_TRUNC: 512, O_APPEND: 1024, O_DIRECTORY: 65536, O_NOFOLLOW: 131072,
            S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960,
            S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64,
            S_IRWXG: 56, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8,
            S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1,
            SIGINT: 2, SIGTERM: 15, SIGKILL: 9,
          };

          case 'tty':
          case 'node:tty': return {
            isatty: (fd?: number) => !!ctx.terminal,
            ReadStream: class ReadStream { constructor() {} setRawMode() { return this; } isTTY = !!ctx.terminal; },
            WriteStream: class WriteStream {
              isTTY = !!ctx.terminal;
              get columns() { return ctx.terminal ? ctx.terminal.getSize().cols : 80; }
              get rows() { return ctx.terminal ? ctx.terminal.getSize().rows : 24; }
              getColorDepth() { return ctx.terminal ? 24 : 1; }
              hasColors(count?: number) { return ctx.terminal ? (count ? count <= 16777216 : true) : false; }
              getWindowSize() { return [this.columns, this.rows]; }
              cursorTo() {}
              moveCursor() {}
              clearLine() {}
              clearScreenDown() {}
              write(data: any) { fakeProcess.stdout.write(typeof data === 'string' ? data : String(data)); }
            },
          };

          case 'zlib':
          case 'node:zlib': {
            // Stub zlib using DecompressionStream/CompressionStream when possible
            const passthrough = (data: any, cb?: Function) => {
              if (cb) cb(null, data);
              return data;
            };
            return {
              createGunzip: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
              createGzip: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
              createDeflate: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
              createInflate: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
              gzip: passthrough,
              gunzip: passthrough,
              deflate: passthrough,
              inflate: passthrough,
              gzipSync: (data: any) => data,
              gunzipSync: (data: any) => data,
              deflateSync: (data: any) => data,
              inflateSync: (data: any) => data,
              brotliCompressSync: (data: any) => data,
              brotliDecompressSync: (data: any) => data,
              createInflateRaw: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
              createDeflateRaw: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
              createBrotliCompress: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
              createBrotliDecompress: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
              deflateRawSync: (data: any) => data,
              inflateRawSync: (data: any) => data,
              Z_DEFAULT_WINDOWBITS: 15,
              Z_NO_FLUSH: 0,
              Z_PARTIAL_FLUSH: 1,
              constants: {
                Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
                Z_DEFAULT_COMPRESSION: -1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3,
                Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_DEFAULT_WINDOWBITS: 15,
                BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
              },
            };
          }

          case 'dns':
          case 'node:dns': {
            const dnsModule: any = {
              lookup: (hostname: string, opts: any, cb?: Function) => {
                if (typeof opts === 'function') { cb = opts; opts = {}; }
                cb?.(null, '127.0.0.1', 4);
              },
              resolve: (hostname: string, rrtype: any, cb?: Function) => {
                if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
                cb?.(null, ['127.0.0.1']);
              },
              resolve4: (hostname: string, cb: Function) => cb(null, ['127.0.0.1']),
              resolve6: (hostname: string, cb: Function) => cb(null, ['::1']),
              setServers: () => {},
              getServers: () => ['8.8.8.8'],
            };
            dnsModule.promises = {
              lookup: async (hostname: string) => ({ address: '127.0.0.1', family: 4 }),
              resolve: async (hostname: string) => ['127.0.0.1'],
              resolve4: async (hostname: string) => ['127.0.0.1'],
              resolve6: async (hostname: string) => ['::1'],
            };
            return dnsModule;
          }

          case 'net':
          case 'node:net': {
            class FakeSocket {
              writable = true;
              readable = true;
              destroyed = false;
              _events: Record<string, Function[]> = {};
              on(ev: string, fn: Function) { (this._events[ev] ||= []).push(fn); return this; }
              once(ev: string, fn: Function) { return this.on(ev, fn); }
              off() { return this; }
              emit(ev: string, ...args: any[]) { (this._events[ev] || []).forEach(f => f(...args)); }
              write(data: any, encoding?: any, cb?: Function) { if (typeof encoding === 'function') cb = encoding; cb?.(); return true; }
              end(data?: any, encoding?: any, cb?: Function) { if (typeof data === 'function') cb = data; cb?.(); this.destroyed = true; }
              destroy() { this.destroyed = true; return this; }
              setEncoding() { return this; }
              setKeepAlive() { return this; }
              setNoDelay() { return this; }
              setTimeout() { return this; }
              ref() { return this; }
              unref() { return this; }
              address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
              get remoteAddress() { return '127.0.0.1'; }
              get remotePort() { return 0; }
              get localAddress() { return '127.0.0.1'; }
              get localPort() { return 0; }
              pipe(dest: any) { return dest; }
            }
            class FakeServer {
              _events: Record<string, Function[]> = {};
              on(ev: string, fn: Function) { (this._events[ev] ||= []).push(fn); return this; }
              once(ev: string, fn: Function) { return this.on(ev, fn); }
              listen(port?: any, host?: any, cb?: Function) {
                if (typeof port === 'function') cb = port;
                else if (typeof host === 'function') cb = host;
                setTimeout(() => cb?.(), 0);
                return this;
              }
              close(cb?: Function) { cb?.(); return this; }
              address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
              ref() { return this; }
              unref() { return this; }
            }
            return {
              Socket: FakeSocket,
              Server: FakeServer,
              createServer: (opts?: any, handler?: Function) => {
                if (typeof opts === 'function') { handler = opts; }
                return new FakeServer();
              },
              createConnection: (opts?: any, cb?: Function) => {
                const sock = new FakeSocket();
                if (cb) setTimeout(() => cb(), 0);
                return sock;
              },
              connect: (opts?: any, cb?: Function) => {
                const sock = new FakeSocket();
                if (cb) setTimeout(() => cb(), 0);
                return sock;
              },
              isIP: (input: string) => /^\d+\.\d+\.\d+\.\d+$/.test(input) ? 4 : (input.includes(':') ? 6 : 0),
              isIPv4: (input: string) => /^\d+\.\d+\.\d+\.\d+$/.test(input),
              isIPv6: (input: string) => input.includes(':'),
            };
          }

          case 'tls':
          case 'node:tls': {
            const netMod = getBuiltinModule('net');
            return {
              ...netMod,
              TLSSocket: netMod.Socket,
              createSecureContext: () => ({}),
              getCiphers: () => ['TLS_AES_256_GCM_SHA384'],
              DEFAULT_MIN_VERSION: 'TLSv1.2',
              DEFAULT_MAX_VERSION: 'TLSv1.3',
              connect: (opts: any, cb?: Function) => netMod.connect(opts, cb),
            };
          }

          case 'perf_hooks':
          case 'node:perf_hooks': return {
            performance: typeof performance !== 'undefined' ? performance : {
              now: () => Date.now(),
              timeOrigin: Date.now(),
              mark: () => {},
              measure: () => {},
              getEntries: () => [],
              getEntriesByName: () => [],
              getEntriesByType: () => [],
              clearMarks: () => {},
              clearMeasures: () => {},
            },
            PerformanceObserver: class PerformanceObserver {
              constructor(cb: Function) {}
              observe() {}
              disconnect() {}
            },
            monitorEventLoopDelay: () => ({
              enable: () => {},
              disable: () => {},
              percentile: () => 0,
              min: 0, max: 0, mean: 0, stddev: 0,
            }),
          };

          case 'timers':
          case 'node:timers': return {
            setTimeout, setInterval, setImmediate: (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args),
            clearTimeout, clearInterval, clearImmediate: clearTimeout,
          };

          case 'timers/promises':
          case 'node:timers/promises': return {
            setTimeout: (ms: number, value?: any) => new Promise(resolve => setTimeout(() => resolve(value), ms)),
            setInterval: async function*(ms: number, value?: any) { while (true) { await new Promise(r => setTimeout(r, ms)); yield value; } },
            setImmediate: (value?: any) => new Promise(resolve => setTimeout(() => resolve(value), 0)),
            scheduler: { wait: (ms: number) => new Promise(r => setTimeout(r, ms)), yield: () => new Promise(r => setTimeout(r, 0)) },
          };

          case 'module':
          case 'node:module': {
            // Provide createRequire that delegates to our require system
            const modExport: any = {
              createRequire: (_url: string) => {
                // Return a require function that uses our module resolution
                const fakeReq: any = (id: string) => requireModule(id, ctx.cwd);
                fakeReq.resolve = (id: string) => {
                  // Simple resolve: check builtins first, then file paths
                  if (getBuiltinModule(id) || getBuiltinModule('node:' + id)) return id;
                  // Try to find the file in cache
                  const tryPaths = [
                    id,
                    id + '.js',
                    id + '/index.js',
                  ];
                  for (const p of tryPaths) {
                    if (fileCache.has(p)) return p;
                  }
                  return id;
                };
                fakeReq.resolve.paths = () => [ctx.cwd + '/node_modules', '/usr/local/lib/node_modules'];
                fakeReq.cache = moduleCache;
                return fakeReq;
              },
              builtinModules: [
                'assert', 'async_hooks', 'buffer', 'child_process', 'constants', 'crypto',
                'diagnostics_channel', 'dns', 'events', 'fs', 'fs/promises', 'http', 'https',
                'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring',
                'readline', 'stream', 'string_decoder', 'timers', 'timers/promises', 'tls',
                'tty', 'url', 'util', 'v8', 'worker_threads', 'zlib',
              ],
              isBuiltin: (name: string) => {
                const clean = name.startsWith('node:') ? name.slice(5) : name;
                return modExport.builtinModules.includes(clean);
              },
              _resolveFilename: (request: string) => request,
              _cache: moduleCache,
              Module: class Module {
                id: string;
                exports: any = {};
                constructor(id = '') { this.id = id; }
              },
            };
            return modExport;
          }

          case 'process':
          case 'node:process':
            return fakeProcess;

          case 'path/posix':
          case 'node:path/posix': return getBuiltinModule('path');

          case 'path/win32':
          case 'node:path/win32': return getBuiltinModule('path');

          case 'async_hooks':
          case 'node:async_hooks': {
            // AsyncLocalStorage: context propagation for async operations
            class AsyncLocalStorage {
              private _store: any = undefined;
              getStore() { return this._store; }
              run(store: any, fn: Function, ...args: any[]) { const prev = this._store; this._store = store; try { return fn(...args); } finally { this._store = prev; } }
              enterWith(store: any) { this._store = store; }
              disable() { this._store = undefined; }
              exit(fn: Function, ...args: any[]) { const prev = this._store; this._store = undefined; try { return fn(...args); } finally { this._store = prev; } }
            }
            class AsyncResource {
              type: string;
              constructor(type: string) { this.type = type; }
              runInAsyncScope(fn: Function, thisArg?: any, ...args: any[]) { return fn.apply(thisArg, args); }
              emitDestroy() { return this; }
              asyncId() { return 0; }
              triggerAsyncId() { return 0; }
              bind(fn: Function) { return fn; }
              static bind(fn: Function) { return fn; }
            }
            return {
              AsyncLocalStorage,
              AsyncResource,
              createHook: () => ({ enable: () => {}, disable: () => {} }),
              executionAsyncId: () => 0,
              triggerAsyncId: () => 0,
              executionAsyncResource: () => ({}),
            };
          }

          case 'worker_threads':
          case 'node:worker_threads': return {
            isMainThread: true,
            parentPort: null,
            workerData: null,
            threadId: 0,
            Worker: class Worker { constructor() { throw new Error('Workers not supported'); } },
            MessageChannel: class MessageChannel { port1 = {}; port2 = {}; },
            MessagePort: class MessagePort {},
          };

          case 'readline':
          case 'node:readline': return {
            cursorTo: (stream: any, x: number, y?: number | Function, cb?: Function) => {
              if (stream?.write) {
                let seq = `\x1b[${x + 1}G`;
                if (typeof y === 'number') seq = `\x1b[${y + 1};${x + 1}H`;
                stream.write(seq);
              }
              if (typeof y === 'function') y(); else if (cb) cb();
              return true;
            },
            clearLine: (stream: any, dir: number, cb?: Function) => {
              if (stream?.write) {
                stream.write(dir === -1 ? '\x1b[1K' : dir === 1 ? '\x1b[0K' : '\x1b[2K');
              }
              if (cb) cb();
              return true;
            },
            moveCursor: (stream: any, dx: number, dy: number, cb?: Function) => {
              if (stream?.write) {
                let seq = '';
                if (dx > 0) seq += `\x1b[${dx}C`;
                else if (dx < 0) seq += `\x1b[${-dx}D`;
                if (dy > 0) seq += `\x1b[${dy}B`;
                else if (dy < 0) seq += `\x1b[${-dy}A`;
                if (seq) stream.write(seq);
              }
              if (cb) cb();
              return true;
            },
            clearScreenDown: (stream: any, cb?: Function) => {
              if (stream?.write) stream.write('\x1b[J');
              if (cb) cb();
              return true;
            },
            createInterface: (opts: any) => {
              const events: Record<string, Function[]> = {};
              const iface: any = {
                on: (ev: string, fn: Function) => { (events[ev] ??= []).push(fn); return iface; },
                once: (ev: string, fn: Function) => iface.on(ev, fn),
                off: (ev: string, fn: Function) => { events[ev] = (events[ev] || []).filter(f => f !== fn); return iface; },
                removeListener: (ev: string, fn: Function) => iface.off(ev, fn),
                removeAllListeners: () => { Object.keys(events).forEach(k => delete events[k]); return iface; },
                close: () => { (events['close'] || []).forEach(f => f()); },
                question: (q: string, cb: Function) => cb(''),
                write: () => {},
                setPrompt: () => {},
                prompt: () => {},
                [Symbol.asyncIterator]: async function*() {},
              };
              return iface;
            },
            Interface: class Interface {},
            emitKeypressEvents: (stream: any) => {
              // ink calls this to enable keypress events on stdin
              // Parse raw input into keypress events, handling ANSI escape sequences
              if (stream && stream.on && !stream._keypressListenerAdded) {
                stream._keypressListenerAdded = true;
                let escBuf = '';
                stream.on('data', (data: any) => {
                  const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
                  let i = 0;
                  while (i < str.length) {
                    const ch = str[i];
                    const code = ch.charCodeAt(0);
                    const key: any = { sequence: '', name: '', ctrl: false, meta: false, shift: false };
                    if (code === 0x1b && i + 1 < str.length) {
                      // Escape sequence
                      const next = str[i + 1];
                      if (next === '[') {
                        // CSI sequence: \x1b[...
                        let seq = '\x1b[';
                        i += 2;
                        while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) { seq += str[i]; i++; }
                        if (i < str.length) { seq += str[i]; i++; }
                        key.sequence = seq;
                        const final = seq[seq.length - 1];
                        const params = seq.slice(2, -1);
                        if (final === 'A') key.name = 'up';
                        else if (final === 'B') key.name = 'down';
                        else if (final === 'C') key.name = 'right';
                        else if (final === 'D') key.name = 'left';
                        else if (final === 'H') key.name = 'home';
                        else if (final === 'F') key.name = 'end';
                        else if (final === 'Z') { key.name = 'tab'; key.shift = true; }
                        else if (final === '~') {
                          if (params === '3') key.name = 'delete';
                          else if (params === '5') key.name = 'pageup';
                          else if (params === '6') key.name = 'pagedown';
                          else if (params === '2') key.name = 'insert';
                          else key.name = 'undefined';
                        }
                        else key.name = 'undefined';
                        if (params.includes(';')) {
                          const mod = parseInt(params.split(';')[1]) - 1;
                          if (mod & 1) key.shift = true;
                          if (mod & 2) key.meta = true;
                          if (mod & 4) key.ctrl = true;
                        }
                      } else if (next === 'O') {
                        // SS3 sequence: \x1bO... (function keys)
                        i += 2;
                        const fk = i < str.length ? str[i++] : '';
                        key.sequence = '\x1bO' + fk;
                        if (fk === 'P') key.name = 'f1';
                        else if (fk === 'Q') key.name = 'f2';
                        else if (fk === 'R') key.name = 'f3';
                        else if (fk === 'S') key.name = 'f4';
                        else key.name = 'undefined';
                      } else {
                        // Alt+key
                        key.sequence = '\x1b' + next;
                        key.name = next.toLowerCase();
                        key.meta = true;
                        i += 2;
                      }
                    } else {
                      key.sequence = ch;
                      i++;
                      if (code === 13) key.name = 'return';
                      else if (code === 10) key.name = 'return';
                      else if (code === 127) key.name = 'backspace';
                      else if (code === 8) key.name = 'backspace';
                      else if (code === 9) key.name = 'tab';
                      else if (code === 32) key.name = 'space';
                      else if (code < 27) { key.name = String.fromCharCode(code + 96); key.ctrl = true; }
                      else key.name = ch.toLowerCase();
                    }
                    stream.emit('keypress', key.sequence, key);
                  }
                });
              }
            },
          };

          case 'readline/promises':
          case 'node:readline/promises': {
            const rlp: any = {
              createInterface: (opts: any) => {
                const events: Record<string, Function[]> = {};
                const iface: any = {
                  on: (ev: string, fn: Function) => { (events[ev] ??= []).push(fn); return iface; },
                  once: (ev: string, fn: Function) => iface.on(ev, fn),
                  off: (ev: string, fn: Function) => { events[ev] = (events[ev] || []).filter(f => f !== fn); return iface; },
                  close: () => { (events['close'] || []).forEach(f => f()); },
                  question: async (_q: string) => '',
                  [Symbol.asyncIterator]: async function*() {},
                };
                return iface;
              },
            };
            return rlp;
          }

          case 'diagnostics_channel':
          case 'node:diagnostics_channel': return {
            channel: (name: string) => ({ subscribe: () => {}, unsubscribe: () => {}, hasSubscribers: false }),
            hasSubscribers: () => false,
            subscribe: () => {},
            unsubscribe: () => {},
            Channel: class Channel { subscribe() {} unsubscribe() {} hasSubscribers = false; },
          };

          case 'v8':
          case 'node:v8': return {
            serialize: (v: any) => new Uint8Array(new TextEncoder().encode(JSON.stringify(v))),
            deserialize: (b: any) => JSON.parse(new TextDecoder().decode(b)),
            getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0 }),
            setFlagsFromString: () => {},
          };

          case 'assert':
          case 'node:assert': {
            const assert: any = (value: any, msg?: string) => { if (!value) throw new Error(msg || 'Assertion failed'); };
            assert.ok = assert;
            assert.equal = (a: any, b: any, msg?: string) => { if (a != b) throw new Error(msg || `${a} != ${b}`); };
            assert.strictEqual = (a: any, b: any, msg?: string) => { if (a !== b) throw new Error(msg || `${a} !== ${b}`); };
            assert.deepEqual = assert.deepStrictEqual = (a: any, b: any, msg?: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || 'Deep equal failed'); };
            assert.notEqual = (a: any, b: any, msg?: string) => { if (a == b) throw new Error(msg || `${a} == ${b}`); };
            assert.notStrictEqual = (a: any, b: any, msg?: string) => { if (a === b) throw new Error(msg || `${a} === ${b}`); };
            assert.throws = (fn: Function, msg?: any) => { try { fn(); throw new Error(typeof msg === 'string' ? msg : 'Expected throw'); } catch(e) { /* ok */ } };
            assert.doesNotThrow = (fn: Function) => { fn(); };
            assert.fail = (msg?: string) => { throw new Error(msg || 'Assert.fail'); };
            assert.AssertionError = class extends Error {};
            return assert;
          }

          case 'http2':
          case 'node:http2': {
            const createSecureClient = () => {
              const ee: any = { on: () => ee, once: () => ee, off: () => ee, emit: () => {}, close: () => {}, destroy: () => {} };
              return ee;
            };
            return {
              connect: createSecureClient,
              createServer: () => createSecureClient(),
              createSecureServer: () => createSecureClient(),
              constants: {
                HTTP2_HEADER_PATH: ':path',
                HTTP2_HEADER_METHOD: ':method',
                HTTP2_HEADER_STATUS: ':status',
                HTTP2_HEADER_CONTENT_TYPE: 'content-type',
                NGHTTP2_CANCEL: 0x8,
              },
            };
          }

          case 'console':
          case 'node:console': {
            return { Console: FakeConsoleClass, default: FakeConsoleClass };
          }

          case 'util/types':
          case 'node:util/types': return (getBuiltinModule('util') as any).types;

          case 'inspector':
          case 'node:inspector': return {
            open: () => {},
            close: () => {},
            url: () => undefined,
            Session: class InspectorSession {
              connect() {}
              disconnect() {}
              post(_method: string, _params: any, cb?: Function) { cb?.(null); }
              on() { return this; }
            },
          };

          default: return null;
        }
      }

      // Express-like framework shim that uses virtual server
      function createExpressShim() {
        const app: any = function(req: any, res: any, next?: any) {
          // Middleware function - pass through
          next?.();
        };

        // app.locals is shared across all requests (like a global store)
        app.locals = {};

        const middlewares: Array<{ path: string; handler: Function }> = [];
        const routes: Array<{ method: string; path: string; handlers: Function[] }> = [];

        // Helper to match Express-style paths
        function matchPath(pattern: string, path: string): Record<string, string> | null {
          // Safety check - ensure both are strings
          if (typeof pattern !== 'string' || typeof path !== 'string') return null;
          if (pattern === '*' || pattern === '/*') return {};

          const patternParts = pattern.split('/').filter(Boolean);
          const pathParts = path.split('/').filter(Boolean);

          if (patternParts.length > pathParts.length) return null;

          const params: Record<string, string> = {};
          for (let i = 0; i < patternParts.length; i++) {
            const pp = patternParts[i];
            if (pp.startsWith(':')) {
              params[pp.slice(1)] = pathParts[i];
            } else if (pp !== pathParts[i]) {
              return null;
            }
          }
          return params;
        }

        // Handle an incoming request
        app._handleRequest = async (vReq: VirtualRequest): Promise<VirtualResponse> => {
          return new Promise((resolve) => {
            let statusCode = 200;
            let responseHeaders: Record<string, string> = {};
            let responseBody = '';
            let ended = false;

            // Parse body if JSON
            let parsedBody = vReq.body;
            try {
              if (vReq.headers['content-type']?.includes('application/json') && vReq.body) {
                parsedBody = JSON.parse(vReq.body);
              }
            } catch {}

            // Build request object
            const req: any = {
              method: vReq.method,
              url: vReq.path,
              path: vReq.path,
              headers: vReq.headers,
              query: vReq.query,
              body: parsedBody,
              params: {},
              get(name: string) { return vReq.headers[name.toLowerCase()]; },
              on(event: string, handler: Function) {
                if (event === 'data' && vReq.body) setTimeout(() => handler(vReq.body), 0);
                if (event === 'end') setTimeout(() => handler(), 0);
                return this;
              },
            };

            // Build response object
            const res: any = {
              statusCode: 200,
              locals: {},
              setHeader(name: string, value: string) { responseHeaders[name.toLowerCase()] = value; return this; },
              getHeader(name: string) { return responseHeaders[name.toLowerCase()]; },
              set(name: string | Record<string, string>, value?: string) {
                if (typeof name === 'object') {
                  for (const [k, v] of Object.entries(name)) responseHeaders[k.toLowerCase()] = v;
                } else {
                  responseHeaders[name.toLowerCase()] = value!;
                }
                return this;
              },
              header(name: string, value: string) { return this.set(name, value); },
              writeHead(code: number, headers?: Record<string, string>) {
                statusCode = code;
                if (headers) for (const [k, v] of Object.entries(headers)) responseHeaders[k.toLowerCase()] = v;
                return this;
              },
              status(code: number) { statusCode = code; return this; },
              sendStatus(code: number) { statusCode = code; this.end(String(code)); },
              write(chunk: string) { responseBody += chunk; return true; },
              end(data?: string) {
                if (ended) return;
                ended = true;
                if (data) responseBody += data;
                resolve({ status: statusCode, headers: responseHeaders, body: responseBody });
              },
              json(data: any) {
                responseHeaders['content-type'] = 'application/json';
                this.end(JSON.stringify(data));
              },
              send(data: any) {
                if (typeof data === 'object') {
                  this.json(data);
                } else {
                  if (!responseHeaders['content-type']) responseHeaders['content-type'] = 'text/html';
                  this.end(String(data));
                }
              },
              redirect(urlOrStatus: string | number, url?: string) {
                const redirectUrl = typeof urlOrStatus === 'string' ? urlOrStatus : url!;
                statusCode = typeof urlOrStatus === 'number' ? urlOrStatus : 302;
                responseHeaders['location'] = redirectUrl;
                // redirect response
                this.end();
              },
              type(t: string) { responseHeaders['content-type'] = t; return this; },
              cookie(name: string, value: string, opts?: any) {
                let cookie = `${name}=${value}`;
                if (opts?.httpOnly) cookie += '; HttpOnly';
                if (opts?.secure) cookie += '; Secure';
                if (opts?.maxAge) cookie += `; Max-Age=${opts.maxAge}`;
                responseHeaders['set-cookie'] = cookie;
                return this;
              },
              clearCookie(name: string) { return this.cookie(name, '', { maxAge: 0 }); },
              async sendFile(filePath: string, options?: any) {
                try {
                  const resolved = ctx.fs.resolvePath(filePath, ctx.cwd);
                  const content = await ctx.fs.readFile(resolved, 'utf8');
                  // Determine content type from extension
                  const ext = filePath.split('.').pop()?.toLowerCase() || '';
                  const mimeTypes: Record<string, string> = {
                    'html': 'text/html',
                    'css': 'text/css',
                    'js': 'application/javascript',
                    'json': 'application/json',
                    'png': 'image/png',
                    'jpg': 'image/jpeg',
                    'jpeg': 'image/jpeg',
                    'gif': 'image/gif',
                    'svg': 'image/svg+xml',
                    'ico': 'image/x-icon',
                  };
                  if (!responseHeaders['content-type']) {
                    responseHeaders['content-type'] = mimeTypes[ext] || 'application/octet-stream';
                  }
                  this.end(content as string);
                } catch (err: any) {
                  statusCode = 404;
                  this.end(`File not found: ${filePath}`);
                }
              },
            };

            // Run middleware chain then routes (with async support)
            let middlewareIndex = 0;
            let lastError: any = null; // Track errors for error handlers
            const runNext = async (err?: any): Promise<void> => {
              if (err) lastError = err;

              // First run global middleware
              while (middlewareIndex < middlewares.length) {
                const mw = middlewares[middlewareIndex++];
                const isErrorHandler = mw.handler.length === 4; // (err, req, res, next)

                // Skip error handlers if no error, skip regular middleware if error
                if (lastError && !isErrorHandler) continue;
                if (!lastError && isErrorHandler) continue;

                const params = matchPath(mw.path, req.path);
                if (params !== null) {
                  req.params = { ...req.params, ...params };
                  try {
                    // Create a promise that resolves when next() is called
                    let nextCalled = false;
                    let nextError: any = null;
                    const nextPromise = new Promise<void>((resolveNext) => {
                      const wrappedNext = (e?: any) => { nextCalled = true; nextError = e; resolveNext(); };
                      // Call with 4 args for error handlers, 3 for regular middleware
                      const result = isErrorHandler
                        ? mw.handler(lastError, req, res, wrappedNext)
                        : mw.handler(req, res, wrappedNext);
                      // If handler returns a Promise, wait for it
                      if (result && typeof result.then === 'function') {
                        result.then(() => {
                          // If response ended or next was called, we're done
                          if (ended || nextCalled) resolveNext();
                        }).catch((e: any) => {
                          nextError = e;
                          resolveNext();
                        });
                      }
                    });
                    await nextPromise;
                    if (ended) return;
                    // Clear error if error handler handled it without passing to next
                    if (isErrorHandler && !nextError) lastError = null;
                    if (nextError) lastError = nextError;
                    if (!nextCalled) return; // Handler didn't call next, stop chain
                  } catch (err: any) {
                    lastError = err;
                    // Continue to find error handler
                  }
                }
              }

              // Then match routes
              for (const route of routes) {
                if (route.method !== req.method && route.method !== 'ALL') continue;
                const params = matchPath(route.path, req.path);
                if (params !== null) {
                  req.params = { ...req.params, ...params };
                  // Run route handlers in sequence with async support
                  for (let i = 0; i < route.handlers.length; i++) {
                    if (ended) return;
                    const handler = route.handlers[i];
                    const isLast = i === route.handlers.length - 1;
                    try {
                      let nextCalled = false;
                      const handlerPromise = new Promise<void>((resolveHandler) => {
                        const nextFn = () => { nextCalled = true; resolveHandler(); };
                        const result = handler(req, res, isLast ? () => {} : nextFn);
                        // If handler returns a Promise, wait for it
                        if (result && typeof result.then === 'function') {
                          result.then(() => resolveHandler()).catch((err: any) => {
                            resolve({ status: 500, body: `Handler error: ${err.message}` });
                          });
                        } else if (isLast || ended) {
                          resolveHandler();
                        }
                      });
                      await handlerPromise;
                      if (ended) return;
                      if (!nextCalled && !isLast) return; // Handler didn't call next
                    } catch (err: any) {
                      resolve({ status: 500, body: `Handler error: ${err.message}` });
                      return;
                    }
                  }
                  return;
                }
              }

              // No route matched
              if (!ended) {
                resolve({ status: 404, body: `Cannot ${req.method} ${req.path}` });
              }
            };

            runNext();
          });
        };

        // Middleware registration
        app.use = (pathOrHandler: string | Function, ...handlers: Function[]) => {
          const path = typeof pathOrHandler === 'string' ? pathOrHandler : '/';
          const fns = typeof pathOrHandler === 'function' ? [pathOrHandler, ...handlers] : handlers;
          for (const fn of fns) {
            middlewares.push({ path, handler: fn });
          }
          return app;
        };

        // Route methods - handles array paths like ["/", "/index.html"]
        const addRoute = (method: string) => (pathOrPaths: string | string[], ...handlers: Function[]) => {
          const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
          for (const path of paths) {
            routes.push({ method, path, handlers });
          }
          return app;
        };
        app.get = addRoute('GET');
        app.post = addRoute('POST');
        app.put = addRoute('PUT');
        app.delete = addRoute('DELETE');
        app.patch = addRoute('PATCH');
        app.options = addRoute('OPTIONS');
        app.head = addRoute('HEAD');
        app.all = addRoute('ALL');

        // Static file serving
        app.static = (root: string) => {
          return async (req: any, res: any, next: Function) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            const filePath = ctx.fs.resolvePath(root + req.path, ctx.cwd);
            try {
              const stat = await ctx.fs.stat(filePath);
              if (!stat || stat.type !== 'file') return next();
              const content = await ctx.fs.readFile(filePath, 'utf8');
              const ext = filePath.split('.').pop() || '';
              const types: Record<string, string> = {
                html: 'text/html', css: 'text/css', js: 'application/javascript',
                json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
                svg: 'image/svg+xml', txt: 'text/plain',
              };
              res.type(types[ext] || 'application/octet-stream');
              res.send(content);
            } catch {
              next();
            }
          };
        };

        // Listen method - keeps running until server is closed (like real Node.js)
        app.listen = (portArg: number | string, hostOrCb?: string | (() => void), cb?: () => void) => {
          // Convert port to number (env vars come in as strings)
          const port = typeof portArg === 'string' ? parseInt(portArg, 10) : portArg;
          const callback = typeof hostOrCb === 'function' ? hostOrCb : cb;
          let closeServer: (() => void) | null = null;

          // This promise keeps the "process" alive until server is closed
          const listenPromise = new Promise<void>((resolve) => {
            // Register with iframe server
            const cleanup = iframeServer.serve(port, app._handleRequest, `express:${port}`);
            closeServer = () => {
              cleanup();
              fakeConsole.log(`Server on port ${port} closed`);
              // Hide iframe container
              const terminal = (ctx.shell as any)._terminal;
              if (terminal && typeof terminal.hideIframeContainer === 'function') {
                terminal.hideIframeContainer();
              }
              resolve();
            };

            fakeConsole.log(`Express app listening on port ${port}`);

            // Show iframe if terminal supports it
            const terminal = (ctx.shell as any)._terminal;
            if (terminal && typeof terminal.getIframeContainer === 'function') {
              const container = terminal.getIframeContainer();
              iframeServer.createIframe(port, container, { height: '300px' })
                .then(() => fakeConsole.log('Browser window opened'))
                .catch((err: Error) => fakeConsole.warn('Could not open browser:', err.message));
            }

            callback?.();
            // Note: promise does NOT resolve here - server keeps running
          });
          pendingPromises.push(listenPromise);

          return { close: () => closeServer?.() };
        };

        // Settings
        const settings: Record<string, any> = {};
        app.set = (key: string, value: any) => { settings[key] = value; return app; };
        app.get = ((pathOrKey: string, ...handlers: Function[]) => {
          if (handlers.length === 0 && !pathOrKey.startsWith('/')) {
            return settings[pathOrKey];
          }
          return addRoute('GET')(pathOrKey, ...handlers);
        }) as any;
        app.enable = (key: string) => { settings[key] = true; return app; };
        app.disable = (key: string) => { settings[key] = false; return app; };
        app.enabled = (key: string) => !!settings[key];
        app.disabled = (key: string) => !settings[key];

        return app;
      }

      // Add static methods to the express factory function (express.json(), express.urlencoded(), etc.)
      (createExpressShim as any).json = () => (req: any, res: any, next: Function) => {
        // Already parsed in _handleRequest
        next();
      };
      (createExpressShim as any).urlencoded = (opts?: any) => (req: any, res: any, next: Function) => {
        if (typeof req.body === 'string' && req.headers['content-type']?.includes('urlencoded')) {
          req.body = Object.fromEntries(new URLSearchParams(req.body));
        }
        next();
      };
      (createExpressShim as any).static = (root: string) => {
        return async (req: any, res: any, next: Function) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next();
          const filePath = ctx.fs.resolvePath(root + req.path, ctx.cwd);
          try {
            const stat = await ctx.fs.stat(filePath);
            if (!stat || stat.type !== 'file') {
              return next();
            }
            const content = await ctx.fs.readFile(filePath, 'utf8');
            const ext = filePath.split('.').pop() || '';
            const types: Record<string, string> = {
              html: 'text/html', css: 'text/css', js: 'application/javascript',
              json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
              svg: 'image/svg+xml', txt: 'text/plain', webmanifest: 'application/manifest+json',
            };
            res.type(types[ext] || 'application/octet-stream');
            res.send(content);
          } catch (err: any) {
            next();
          }
        };
      };
      (createExpressShim as any).raw = (opts?: any) => (req: any, res: any, next: Function) => {
        // Keep body as raw buffer/string
        next();
      };
      (createExpressShim as any).text = (opts?: any) => (req: any, res: any, next: Function) => {
        // Keep body as text string
        next();
      };
      (createExpressShim as any).Router = () => {
        const router: any = (req: any, res: any, next: Function) => {
          // Router acts as middleware - process its own routes/middleware
          const safeNext = next || (() => {});

          // Helper to match paths (simplified)
          const matchPath = (pattern: string, path: string): Record<string, string> | null => {
            // Safety check - ensure both are strings
            if (typeof pattern !== 'string' || typeof path !== 'string') return null;
            if (pattern === '/' || pattern === '*' || pattern === '/*') return {};
            const patternParts = pattern.split('/').filter(Boolean);
            const pathParts = path.split('/').filter(Boolean);
            if (patternParts.length > pathParts.length) return null;
            const params: Record<string, string> = {};
            for (let i = 0; i < patternParts.length; i++) {
              if (patternParts[i].startsWith(':')) {
                params[patternParts[i].slice(1)] = pathParts[i];
              } else if (patternParts[i] !== pathParts[i]) {
                return null;
              }
            }
            return params;
          };

          // Run router middlewares first
          let mwIdx = 0;
          const runRouterNext = () => {
            while (mwIdx < router.middlewares.length) {
              const mw = router.middlewares[mwIdx++];
              const params = matchPath(mw.path, req.path);
              if (params !== null) {
                req.params = { ...req.params, ...params };
                try {
                  mw.handler(req, res, runRouterNext);
                  return;
                } catch (err) {
                  safeNext(err);
                  return;
                }
              }
            }

            // Then match routes
            for (const route of router.routes) {
              if (route.method !== req.method && route.method !== 'ALL') continue;
              const params = matchPath(route.path, req.path);
              if (params !== null) {
                req.params = { ...req.params, ...params };
                let handlerIdx = 0;
                const noop = () => {};
                const runHandler = () => {
                  if (handlerIdx < route.handlers.length) {
                    const handler = route.handlers[handlerIdx++];
                    const nextFn = handlerIdx < route.handlers.length ? runHandler : noop;
                    try {
                      handler(req, res, nextFn);
                    } catch (err) {
                      safeNext(err);
                    }
                  }
                };
                runHandler();
                return;
              }
            }

            // No match in this router - continue to next middleware
            safeNext();
          };
          runRouterNext();
        };
        router.routes = [] as Array<{ method: string; path: string; handlers: Function[] }>;
        router.middlewares = [] as Array<{ path: string; handler: Function }>;
        // Helper to add routes - handles array paths like ["/", "/index.html"]
        const addRouterRoute = (method: string) => (pathOrPaths: string | string[], ...handlers: Function[]) => {
          const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
          for (const path of paths) {
            router.routes.push({ method, path, handlers });
          }
          return router;
        };
        router.get = addRouterRoute('GET');
        router.post = addRouterRoute('POST');
        router.put = addRouterRoute('PUT');
        router.delete = addRouterRoute('DELETE');
        router.patch = addRouterRoute('PATCH');
        router.all = addRouterRoute('ALL');
        router.use = (pathOrHandler: string | Function, ...handlers: Function[]) => {
          if (typeof pathOrHandler === 'function') {
            router.middlewares.push({ path: '/', handler: pathOrHandler });
            handlers.forEach(h => router.middlewares.push({ path: '/', handler: h }));
          } else {
            handlers.forEach(h => router.middlewares.push({ path: pathOrHandler, handler: h }));
          }
          return router;
        };
        return router;
      };

      // Cache for sql.js initialization
      let sqlJsPromise: Promise<any> | null = null;
      const sqliteDatabases = new Map<string, any>(); // path -> sql.js Database

      // better-sqlite3 shim using sql.js
      function createBetterSqlite3Shim() {
        // Load sql.js from CDN - START LOADING IMMEDIATELY when shim is created
        async function loadSqlJs(): Promise<any> {
          if (typeof window === 'undefined') {
            throw new Error('better-sqlite3 shim requires browser environment (sql.js WASM)');
          }

          if (!sqlJsPromise) {
            sqlJsPromise = (async () => {
              try {
                const initSqlJs = (window as any).initSqlJs;
                if (initSqlJs) {
                  const SQL = await initSqlJs({
                    locateFile: (file: string) => `https://sql.js.org/dist/${file}`
                  });
                  return SQL;
                }
                await new Promise<void>((resolve, reject) => {
                  const script = document.createElement('script');
                  script.src = 'https://sql.js.org/dist/sql-wasm.js';
                  script.onload = () => resolve();
                  script.onerror = (e) => reject(e);
                  document.head.appendChild(script);
                });
                const SQL = await (window as any).initSqlJs({
                  locateFile: (file: string) => `https://sql.js.org/dist/${file}`
                });
                return SQL;
              } catch (err) {
                throw err;
              }
            })();
          }
          return sqlJsPromise;
        }

        // START LOADING SQL.JS IMMEDIATELY when shim is created (when require('better-sqlite3') is called)
        // This gives sql.js a head start before any Database is constructed
        const earlyLoadPromise = loadSqlJs();

        // Database class mimicking better-sqlite3
        // NOTE: Methods are async because sql.js requires async initialization
        // Code using this shim should use await with all Database methods
        class Database {
          private db: any = null;
          private dbPath: string;
          private SQL: any = null;
          private initPromise: Promise<void> | null = null;
          private _isReady = false;

          constructor(path: string, options?: any) {
            this.dbPath = ctx.fs.resolvePath(path, ctx.cwd);
            // Start initialization immediately in constructor
            // This allows sql.js loading to happen while other code runs
            this.initPromise = this._init();
          }

          private async _init(): Promise<void> {
            if (this._isReady) return;

            try {
              this.SQL = await earlyLoadPromise;

              if (sqliteDatabases.has(this.dbPath)) {
                this.db = sqliteDatabases.get(this.dbPath);
                this._isReady = true;
                return;
              }

              try {
                const data = await ctx.fs.readFile(this.dbPath);
                if (data instanceof Uint8Array) {
                  this.db = new this.SQL.Database(data);
                } else {
                  this.db = new this.SQL.Database();
                }
              } catch {
                this.db = new this.SQL.Database();
              }

              sqliteDatabases.set(this.dbPath, this.db);
              this._isReady = true;
            } catch (err) {
              throw err;
            }
          }


          // All methods are now async to properly await sql.js initialization
          // This is necessary because sql.js requires WASM loading which is inherently async
          async prepare(sql: string): Promise<Statement> {
            await this.ready;
            return new Statement(this.db, sql);
          }

          async exec(sql: string): Promise<this> {
            await this.ready;
            this.db.run(sql);
            await this._save();
            return this;
          }

          async pragma(pragma: string, options?: any): Promise<any> {
            await this.ready;
            const result = this.db.exec(`PRAGMA ${pragma}`);
            if (result.length === 0) return options?.simple ? undefined : [];
            if (options?.simple) {
              return result[0].values[0]?.[0];
            }
            return result[0].values.map((row: any[]) => {
              const obj: any = {};
              result[0].columns.forEach((col: string, i: number) => {
                obj[col] = row[i];
              });
              return obj;
            });
          }

          transaction<T>(fn: () => T): () => T {
            // Transaction returns a sync function, but the function itself can be async
            return () => {
              // Note: This won't work properly with async - transactions need special handling
              // For now, throw if db not ready
              if (!this._isReady) {
                throw new Error('Database must be initialized before using transactions. Call await db.ready first.');
              }
              this.db.run('BEGIN');
              try {
                const result = fn();
                this.db.run('COMMIT');
                this._save();
                return result;
              } catch (err) {
                this.db.run('ROLLBACK');
                throw err;
              }
            };
          }

          async close(): Promise<void> {
            await this._save();
            if (this.db) {
              this.db.close();
              sqliteDatabases.delete(this.dbPath);
              this.db = null;
            }
          }

          private async _save(): Promise<void> {
            if (!this.db) return;
            const data = this.db.export();
            await ctx.fs.writeFile(this.dbPath, data);
          }

          // Expose the init promise for async usage
          get ready(): Promise<void> {
            if (!this.initPromise) {
              this.initPromise = this._init();
            }
            return this.initPromise;
          }

          // For compatibility - some code checks if db is open
          get open(): boolean {
            return this._isReady && this.db !== null;
          }
        }

        // Statement class mimicking better-sqlite3
        class Statement {
          private db: any;
          private sql: string;

          constructor(db: any, sql: string) {
            this.db = db;
            this.sql = sql;
          }

          run(...params: any[]): { changes: number; lastInsertRowid: number } {
            const flatParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
              ? params[0]  // Named parameters
              : params.flat();

            this.db.run(this.sql, flatParams);

            // Get changes and lastInsertRowid
            const changesResult = this.db.exec('SELECT changes()');
            const lastIdResult = this.db.exec('SELECT last_insert_rowid()');

            return {
              changes: changesResult[0]?.values[0]?.[0] ?? 0,
              lastInsertRowid: lastIdResult[0]?.values[0]?.[0] ?? 0,
            };
          }

          get(...params: any[]): any {
            const flatParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
              ? params[0]
              : params.flat();

            const stmt = this.db.prepare(this.sql);
            stmt.bind(flatParams);

            if (stmt.step()) {
              const columns = stmt.getColumnNames();
              const values = stmt.get();
              stmt.free();

              const row: any = {};
              columns.forEach((col: string, i: number) => {
                row[col] = values[i];
              });
              return row;
            }

            stmt.free();
            return undefined;
          }

          all(...params: any[]): any[] {
            const flatParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
              ? params[0]
              : params.flat();

            const result = this.db.exec(this.sql, flatParams);
            if (result.length === 0) return [];

            const columns = result[0].columns;
            return result[0].values.map((row: any[]) => {
              const obj: any = {};
              columns.forEach((col: string, i: number) => {
                obj[col] = row[i];
              });
              return obj;
            });
          }

          iterate(...params: any[]): IterableIterator<any> {
            const rows = this.all(...params);
            return rows[Symbol.iterator]();
          }

          bind(...params: any[]): this {
            // For chaining - params will be used in next run/get/all
            return this;
          }
        }

        // Return with both CommonJS and ES module compatibility
        // CommonJS: const Database = require('better-sqlite3')
        // ES Module: const { default: Database } = await import('better-sqlite3')
        const module = Database as any;
        module.default = Database;
        return module;
      }

      // Sync require for CommonJS compatibility - returns module directly, not a Promise
      // For modules with top-level await, caller must await the result
      // Auto-stub: for missing properties on builtin modules, return smart stubs
      // This prevents "Class extends undefined" and "Cannot read properties of undefined" errors
      let _autoStubDepth = 0;
      function createAutoStub(modPath: string, target: any): any {
        const stubCache = new Map<string, any>();
        return new Proxy(target, {
          get(t, prop, receiver) {
            if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver);
            _autoStubDepth++;
            if (_autoStubDepth > 500) {
              _autoStubDepth--;
              console.error(`[AutoStub] DEPTH OVERFLOW on ${modPath}.${String(prop)} depth=${_autoStubDepth}`);
              return undefined;
            }
            try {
              const val = Reflect.get(t, prop, receiver);
              if (val !== undefined) return val;
            } finally {
              _autoStubDepth--;
            }
            // Don't stub internal/common props
            if (prop === 'then' || prop === 'toJSON' || prop === '__esModule' || prop === 'default' || prop.startsWith('_')) return undefined;
            // Return cached stub
            if (stubCache.has(prop)) return stubCache.get(prop);
            // Create a stub class/function that can be extended and called
            const stubClass = class StubClass {
              constructor(..._args: any[]) {}
              static [Symbol.hasInstance](_inst: any) { return false; }
            };
            // Make it callable as a function too
            let _stubCallCount = 0;
            const stub: any = function(...args: any[]) {
              _stubCallCount++;
              if (_stubCallCount > 50) return undefined; // Safety bail for infinite recursion
              // For sync functions that return values, return sensible defaults
              if (prop.endsWith('Sync')) return '';
              if (prop === 'constants') return {};
              return stub;
            };
            // Copy class prototype so it works with extends
            Object.setPrototypeOf(stub, stubClass);
            stub.prototype = stubClass.prototype;
            stubCache.set(prop, stub);
            return stub;
          }
        });
      }

      function requireModule(modPath: string, fromDir: string): any {
        const result = _requireModule(modPath, fromDir);
        // For Node.js builtins, wrap in auto-stub Proxy
        if (result && typeof result === 'object' && (modPath.startsWith('node:') || getBuiltinModule(modPath) !== null)) {
          return createAutoStub(modPath, result);
        }
        return result;
      }
      function _requireModule(modPath: string, fromDir: string): any {
        // Check for Express shim
        if (modPath === 'express') {
          return createExpressShim;
        }

        // Check for better-sqlite3 shim
        if (modPath === 'better-sqlite3') {
          return createBetterSqlite3Shim();
        }

        // Check built-in modules first
        const builtin = getBuiltinModule(modPath);
        if (builtin !== null) {
          return builtin;
        }

        let resolved = modPath;

        // Handle Node.js package #imports (subpath imports)
        // e.g., chalk uses `import x from '#ansi-styles'` which maps via package.json "imports"
        if (modPath.startsWith('#')) {
          let lookupDir = fromDir;
          while (lookupDir) {
            const pkgJsonPath = `${lookupDir}/package.json`;
            if (fileCache.has(pkgJsonPath)) {
              try {
                const pkg = JSON.parse(fileCache.get(pkgJsonPath)!);
                if (pkg.imports && pkg.imports[modPath]) {
                  const mapping = pkg.imports[modPath];
                  let target: string | undefined;
                  if (typeof mapping === 'string') {
                    target = mapping;
                  } else if (typeof mapping === 'object') {
                    target = mapping.default || mapping.node || mapping.import || mapping.require;
                  }
                  if (target) {
                    resolved = ctx.fs.resolvePath(target, lookupDir);
                    if (!resolved.endsWith('.js') && !resolved.endsWith('.json')) {
                      if (fileCache.has(resolved + '.js')) resolved += '.js';
                      else if (fileCache.has(resolved + '/index.js')) resolved += '/index.js';
                    }
                    if (moduleCache.has(resolved)) return moduleCache.get(resolved)!.exports;
                    break;
                  }
                }
              } catch { /* ignore parse errors */ }
            }
            const parent = lookupDir.substring(0, lookupDir.lastIndexOf('/')) || '';
            if (parent === lookupDir || !parent) break;
            lookupDir = parent;
          }
        } else if (modPath.startsWith('./') || modPath.startsWith('../') || modPath.startsWith('/')) {
          resolved = ctx.fs.resolvePath(modPath, fromDir);
          if (!resolved.endsWith('.js') && !resolved.endsWith('.json')) {
            if (fileCache.has(resolved + '.js')) resolved += '.js';
            else if (fileCache.has(resolved + '/index.js')) resolved += '/index.js';
          }
        } else {
          // Handle subpath imports like 'semver/functions/coerce'
          // Split into package name and subpath
          const parts = modPath.split('/');
          const isScoped = modPath.startsWith('@');
          const pkgName = isScoped ? parts.slice(0, 2).join('/') : parts[0];
          const subpath = isScoped ? parts.slice(2).join('/') : parts.slice(1).join('/');

          // Walk up directories to find node_modules (npm resolution)
          let searchDir = fromDir.startsWith('/') ? fromDir : ctx.cwd;
          let found = false;
          while (searchDir) {
            let pkgDir = `${searchDir}/node_modules/${pkgName}`;
            let pkgPath = `${pkgDir}/package.json`;

            // Handle npm GitHub tarball extraction which creates nested structure
            // e.g., node_modules/busboy/mscdex-busboy-9aadb7a/package.json
            if (!fileCache.has(pkgPath)) {
              const nestedPkg = [...fileCache.keys()].find(
                k => k.startsWith(pkgDir + '/') && k.endsWith('/package.json') && k.split('/').length === pkgDir.split('/').length + 2
              );
              if (nestedPkg) {
                pkgDir = nestedPkg.replace('/package.json', '');
                pkgPath = nestedPkg;
              }
            }

            if (fileCache.has(pkgPath)) {
              if (subpath) {
                // Subpath import - check exports field first, then look for file directly
                let subpathResolved: string | undefined;
                try {
                  const pkg = JSON.parse(fileCache.get(pkgPath)!);
                  if (pkg.exports) {
                    // Check for subpath in exports: { "./*": "./dist/*.js" } or { "./foo": "./dist/foo.js" }
                    const subpathKey = `./${subpath}`;
                    const exp = pkg.exports[subpathKey];
                    if (exp) {
                      const target = typeof exp === 'string' ? exp
                        : (exp.import || exp.require || exp.default);
                      if (target) {
                        subpathResolved = `${pkgDir}/${target.replace(/^\.\//, '')}`;
                      }
                    } else {
                      // Try wildcard exports: "./*" -> "./dist/*"
                      for (const [key, value] of Object.entries(pkg.exports)) {
                        if (key.includes('*')) {
                          const pattern = key.replace('./', '').replace('*', '(.*)');
                          const regex = new RegExp(`^${pattern}$`);
                          const match = subpath.match(regex);
                          if (match) {
                            const target = typeof value === 'string' ? value
                              : ((value as any).import || (value as any).require || (value as any).default);
                            if (target) {
                              subpathResolved = `${pkgDir}/${target.replace(/^\.\//, '').replace('*', match[1])}`;
                              break;
                            }
                          }
                        }
                      }
                    }
                  }
                } catch { /* ignore parse errors */ }

                if (subpathResolved && fileCache.has(subpathResolved)) {
                  resolved = subpathResolved;
                } else {
                  // Fall back to direct file lookup
                  const subpathFull = `${pkgDir}/${subpath}`;
                  if (fileCache.has(subpathFull + '.js')) {
                    resolved = subpathFull + '.js';
                  } else if (fileCache.has(subpathFull)) {
                    resolved = subpathFull;
                  } else if (fileCache.has(subpathFull + '/index.js')) {
                    resolved = subpathFull + '/index.js';
                  } else {
                    resolved = subpathResolved || subpathFull + '.js'; // Will fail with helpful error
                  }
                }
              } else {
                // Main package import - use package.json exports or main field
                try {
                  const pkg = JSON.parse(fileCache.get(pkgPath)!);
                  let main: string | undefined;

                  // Modern packages use "exports" field
                  if (pkg.exports) {
                    const exp = pkg.exports;
                    // exports can be string, object with "." entry, or conditional exports
                    if (typeof exp === 'string') {
                      main = exp;
                    } else if (exp['.']) {
                      const dotExport = exp['.'];
                      if (typeof dotExport === 'string') {
                        main = dotExport;
                      } else {
                        // Conditional exports: prefer import > require > default > node
                        main = dotExport.import || dotExport.require || dotExport.default || dotExport.node;
                        // Handle nested conditional (e.g., { default: { import: "..." } })
                        if (typeof main === 'object') {
                          main = (main as any).import || (main as any).require || (main as any).default;
                        }
                      }
                    } else if (exp.import || exp.require || exp.default) {
                      main = exp.import || exp.require || exp.default;
                    }
                  }

                  // Fall back to main field or index.js
                  if (!main) {
                    main = pkg.main || pkg.module || 'index.js';
                  }

                  // Ensure main is a string
                  if (typeof main !== 'string') {
                    main = 'index.js';
                  }

                  main = main.replace(/^\.\//, '');
                  // Don't add .js if already has valid extension
                  if (!/\.(js|cjs|mjs|json)$/.test(main)) {
                    // Check if main points to a directory (e.g., chalk@4 "main": "source")
                    const asDir = `${pkgDir}/${main}/index.js`;
                    const asFile = `${pkgDir}/${main}.js`;
                    if (fileCache.has(asDir) && !fileCache.has(asFile)) {
                      main += '/index.js';
                    } else {
                      main += '.js';
                    }
                  }
                  resolved = `${pkgDir}/${main}`;
                } catch {
                  resolved = `${pkgDir}/index.js`;
                }
              }
              found = true;
              break;
            }
            // Also check if package exists without package.json
            if (fileCache.has(`${pkgDir}/index.js`)) {
              if (subpath) {
                const subpathFull = `${pkgDir}/${subpath}`;
                if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
                else if (fileCache.has(subpathFull)) resolved = subpathFull;
                else resolved = subpathFull + '/index.js';
              } else {
                resolved = `${pkgDir}/index.js`;
              }
              found = true;
              break;
            }
            // Move up one directory
            const parent = searchDir.substring(0, searchDir.lastIndexOf('/')) || '';
            if (parent === searchDir || !parent) break;
            searchDir = parent;
          }
          // Also check global node_modules (/usr/local/lib/node_modules)
          if (!found) {
            const globalPkgDir = `/usr/local/lib/node_modules/${pkgName}`;
            const globalPkgPath = `${globalPkgDir}/package.json`;
            if (fileCache.has(globalPkgPath)) {
              if (subpath) {
                const subpathFull = `${globalPkgDir}/${subpath}`;
                if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
                else if (fileCache.has(subpathFull)) resolved = subpathFull;
                else resolved = subpathFull + '/index.js';
              } else {
                try {
                  const pkg = JSON.parse(fileCache.get(globalPkgPath)!);
                  let main: string | undefined;
                  if (pkg.exports) {
                    const exp = pkg.exports;
                    if (typeof exp === 'string') main = exp;
                    else if (exp['.']) {
                      const dotExport = exp['.'];
                      main = typeof dotExport === 'string' ? dotExport
                        : (dotExport.import || dotExport.require || dotExport.default);
                    } else if (exp.import || exp.require || exp.default) {
                      main = exp.import || exp.require || exp.default;
                    }
                  }
                  if (!main) main = pkg.main || pkg.module || 'index.js';
                  if (typeof main !== 'string') main = 'index.js';
                  main = main.replace(/^\.\//, '');
                  if (!/\.(js|cjs|mjs|json)$/.test(main)) {
                    const asDir = `${globalPkgDir}/${main}/index.js`;
                    const asFile = `${globalPkgDir}/${main}.js`;
                    if (fileCache.has(asDir) && !fileCache.has(asFile)) main += '/index.js';
                    else main += '.js';
                  }
                  resolved = `${globalPkgDir}/${main}`;
                } catch {
                  resolved = `${globalPkgDir}/index.js`;
                }
              }
              found = true;
            }
          }
          // Also check from ctx.cwd — scripts in /tmp need to find packages in /home/user/node_modules
          if (!found && ctx.cwd !== fromDir) {
            const cwdPkgDir = `${ctx.cwd}/node_modules/${pkgName}`;
            const cwdPkgPath = `${cwdPkgDir}/package.json`;
            if (fileCache.has(cwdPkgPath)) {
              if (subpath) {
                const subpathFull = `${cwdPkgDir}/${subpath}`;
                if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
                else if (fileCache.has(subpathFull)) resolved = subpathFull;
                else if (fileCache.has(subpathFull + '/index.js')) resolved = subpathFull + '/index.js';
                else resolved = subpathFull + '.js';
              } else {
                try {
                  const pkg = JSON.parse(fileCache.get(cwdPkgPath)!);
                  let main: string | undefined;
                  if (pkg.exports) {
                    const exp = pkg.exports;
                    if (typeof exp === 'string') main = exp;
                    else if (exp['.']) {
                      const dotExport = exp['.'];
                      main = typeof dotExport === 'string' ? dotExport
                        : (dotExport.import || dotExport.require || dotExport.default);
                    } else if (exp.import || exp.require || exp.default) {
                      main = exp.import || exp.require || exp.default;
                    }
                    if (typeof main === 'object') main = (main as any).import || (main as any).require || (main as any).default;
                  }
                  if (!main) main = pkg.main || pkg.module || 'index.js';
                  if (typeof main !== 'string') main = 'index.js';
                  main = main.replace(/^\.\//, '');
                  if (!/\.(js|cjs|mjs|json)$/.test(main)) {
                    const asDir = `${cwdPkgDir}/${main}/index.js`;
                    const asFile = `${cwdPkgDir}/${main}.js`;
                    if (fileCache.has(asDir) && !fileCache.has(asFile)) main += '/index.js';
                    else main += '.js';
                  }
                  resolved = `${cwdPkgDir}/${main}`;
                } catch {
                  resolved = `${cwdPkgDir}/index.js`;
                }
              }
              found = true;
            }
          }
          if (!found) {
            resolved = `${ctx.cwd}/node_modules/${modPath}/index.js`;
          }
        }

        if (moduleCache.has(resolved)) return moduleCache.get(resolved)!.exports;

        const content = fileCache.get(resolved);
        if (content === undefined) {
          // Show helpful debug info
          const nearby = [...fileCache.keys()]
            .filter(k => k.includes(modPath.replace(/^\.\.?\//g, '').replace(/\.js$/, '')))
            .slice(0, 5);
          const hint = nearby.length ? `\nSimilar files in cache: ${nearby.join(', ')}` : '';
          throw new Error(`Cannot find module '${modPath}' (resolved: ${resolved})${hint}`);
        }

        if (resolved.endsWith('.json')) {
          const exp = JSON.parse(content);
          moduleCache.set(resolved, { exports: exp });
          return exp;
        }

        const mod = { exports: {} as any };
        moduleCache.set(resolved, mod);
        const modDir = resolved.substring(0, resolved.lastIndexOf('/')) || ctx.cwd;
        const nestedRequire = (p: string) => requireModule(p, modDir);

        try {
          // Transform ES module syntax to CommonJS
          const transformedContent = transformESModules(content);

          const modImportMeta = {
            url: `file://${resolved}`,
            dirname: modDir,
            filename: resolved,
          };
          const fnParams = [
            'module', 'exports', 'require', '__filename', '__dirname',
            'console', 'process', 'global', 'Buffer', '__import_meta',
          ];
          const fnArgs = [mod, mod.exports, nestedRequire, resolved, modDir,
            fakeConsole, fakeProcess, globalThis, FakeBuffer, modImportMeta];

          // Try synchronous execution first — most npm packages don't use top-level await.
          // This ensures module.exports is populated before require() returns,
          // fixing ESM-only packages like chalk v5 that export via `export default`.
          try {
            const syncFn = new Function(...fnParams, transformedContent);
            syncFn(...fnArgs);
          } catch (syncErr: any) {
            // SyntaxError from top-level `await` → fall back to AsyncFunction
            if (syncErr instanceof SyntaxError && /\bawait\b/.test(transformedContent)) {
              const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
              const wrapped = new AsyncFn(...fnParams, transformedContent);
              const execPromise = wrapped(...fnArgs);
              pendingPromises.push(execPromise.catch((e: any) => {
                if (!(e instanceof ProcessExitError)) {
                  console.error(`Error in module ${resolved}:`, e.message, e.stack?.slice(0, 300));
                  if (processEvents['uncaughtException']?.length) {
                    fakeProcess.emit('uncaughtException', e);
                  }
                }
              }));
            } else {
              throw syncErr;
            }
          }

        } catch (err) {
          moduleCache.delete(resolved);
          const errMsg = err instanceof Error ? err.message : String(err);
          const enhancedErr = new Error(`Error loading module '${resolved}': ${errMsg}`);
          if (err instanceof Error && err.stack) {
            enhancedErr.stack = `Error loading module '${resolved}':\n${err.stack}`;
          }
          throw enhancedErr;
        }

        return mod.exports;
      }

      const fakeRequire = (moduleName: string) => requireModule(moduleName, ctx.cwd);

      // Transform ES module syntax to CommonJS
      // Strip shebang line (#!/usr/bin/env node) — not valid in AsyncFunction
      function stripShebang(src: string): string {
        if (src.startsWith('#!')) {
          const nl = src.indexOf('\n');
          return nl >= 0 ? src.substring(nl + 1) : '';
        }
        return src;
      }

      function transformBundledESM(src: string): string {
        // Fast path for large bundled files (>500KB).
        // Bundled ESM files have thousands of string/template literals.
        // The full regex-based transform introduces quote characters in
        // replacements (e.g. require("mod")) that break enclosing string
        // delimiters, causing SyntaxError: Invalid or unexpected token.
        //
        // This fast path only does safe transforms:
        // - Leading imports at file start (not inside strings)
        // - import.meta → __import_meta (no quotes introduced)
        // - import( → __dynamic_import( (no quotes introduced)
        // - Strip 'export' keyword (no quotes introduced)

        src = stripShebang(src);
        src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');


        // 1. Transform leading import statements at the file start.
        //    In bundled ESM, real imports are at position 0, NOT inside strings.
        let pos = 0;
        const parts: string[] = [];

        // Skip whitespace, semicolons, and comments before/between imports
        function skipNonCode() {
          while (pos < src.length) {
            if (/[\s;]/.test(src[pos])) { parts.push(src[pos]); pos++; continue; }
            // Single-line comment
            if (src[pos] === '/' && pos + 1 < src.length && src[pos + 1] === '/') {
              const nl = src.indexOf('\n', pos);
              const end = nl >= 0 ? nl + 1 : src.length;
              parts.push(src.substring(pos, end));
              pos = end;
              continue;
            }
            // Block comment
            if (src[pos] === '/' && pos + 1 < src.length && src[pos + 1] === '*') {
              const end = src.indexOf('*/', pos + 2);
              const commentEnd = end >= 0 ? end + 2 : src.length;
              parts.push(src.substring(pos, commentEnd));
              pos = commentEnd;
              continue;
            }
            break;
          }
        }
        skipNonCode();

        // Process consecutive import statements
        while (pos < src.length) {
          const rest = src.substring(pos);
          if (!rest.startsWith('import')) break;

          // Don't transform import.meta or import() here — handled globally below
          const afterImport = rest[6];
          if (afterImport === '.' || afterImport === '(') break;

          let matched = false;

          // import { x as y } from "module" (handles minified: import{x}from"m")
          const namedMatch = rest.match(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
          if (namedMatch) {
            const fixed = namedMatch[1].replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
            parts.push(`const {${fixed}} = require("${namedMatch[2]}");`);
            pos += namedMatch[0].length;
            matched = true;
          }

          if (!matched) {
            // import x, { y } from "module"
            const combinedMatch = rest.match(/^import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
            if (combinedMatch) {
              const fixed = combinedMatch[2].replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
              parts.push(`const ${combinedMatch[1]} = require("${combinedMatch[3]}"); const {${fixed}} = require("${combinedMatch[3]}");`);
              pos += combinedMatch[0].length;
              matched = true;
            }
          }

          if (!matched) {
            // import x from "module"
            const defaultMatch = rest.match(/^import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*/);
            if (defaultMatch) {
              parts.push(`const ${defaultMatch[1]} = require("${defaultMatch[2]}");`);
              pos += defaultMatch[0].length;
              matched = true;
            }
          }

          if (!matched) {
            // import * as x from "module"
            const starMatch = rest.match(/^import\s*\*\s*as\s+([\w$]+)\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
            if (starMatch) {
              parts.push(`const ${starMatch[1]} = require("${starMatch[2]}");`);
              pos += starMatch[0].length;
              matched = true;
            }
          }

          if (!matched) {
            // import "module" (side-effect)
            const sideEffectMatch = rest.match(/^import\s+['"]([^'"]+)['"]\s*;?\s*/);
            if (sideEffectMatch) {
              parts.push(`require("${sideEffectMatch[1]}");`);
              pos += sideEffectMatch[0].length;
              matched = true;
            }
          }

          if (!matched) break;
          skipNonCode(); // Skip whitespace/comments between imports
        }

        parts.push(src.substring(pos));
        src = parts.join('');

        // 2. import.meta → __import_meta (safe everywhere, no quotes introduced)
        src = src.replace(/import\.meta/g, '__import_meta');

        // 3. Dynamic import() → __dynamic_import()
        //    Safe: just replaces the keyword with a function name, no quotes.
        src = src.replace(/\bimport\s*\(/g, '__dynamic_import(');

        // 4. Transform remaining static imports globally.
        //    Minified bundles have imports scattered throughout (not just at the top)
        //    for externalized Node.js builtins (fs, path, os, crypto, etc.).
        //    Uses \s* instead of \s+ to handle minified import{x}from"y" patterns.

        // Note: JS identifiers can contain $ (common in minified code: Z$, M$6)
        // so we use [\w$]+ instead of \w+ for identifier matching.

        // import Default, { named } from "module"
        src = src.replace(/\bimport\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\3\s*;?/g,
          (_, defaultName, namedImports, q, mod) => {
            const fixed = namedImports.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
            return `const ${defaultName} = require(${q}${mod}${q}); const {${fixed}} = require(${q}${mod}${q});`;
          });

        // import { x as y } from "module"  (handles minified: import{x}from"m")
        src = src.replace(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
          (_, imports, q, mod) => {
            const fixed = imports.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
            return `const {${fixed}} = require(${q}${mod}${q});`;
          });

        // import x from "module"
        src = src.replace(/\bimport\s+([\w$]+)\s+from\s*(['"])([^'"]+)\2\s*;?/g,
          (_, name, q, mod) => `const ${name} = require(${q}${mod}${q});`);

        // import * as x from "module"  (handles minified: import*as x from"m")
        src = src.replace(/\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
          (_, name, q, mod) => `const ${name} = require(${q}${mod}${q});`);

        // import "module" (side-effect only)
        src = src.replace(/\bimport\s*(['"])([^'"]+)\1\s*;?/g,
          (_, q, mod) => `require(${q}${mod}${q});`);

        // 5. Strip 'export' keyword from declarations (safe, no quotes introduced).
        src = src.replace(/\bexport\s+default\s+/g, 'module.exports = ');
        src = src.replace(/\bexport\s+async\s+function\s+/g, 'async function ');
        src = src.replace(/\bexport\s+function\s+/g, 'function ');
        src = src.replace(/\bexport\s+class\s+/g, 'class ');
        src = src.replace(/\bexport\s+(const|let|var)\s+/g, '$1 ');

        // 6. Handle export { x as y } and export { x } from "y" patterns
        //    These appear in minified bundles as export{x as y} or export{x}from"y"
        src = src.replace(/\bexport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
          (_, exports, q, mod) => {
            const items = exports.split(',').map((s: string) => s.trim()).filter((s: string) => s);
            return items.map((item: string) => {
              const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
              if (asMatch) return `module.exports.${asMatch[2]} = require(${q}${mod}${q}).${asMatch[1]};`;
              return `module.exports.${item} = require(${q}${mod}${q}).${item};`;
            }).join(' ');
          });

        // export * as name from "module"
        src = src.replace(/\bexport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
          (_, name, q, mod) => `module.exports.${name} = require(${q}${mod}${q});`);

        // export * from "module"
        src = src.replace(/\bexport\s*\*\s*from\s*(['"])([^'"]+)\1\s*;?/g,
          (_, q, mod) => `Object.assign(module.exports, require(${q}${mod}${q}));`);

        // export { x as y } (local re-exports, no from)
        src = src.replace(/\bexport\s*\{([^}]+)\}\s*;?/g, (_, exports) => {
          const items = exports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^[\w$]/.test(s));
          return items.map((item: string) => {
            const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
            if (asMatch) return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
            return `module.exports.${item} = ${item};`;
          }).join(' ');
        });

        // 7. Remove TypeScript type-only imports/exports
        src = src.replace(/\bimport\s+type\s+[^;]+;?/g, '/* import type */');
        src = src.replace(/\bexport\s+type\s+/g, '/* export type */ ');

        // 8. Patch lazy module factory to handle initialization failures gracefully.
        //    The bundled code uses R=(A,q)=>()=>(q||A((q={exports:{}}).exports,q),q.exports)
        //    as a lazy CJS module factory. If factory A throws (missing Node.js API), subsequent
        //    code accessing exports gets {}. We wrap in try-catch and auto-stub missing properties
        //    so that `class X extends FailedModule.SomeClass` doesn't crash.
        const rOld = 'R=(A,q)=>()=>(q||A((q={exports:{}}).exports,q),q.exports)';
        const rNew = 'R=(A,q)=>()=>{if(!q){q={exports:{}};try{A(q.exports,q)}catch(e){if(e&&e._isProcessExit)throw e;q.exports=__stubProxy(q.exports)}}return q.exports}';
        if (src.includes(rOld)) {
          src = src.replace(rOld, rNew);
          // Inject __stubProxy helper and Node.js-compatible setTimeout/setInterval at the very start
          src = [
            'function __stubProxy(o){return new Proxy(o,{get(t,p,r){if(typeof p==="symbol"||p in t)return Reflect.get(t,p,r);var _s=function(){};_s.prototype={};_s.default=_s;t[p]=_s;return _s}})}',
            // Hide browser globals from SDK browser detection (typeof window/navigator checks)
            // Must be void 0 so typeof navigator === "undefined" — SDK and CLI both guard with typeof before access
            'var navigator=void 0;',
            // Override setTimeout/setInterval to return Timer-like objects with .unref()/.ref()
            'var _origSetTimeout=setTimeout,_origSetInterval=setInterval,_origClearTimeout=clearTimeout,_origClearInterval=clearInterval;',
            'function _wrapTimer(id){return{_id:id,ref(){return this},unref(){return this},hasRef(){return true},refresh(){return this},[Symbol.toPrimitive](){return id}}}',
            'setTimeout=function(fn,ms,...args){return _wrapTimer(_origSetTimeout(fn,ms,...args))};',
            'setInterval=function(fn,ms,...args){return _wrapTimer(_origSetInterval(fn,ms,...args))};',
            'clearTimeout=function(t){_origClearTimeout(t&&t._id!==void 0?t._id:t)};',
            'clearInterval=function(t){_origClearInterval(t&&t._id!==void 0?t._id:t)};',
            // Suppress unhandled rejections from ProcessExitError and CLI's "unreachable" throws
            'if(typeof globalThis.addEventListener==="function"){var _rejHandler=function(e){if(e&&e.reason&&(e.reason._isProcessExit||e.reason==="unreachable"||e.reason.message==="unreachable"))e.preventDefault()};globalThis.addEventListener("unhandledrejection",_rejHandler)}',
          ].join('\n') + '\n' + src;
        }

        // Patch lazy side-effect runner: v=(A,q)=>()=>(A&&(q=A(A=0)),q)
        // If the side-effect factory throws, cache undefined rather than re-throwing on every access.
        const vOld = 'v=(A,q)=>()=>(A&&(q=A(A=0)),q)';
        const vNew = 'v=(A,q)=>()=>{try{A&&(q=A(A=0))}catch(e){if(e&&e._isProcessExit)throw e;if(!q)q=__stubProxy({})}return q}';
        if (src.includes(vOld)) {
          src = src.replace(vOld, vNew);
        }

        // 9. Detect trailing unawaited async function call (e.g., `cMz();`)
        // In real Node.js, the event loop keeps running. In our AsyncFunction, we need to await it.
        src = src.replace(/([\w$]+)\(\)\s*;?\s*$/, 'await $1();');

        return src;
      }

      function transformESModules(src: string): string {
        // Fast path for large bundled files (>500KB)
        if (src.length > 500000) {
          return transformBundledESM(src);
        }

        src = stripShebang(src);
        // Normalize line endings to LF
        src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Preserve block comments to avoid transforming export/import keywords inside them
        // Note: We don't preserve line comments (//) as they can appear in strings (URLs)
        const comments: string[] = [];
        src = src.replace(/\/\*[\s\S]*?\*\//g, (match) => {
          comments.push(match);
          return `___COMMENT_${comments.length - 1}___`;
        });

        // Dynamic import() → Promise.resolve(require()) - must be before other import transforms
        // Handles: await import("./path") or import("./path").then(...)
        src = src.replace(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, 'Promise.resolve(require($1$2$1))');

        // import.meta → __import_meta (must be before import statement transforms)
        src = src.replace(/import\.meta/g, '__import_meta');

        // import Default, { named } from 'y' → combined default + named import
        src = src.replace(/import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          (_, defaultName, namedImports, mod) => {
            const cleanImports = namedImports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const fixed = cleanImports.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
            return `const ${defaultName} = require("${mod}"); const {${fixed}} = require("${mod}");`;
          });

        // import x from 'y' → const x = require('y')
        src = src.replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          'const $1 = require("$2");');

        // import { a, b } from 'y' → const { a, b } = require('y')
        // Also handles: import { a as b } → const { a: b }
        src = src.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          (_, imports, mod) => {
            // Strip comments and fix 'as' syntax
            const cleanImports = imports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const fixed = cleanImports.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
            return `const {${fixed}} = require("${mod}");`;
          });

        // import * as x from 'y' → const x = require('y')
        src = src.replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          'const $1 = require("$2");');

        // import 'y' → require('y')
        src = src.replace(/import\s+['"]([^'"]+)['"]\s*;?/g,
          'require("$1");');

        // export default x → module.exports = x
        src = src.replace(/export\s+default\s+/g, 'module.exports = ');

        // export { x, y } from 'z' or export { x as y } from 'z' (handles multiline and comments)
        // Note: \s* allows no space between export and { (e.g., export{x})
        src = src.replace(/export\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          (_, exports, mod) => {
            // Strip comments from exports
            const cleanExports = exports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const items = cleanExports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
            const assigns = items.map((item: string) => {
              const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
              if (asMatch) {
                return `module.exports.${asMatch[2]} = require("${mod}").${asMatch[1]};`;
              }
              return `module.exports.${item} = require("${mod}").${item};`;
            }).join(' ');
            return assigns;
          });

        // export * as name from 'z' → module.exports.name = require('z')
        src = src.replace(/export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          'module.exports.$1 = require("$2");');

        // export * from 'z' → Object.assign(module.exports, require('z'))
        src = src.replace(/export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          'Object.assign(module.exports, require("$1"));');

        // export { x, y } or export { x as y } → module.exports.x = x; module.exports.y = y;
        // Note: \s* allows no space between export and { (e.g., export{x as y})
        src = src.replace(/export\s*\{([^}]+)\}\s*;?/g, (_, exports) => {
          // Strip comments and parse exports like "x, y as z, foo"
          const cleanExports = exports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
          const items = cleanExports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
          return items.map((item: string) => {
            const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
            if (asMatch) {
              // export { local as exported }
              return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
            }
            // export { x }
            return `module.exports.${item} = ${item};`;
          }).join(' ');
        });

        // Track named exports to add module.exports at the end
        const namedExports: string[] = [];

        // export const/let/var x = ... → const x = ...; (track x)
        src = src.replace(/export\s+(const|let|var)\s+(\w+)\s*=/g, (_, decl, name) => {
          namedExports.push(name);
          return `${decl} ${name} =`;
        });

        // export var/let x; (declaration without initialization) → var x; (track x)
        src = src.replace(/export\s+(var|let)\s+(\w+)\s*;/g, (_, decl, name) => {
          namedExports.push(name);
          return `${decl} ${name};`;
        });

        // export function name() → function name(); (track name)
        src = src.replace(/export\s+function\s+(\w+)/g, (_, name) => {
          namedExports.push(name);
          return `function ${name}`;
        });

        // export class Name → class Name; (track Name)
        src = src.replace(/export\s+class\s+(\w+)/g, (_, name) => {
          namedExports.push(name);
          return `class ${name}`;
        });

        // export async function name() → async function name(); (track name)
        src = src.replace(/export\s+async\s+function\s+(\w+)/g, (_, name) => {
          namedExports.push(name);
          return `async function ${name}`;
        });

        // Add module.exports for all tracked named exports at the end
        if (namedExports.length > 0) {
          src += '\n' + namedExports.map(n => `module.exports.${n} = ${n};`).join('\n');
        }

        // Remove __filename/__dirname/Buffer declarations (we provide these as parameters)
        // Handles: const __filename = fileURLToPath(import.meta.url);
        //          const __dirname = dirname(__filename);
        //          const Buffer = require('buffer').Buffer;
        src = src.replace(/(?:const|let|var)\s+__filename\s*=\s*[^;]+;?/g, '/* __filename provided */');
        src = src.replace(/(?:const|let|var)\s+__dirname\s*=\s*[^;]+;?/g, '/* __dirname provided */');
        // Handle: const Buffer = require('buffer').Buffer; or var Buffer = ...
        // Use [^;,]+ to stop at comma (multi-line declarations) or semicolon
        src = src.replace(/(?:const|let|var)\s+Buffer\s*=\s*[^;,]+;/g, '/* Buffer provided */');
        // Handle multi-line: var Buffer = ...,\n    OtherVar = ...; -> var OtherVar = ...;
        src = src.replace(/(const|let|var)\s+Buffer\s*=\s*[^,]+,\s*/g, '$1 ');
        // Handle: const { Buffer } = require('buffer'); (destructuring)
        src = src.replace(/(?:const|let|var)\s*\{\s*Buffer\s*\}\s*=\s*[^;]+;/g, '/* Buffer provided */');
        // Handle: const { Buffer, ... } = require('buffer'); (Buffer in destructuring with others)
        src = src.replace(/(\{\s*)Buffer(\s*,)/g, '$1/* Buffer */$2');
        src = src.replace(/(,\s*)Buffer(\s*\})/g, '$1/* Buffer */$2');
        src = src.replace(/(,\s*)Buffer(\s*,)/g, '$1/* Buffer */$2');

        // Catch-all: remove any remaining export keywords that weren't handled
        // This handles edge cases like TypeScript 'export type' that might slip through
        src = src.replace(/\bexport\s+type\s+/g, '/* export type */ ');
        src = src.replace(/\bimport\s+type\s+[^;]+;?/g, '/* import type */');

        // Final safety: if any export/import statements remain, handle them aggressively
        // This prevents "Unexpected token 'export'" errors

        // Catch any remaining export { name } patterns (including no-space like export{x})
        while (/\bexport\s*\{/.test(src)) {
          src = src.replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (_, names) => {
            const cleanNames = names.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const items = cleanNames.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
            return items.map((item: string) => {
              const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
              if (asMatch) return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
              return `module.exports.${item} = ${item};`;
            }).join(' ');
          });
        }

        // Note: We removed aggressive catch-all transforms for import/export
        // as they were corrupting URLs in strings (//example.com) and other code.
        // If ES module syntax slips through, we'll get a clear "Unexpected token" error.

        // Restore preserved comments
        src = src.replace(/___COMMENT_(\d+)___/g, (_, idx) => comments[parseInt(idx)]);

        // Note: trailing await transform is in transformBundledESM, not here

        return src;
      }

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      // Transform ES modules and wrap for execution
      let transformedCode = transformESModules(code);

      // Stash real browser console on globalThis so injected code can use it
      // (inside the AsyncFunction, `console` is the fakeConsole)
      if (code.length > 500000) {
        (globalThis as any).__realConsole = console;

      }

      const wrappedCode = printResult ? `return (${transformedCode})` : transformedCode;
      const fn = new AsyncFunction(
        'console', 'process', 'require', 'Buffer', '__filename', '__dirname', 'shiro', '__import_meta', 'module', 'exports', '__dynamic_import',
        wrappedCode
      );

      // Fake import.meta for ES modules
      const entryFilename = scriptPath || ctx.cwd + '/repl.js';
      const entryDirname = scriptPath ? scriptPath.substring(0, scriptPath.lastIndexOf('/')) : ctx.cwd;
      const fakeImportMeta = {
        url: `file://${entryFilename}`,
        dirname: entryDirname,
        filename: entryFilename,
        resolve: (specifier: string) => {
          if (specifier.startsWith('./') || specifier.startsWith('../')) {
            return `file://${ctx.fs.resolvePath(specifier, entryDirname)}`;
          }
          return specifier;
        },
      };

      // Create module/exports for CommonJS compatibility
      const fakeModule: { exports: any } = { exports: {} };
      const fakeExports = fakeModule.exports;

      // Create require function for the entry script - must use entryDirname, not ctx.cwd
      const entryRequire = (moduleName: string) => requireModule(moduleName, entryDirname);

      // Dynamic import() shim — used by transformBundledESM's import( → __dynamic_import( transform
      const dynamicImport = async (moduleName: string) => {
        try {
          return requireModule(moduleName, entryDirname);
        } catch (e: any) {
          const msg = e?.message || String(e);
          throw new Error(`Failed to dynamically import '${moduleName}': ${msg}`);
        }
      };

      let result;

      if (typeof window !== 'undefined') {
        window.addEventListener('unhandledrejection', suppressRejection);
      }

      // Intercept globalThis.fetch and XMLHttpRequest to route external API
      // requests through the CORS proxy. The CLI's telemetry/statsig/auth endpoints
      // bypass ANTHROPIC_BASE_URL and go directly to these hosts.
      const corsProxyOrigin = typeof window !== 'undefined' ? window.location.origin : '';
      const corsProxyMap: [string, string][] = [
        ['https://api.anthropic.com/', '/api/anthropic/'],
        ['https://platform.claude.com/', '/api/platform/'],
        ['https://mcp-proxy.anthropic.com/', '/api/mcp-proxy/'],
      ];
      const rewriteUrl = (u: string): string => {
        for (const [prefix, proxy] of corsProxyMap) {
          if (u.startsWith(prefix)) return corsProxyOrigin + proxy + u.slice(prefix.length);
        }
        return u;
      };
      // Block telemetry/analytics URLs that cause CORS errors
      const blockedUrls = [
        'datadoghq.com', 'sentry.io', '/api/event_logging',
        'claude_code_first_token_date', 'claude_code_grove',
      ];
      const isBlocked = (u: string) => blockedUrls.some(b => u.includes(b));

      if (corsProxyOrigin) {
        globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
          let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (isBlocked(url)) return Promise.resolve(new Response('{}', { status: 200 }));
          // Route localhost/127.0.0.1 requests through virtual iframe servers
          const localhostMatch = url.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/.*)?$/);
          if (localhostMatch) {
            const port = parseInt(localhostMatch[1] || '80');
            const path = localhostMatch[2] || '/';
            if (iframeServer.isPortInUse(port)) {
              return iframeServer.fetch(port, path, {
                method: init?.method || 'GET',
                headers: (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers))
                  ? init.headers as Record<string, string> : {},
                body: typeof init?.body === 'string' ? init.body : null,
              }).then(vResp => new Response(
                typeof vResp.body === 'string' ? vResp.body
                  : vResp.body instanceof Uint8Array ? new TextDecoder().decode(vResp.body)
                  : JSON.stringify(vResp.body ?? ''),
                { status: vResp.status || 200, statusText: vResp.statusText || 'OK', headers: vResp.headers || {} },
              ));
            }
          }
          const rewritten = rewriteUrl(url);
          if (rewritten !== url) {
            if (typeof input === 'string') input = rewritten;
            else if (input instanceof URL) input = new URL(rewritten);
            else input = new Request(rewritten, input);
          }
          // Track SSE stream lifecycle for /v1/messages to debug streaming hangs
          const isMessages = url.includes('/v1/messages');
          if (isMessages) {
            const t0 = Date.now();
            return _origFetch(input, init).then(resp => {
              const ct = resp.headers.get('content-type') || '';
              const isSSE = ct.includes('text/event-stream');
              console.log(`[fetch] /v1/messages ${resp.status} ${ct.split(';')[0]} (${Date.now() - t0}ms)`);
              if (isSSE && resp.body) {
                // Wrap the ReadableStream to log when it ends
                const origBody = resp.body;
                const reader = origBody.getReader();
                let totalBytes = 0;
                const wrappedStream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      console.log(`[fetch] SSE stream ended (${totalBytes} bytes, ${Date.now() - t0}ms total)`);
                      controller.close();
                      return;
                    }
                    totalBytes += value.byteLength;
                    controller.enqueue(value);
                  },
                  cancel() { reader.cancel(); }
                });
                return new Response(wrappedStream, {
                  status: resp.status,
                  statusText: resp.statusText,
                  headers: resp.headers,
                });
              }
              return resp;
            });
          }
          return _origFetch(input, init);
        };
        // Patch XMLHttpRequest prototype directly — more robust than replacing the
        // constructor, as it catches ALL XHR instances regardless of how they were
        // created (cached references, subclasses, etc.).
        if (_origXHR && !(XMLHttpRequest.prototype as any)._shiroProxied) {
          const unsafeHeaders = new Set(['user-agent','host','content-length','connection','accept-encoding','accept-charset','referer','origin','cookie','te','upgrade','via','transfer-encoding','proxy-authorization','proxy-connection','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user']);
          const origOpen = XMLHttpRequest.prototype.open;
          const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
            const u = typeof url === 'string' ? url : url.toString();
            if (isBlocked(u)) { (this as any)._blocked = true; return; }
            // Route localhost/127.0.0.1 through virtual iframe servers
            const lhm = u.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/.*)?$/);
            if (lhm && iframeServer.isPortInUse(parseInt(lhm[1] || '80'))) {
              (this as any)._localhost = { port: parseInt(lhm[1] || '80'), path: lhm[2] || '/', method };
              return;
            }
            return origOpen.call(this, method, rewriteUrl(u), ...(rest as [boolean, string?, string?]));
          } as any;
          XMLHttpRequest.prototype.setRequestHeader = function(this: XMLHttpRequest, name: string, value: string) {
            if ((this as any)._blocked) return;
            if (unsafeHeaders.has(name.toLowerCase())) return;
            return origSetHeader.call(this, name, value);
          };
          XMLHttpRequest.prototype.send = function(this: XMLHttpRequest, body?: any) {
            if ((this as any)._blocked || (this as any)._localhost) {
              const isLocalhost = !!(this as any)._localhost;
              const respondWith = (status: number, statusText: string, responseText: string) => {
                Object.defineProperty(this, 'status', { value: status });
                Object.defineProperty(this, 'statusText', { value: statusText });
                Object.defineProperty(this, 'responseText', { value: responseText });
                Object.defineProperty(this, 'response', { value: responseText });
                Object.defineProperty(this, 'readyState', { value: 4 });
                Object.defineProperty(this, 'responseURL', { value: '' });
                setTimeout(() => {
                  const rsEvt = new Event('readystatechange');
                  if (typeof (this as any).onreadystatechange === 'function') (this as any).onreadystatechange(rsEvt);
                  try { this.dispatchEvent(rsEvt); } catch {}
                  const loadEvt = new ProgressEvent('load');
                  if (typeof (this as any).onload === 'function') (this as any).onload(loadEvt);
                  try { this.dispatchEvent(loadEvt); } catch {}
                  const endEvt = new ProgressEvent('loadend');
                  if (typeof (this as any).onloadend === 'function') (this as any).onloadend(endEvt);
                  try { this.dispatchEvent(endEvt); } catch {}
                }, 0);
              };
              if (isLocalhost) {
                const { port, path, method } = (this as any)._localhost;
                iframeServer.fetch(port, path, { method, body: typeof body === 'string' ? body : null })
                  .then(vResp => {
                    const text = typeof vResp.body === 'string' ? vResp.body
                      : vResp.body instanceof Uint8Array ? new TextDecoder().decode(vResp.body)
                      : JSON.stringify(vResp.body ?? '');
                    respondWith(vResp.status || 200, vResp.statusText || 'OK', text);
                  })
                  .catch(() => respondWith(500, 'Internal Server Error', ''));
              } else {
                respondWith(200, 'OK', '{}');
              }
              return;
            }
            return origSend.call(this, body);
          };
          (XMLHttpRequest.prototype as any)._shiroProxied = true;
        }
      }

      // Polyfill setImmediate/clearImmediate (Node.js globals not available in browsers)
      const _origSetImmediate = (globalThis as any).setImmediate;
      const _origClearImmediate = (globalThis as any).clearImmediate;
      (globalThis as any).setImmediate = (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args);
      (globalThis as any).clearImmediate = (id: any) => clearTimeout(id);

      // Track active timers so scripts using setTimeout get their callbacks before exit.
      let _activeTimers = 0;
      let _timersResolve: (() => void) | null = null;
      let _timersDone: Promise<void> | null = null;
      const _timerIds = new Set<any>();
      // Only wrap for regular scripts — CLI bundle already wraps timers internally
      if (code.length <= 500000) {
        globalThis.setTimeout = function(fn: any, ms?: number, ...args: any[]) {
          _activeTimers++;
          if (!_timersDone) _timersDone = new Promise(r => { _timersResolve = r; });
          const id = _prevST(() => {
            _timerIds.delete(id);
            try { if (typeof fn === 'function') fn(...args); }
            finally {
              _activeTimers--;
              if (_activeTimers <= 0 && _timersResolve) { _timersResolve(); _timersResolve = null; _timersDone = null; }
            }
          }, ms);
          _timerIds.add(id);
          return id;
        } as typeof setTimeout;
        globalThis.clearTimeout = function(id: any) {
          if (_timerIds.delete(id)) {
            _activeTimers--;
            if (_activeTimers <= 0 && _timersResolve) { _timersResolve(); _timersResolve = null; _timersDone = null; }
          }
          _prevCT(id);
        };
      }

      // Wrap WebAssembly.instantiate to gracefully handle unsupported WASM binaries.
      // Tree-sitter's emscripten code calls abort() on CompileError, which throws a
      // RuntimeError("Aborted(...)") that breaks async init chains. By catching
      // CompileError at the WebAssembly level, tree-sitter's createWasm returns null
      // and the parser gracefully degrades (no syntax highlighting).
      // Tree-sitter WASM uses features not supported in all browsers (unknown section
      // codes, dylink sections). We don't intercept WebAssembly.instantiate/compile —
      // tree-sitter's own error handler calls abort(), which throws RuntimeError("Aborted(...)"),
      // and our suppressRejection handler catches that pattern above.

      // Timeout for the main script execution. If the script's main function hangs
      // (e.g., CLI async setup), this kills it. The deferred exit wait (below) handles
      // scripts that return quickly but have async work (like streaming API responses).
      const SCRIPT_TIMEOUT = 15000;
      let scriptTimedOut = false;
      const timeoutPromise = new Promise<never>((_, reject) => {
        scriptTimeoutId = setTimeout(() => {
          scriptTimedOut = true;
          reject(new ProcessExitError(124));
        }, SCRIPT_TIMEOUT);
      });

      try {
        result = await Promise.race([
          fn(fakeConsole, fakeProcess, entryRequire, FakeBuffer, entryFilename, entryDirname, {
            fs: ctx.fs,
            shell: ctx.shell,
            env: ctx.env,
            cwd: ctx.cwd,
          }, fakeImportMeta, fakeModule, fakeExports, dynamicImport),
          timeoutPromise,
        ]);
      } catch (e: any) {
        if (e instanceof ProcessExitError) {
          exitCode = e.code;
        } else if (e.message?.includes('extends value') || e.message?.includes('is not a constructor') || e.message?.includes('prototype')) {
          stderrBuf.push(e.message);
          exitCode = 1;
        } else {
          throw e;
        }
      }

      // Clean up SCRIPT_TIMEOUT if it hasn't fired — prevents leaked timer/rejection
      if (scriptTimeoutId) { clearTimeout(scriptTimeoutId); scriptTimeoutId = null; }

      // Wait for any pending async operations (like app.listen())
      // Loop because new promises may be added during module execution (e.g., app.listen in top-level await)
      while (pendingPromises.length > 0) {
        const current = [...pendingPromises]; // Snapshot current promises
        pendingPromises.length = 0; // Clear array so new ones can be detected
        await Promise.all(current);
      }

      // Wait for pending timers (setTimeout callbacks) to fire — max 5s
      // Skip when interactive mode is active — setRawMode(false) schedules a 500ms timer
      // that must fire during the deferred exit wait, not here (otherwise it prematurely
      // sets exitCalled=true, causing the deferred exit to create a fresh unresolvable promise).
      if (_activeTimers > 0 && _timersDone && !isInteractiveMode) {
        try {
          await Promise.race([_timersDone, new Promise((_, rej) => _prevST(() => rej('timer-wait-timeout'), 5000))]);
        } catch { /* timeout is fine */ }
      }

      // Restore original setTimeout/clearTimeout BEFORE deferred exit check.
      // The deferred exit creates its own setTimeout (for timeout); if still wrapped,
      // timer tracking would interfere with interactive mode's setRawMode(false) flow.
      if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }

      // If the script returned without calling process.exit AND produced no visible output,
      // there may be unawaited async work (e.g., CLI print mode fires Hvq without await).
      // Wait for process.exit to be called or timeout.
      // Skip for: scripts that produced output (--version), printResult mode (always has result),
      // scripts that already exited, streamed to terminal, or wrote to stderr.
      const hasFinishedOutput = exitCalled || scriptTimedOut
        || stdoutBuf.length > 0 || stderrBuf.length > 0 || streamedToTerminal
        || printResult;
      if (isInteractiveMode || !hasFinishedOutput) {
        // Longer timeout for deferred wait — allows streaming API responses to complete
        // Interactive mode (ink) gets 24h; large bundles (CLI) get 5min; regular scripts get 10s
        // Regular scripts (node -e, small files) rarely need deferred exit — 10s catches
        // legitimate async work while preventing 5-minute hangs for simple read/write scripts.
        const DEFERRED_TIMEOUT = isInteractiveMode ? 86400000 : code.length > 500000 ? 300000 : 10000;
        const deferredTimeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new ProcessExitError(124)), DEFERRED_TIMEOUT);
        });
        // Create a FRESH deferred promise — the original may already be resolved if
        // process.exit was called during initialization (e.g., background workers).
        // We want to wait for a NEW process.exit call (user quitting the interactive app).
        let freshExitPromise = deferredExitPromise;
        if (exitCalled && isInteractiveMode) {
          freshExitPromise = new Promise<number>(resolve => {
            deferredExitResolve = resolve;
          });
          // Reset exitCalled so future process.exit calls will resolve the fresh promise
          exitCalled = false;
        }
        try {
          const waitCode = await Promise.race([freshExitPromise, deferredTimeout]);
          exitCode = waitCode;
        } catch (e: any) {
          if (e instanceof ProcessExitError) {
            exitCode = e.code;
          }
          // Timeout is fine — just means the async work finished without process.exit
        }
      }

      // Flush output to ctx.stdout so callers (child_process.exec, pipes) can capture it
      if (stdoutBuf.length > 0) {
        ctx.stdout += stdoutBuf.join('\n') + '\n';
      }
      if (stderrBuf.length > 0) {
        ctx.stderr += stderrBuf.join('\n') + '\n';
      }

      if (printResult && !exitCalled) {
        ctx.stdout += formatArg(result) + '\n';
      }

      // Clean up stdin passthrough when script exits — but ONLY if this invocation
      // set it up. Nested node/exec calls (e.g., CLI's Bash tool running `node script.js`)
      // share the same terminal reference and would otherwise clear the outer CLI's passthrough.
      if (ctx.terminal && _ownsStdinPassthrough) ctx.terminal.exitStdinPassthrough();

      // Deferred cleanup of rejection handler — CLI force-exit callbacks fire after fn() returns
      if (typeof window !== 'undefined') {
        setTimeout(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000);
      }
      // Restore original fetch/globals (XHR prototype patch is idempotent, no restore needed)
      globalThis.fetch = _origFetch;
      if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }
      if (_origSetImmediate) (globalThis as any).setImmediate = _origSetImmediate; else delete (globalThis as any).setImmediate;
      if (_origClearImmediate) (globalThis as any).clearImmediate = _origClearImmediate; else delete (globalThis as any).clearImmediate;

      return exitCode;
    } catch (e: any) {
      // Clean up stdin passthrough on error — only if this invocation owns it
      if (ctx.terminal && _ownsStdinPassthrough) ctx.terminal.exitStdinPassthrough();
      // Clean up rejection handler on error too
      if (typeof window !== 'undefined') {
        setTimeout(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000);
      }
      // Restore original fetch/globals (XHR prototype patch is idempotent, no restore needed)
      globalThis.fetch = _origFetch;
      if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }
      delete (globalThis as any).setImmediate;
      delete (globalThis as any).clearImmediate;
      ctx.stderr += `${e.stack || e.message}\n`;
      return 1;
    }
  },
};

class ProcessExitError extends Error {
  code: number;
  _isProcessExit = true;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function formatArg(arg: any): string {
  if (typeof arg === 'string') return arg;
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}
