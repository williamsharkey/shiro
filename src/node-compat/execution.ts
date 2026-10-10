/**
 * Node.js script execution harness.
 * Orchestrates all node-compat modules and manages script lifecycle.
 * Extracted from node-cmd.ts exec() body.
 */

import { createActivity } from './activity';
import type { CommandContext } from '../commands/index';
import { iframeServer } from '../iframe-server';
import { sha256sync, sha1sync, fnvHash } from '../commands/jseval/crypto';
import { ProcessExitError } from '../commands/jseval/utils';
import { transformESModules, transformTS, transformJSX } from '../commands/jseval/module-transform';
import type { SharedState } from './types';
import { createFakeBuffer } from './buffer';
import { createFakeConsole, formatLog } from './console';
import { createFakeProcess } from './process';
import { createFileCache } from './file-cache';
import { preloadEnvironment } from './preload';
import { isClaudeCodeScript, patchClaudeCodeSource } from '../claude-code-version';
import { createAutoStubFactory } from './auto-stub';
import { createRequireFunction, compileAsyncModule, esmNamespace } from './require';
import { createExpressFactory } from './shims/express';
import { awaitSyncCalls } from './sync-await';
import { nodeGuestOf } from '../node-worker/hooks';
import { createSqliteShim } from './shims/sqlite';
import { createPathModule } from './modules/path';
import { createOsModule } from './modules/os';
import { createEventsModule } from './modules/events';
import { createUrlModule } from './modules/url';
import { createUtilModule } from './modules/util';
import { createFsModule, createFsPromisesModule } from './modules/fs';
import { createChildProcessModule } from './modules/child-process';
import { createStreamModule } from './modules/stream';
import { createCryptoModule } from './modules/crypto';
import { createProcessGlobal, createProcessFunction } from './process-global';
import { loadBrowserPackages } from './browser-packages';
import { patchPackageSource } from './source-patches';
import { createHttpModule, createHttpsModule, createHttp2Module } from './modules/http';
import { createNetModule, createTlsModule } from './modules/net-tls';
import { createMiscModule } from './modules/misc';
import { createAppShim } from './shims/app-shims';
import { getShiroOrigin } from '../utils/shiro-origin';

import { PAGE_FETCH, PAGE_SET_TIMEOUT, PAGE_CLEAR_TIMEOUT, PAGE_SET_INTERVAL, PAGE_CLEAR_INTERVAL } from './page-globals';

/** A Node Timeout object around a page timer id: ref/unref/hasRef/refresh,
 *  and it converts to the id, so arithmetic and clearTimeout(id) both work
 *  (yarn calls setInterval(...).unref()). */
const TIMER_RAW = Symbol('shiro.timer');
function nodeTimer(raw: any, opts: { onUnref?: () => void; onRef?: () => void; refresh?: () => any }): any {
  let refed = true;
  const t: any = {
    [TIMER_RAW]: raw,
    ref() { if (!refed) { refed = true; opts.onRef?.(); } return t; },
    unref() { if (refed) { refed = false; opts.onUnref?.(); } return t; },
    hasRef() { return refed; },
    refresh() { if (opts.refresh) t[TIMER_RAW] = opts.refresh(); return t; },
    [Symbol.toPrimitive]() { return typeof t[TIMER_RAW] === 'number' ? t[TIMER_RAW] : Number(t[TIMER_RAW]); },
  };
  return t;
}
const rawTimer = (t: any) => (t && typeof t === 'object' && TIMER_RAW in t) ? t[TIMER_RAW] : t;

/** Quiet time after which a finished async script exits */
const IDLE_EXIT_MS = 150;
/** ...and for a script that never started tracked async work */
const IDLE_EXIT_SYNC_MS = 60;
/** ...and as many quiet turns of the 20 ms idle poll (see idleExit) */
const IDLE_EXIT_POLLS = 8;
const IDLE_EXIT_SYNC_POLLS = 3;
/** Node scripts running now (an unhandled rejection is only attributable when there is one) */
let runningScripts = 0;

/**
 * Execute a Node.js script in Shiro's browser-based JS VM.
 * This is the main entry point that wires together all node-compat modules.
 */
export async function executeNodeScript(
  ctx: CommandContext,
  code: string,
  scriptPath: string,
  fileArgs: string[],
  printResult: boolean,
): Promise<number> {
  // Suppress unhandled rejections from CLI force-exit patterns
  let _nodeStderrBuf: string[] | null = null;
  /** process 'unhandledRejection' listeners, else node's exit 1 (set once the process exists) */
  let onUnhandled: ((reason: any, promise: Promise<any>) => boolean) | null = null;
  let uncountScript: (() => void) | null = null;
  const suppressRejection = (event: PromiseRejectionEvent) => {
    const msg = event.reason?.message || String(event.reason || '');
    if (event.reason?._isProcessExit || msg === 'unreachable' || msg.startsWith('Aborted(') || msg === 'need dylink section') {
      event.preventDefault();
    } else if (onUnhandled?.(event.reason, event.promise)) {
      event.preventDefault();
    } else {
      const errStr = msg || 'Unknown error';
      console.warn('[node] unhandled rejection:', event.reason?.stack || errStr);
      _nodeStderrBuf?.push(`UnhandledPromiseRejection: ${errStr}\n`);
      // Don't paint over a fullscreen TUI (Claude Code): its screen is on the
      // alternate buffer and stray text lands in its input box.
      const altScreen = (ctx.terminal as any)?.term?.buffer?.active?.type === 'alternate';
      if (ctx.terminal && !altScreen) ctx.terminal.writeOutput(`\x1b[31mUnhandledPromiseRejection: ${errStr}\x1b[0m\r\n`);
      event.preventDefault();
    }
  };

  // Wrappers call the page's own fetch/timers, not whatever script is installed
  // on top: scripts overlap (autostart, Claude, its tool scripts), and chaining
  // onto each other's wrappers doubled every request and timer for the whole
  // session. What a script puts back on exit is still what it replaced.
  const _origFetch = PAGE_FETCH;
  const _restoreFetch = globalThis.fetch;
  const _origXHR = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined;
  const _prevST = globalThis.setTimeout;
  const _prevCT = globalThis.clearTimeout;
  const _prevSI = globalThis.setInterval;
  const _prevCI = globalThis.clearInterval;
  const _baseST = PAGE_SET_TIMEOUT;
  const _baseCT = PAGE_CLEAR_TIMEOUT;

  const { activity, trackAsync, trackModule } = createActivity();
  // Cleanup for resources a script holds until it ends (fs watchers)
  const exitHooks: (() => void)[] = [];
  const atExit = (fn: () => void) => { exitHooks.push(fn); };
  const runExitHooks = () => { for (const fn of exitHooks.splice(0)) { try { fn(); } catch { /* ignore */ } } };
  // Ended by process.exit(), a signal (^C) or an error, not by going idle: as
  // in node its servers close then. A script that goes idle while serving
  // leaves its servers up (they serve from the page after it returns).
  let exitedExplicitly = true;
  const atExplicitExit = (fn: () => void) => atExit(() => { if (exitedExplicitly) fn(); });

  // Shared mutable state
  const _st: SharedState = {
    exitCode: 0,
    exitCalled: false,
    stdoutToTerminal: !!ctx.terminal && ctx.stdoutIsTTY !== false,
    streamedToTerminal: false,
    streamedStderr: false,
    isInteractiveMode: false,
    scriptTimeoutId: null,
    ownsStdinPassthrough: false,
    deferredExitResolve: null,
    fakeProcess: null,
  };

  // Put back page globals this script replaced, but only while they are still
  // ours. Scripts overlap (autostart launches Claude from a timer; Claude runs
  // tool scripts): restoring blindly on exit clobbered whatever a still-running
  // script had installed since, e.g. Claude's Node-style setTimeout (".unref
  // is not a function") and its fetch routing.
  const restoreGlobals = (includeFetch: boolean) => {
    if (includeFetch && _st.installedFetch && globalThis.fetch === _st.installedFetch) globalThis.fetch = _restoreFetch;
    if (_st.installedSetTimeout && globalThis.setTimeout === _st.installedSetTimeout) globalThis.setTimeout = _prevST;
    if (_st.installedClearTimeout && globalThis.clearTimeout === _st.installedClearTimeout) globalThis.clearTimeout = _prevCT;
    if (_st.installedSetInterval && globalThis.setInterval === _st.installedSetInterval) globalThis.setInterval = _prevSI;
    if (_st.installedClearInterval && globalThis.clearInterval === _st.installedClearInterval) globalThis.clearInterval = _prevCI;
  };

  try {
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    _nodeStderrBuf = stderrBuf;
    const pendingPromises: Promise<any>[] = [];
    const processEvents: Record<string, Function[]> = {};

    // Deferred exit: resolves when process.exit is called from async code
    const deferredExitPromise = new Promise<number>((resolve) => { _st.deferredExitResolve = resolve; });

    // Without a terminal, output goes on as it is produced where something takes it
    // (a pipe's reader, like an agent running an npm script, sees it now, not at exit):
    // a spawned child's pipes (ctx.stdoutBytes), the shell's fds as a kernel process
    // (ctx.streamStdout), or a kernel guest's fds 1 and 2
    const writeOut = nodeGuestOf(ctx)?.writeOut;
    if (!ctx.terminal) {
      const enc = new TextEncoder();
      const writerFor = (bytes: ((b: Uint8Array) => void) | undefined, text: ((s: string) => void) | undefined, fd: 1 | 2) =>
        bytes ? (s: string) => bytes(enc.encode(s)) : text ?? (writeOut ? (s: string) => writeOut(fd, s) : undefined);
      const stream = (buf: string[], write: ((s: string) => void) | undefined, keep: boolean, mark: () => void) => {
        if (!write) return;
        buf.push = (...items: string[]) => {
          mark();
          for (const it of items) write(it);
          // (a child's pipe keeps nothing: esbuild's service writes for as long as it runs)
          return keep ? Array.prototype.push.apply(buf, items) : buf.length;
        };
      };
      stream(stdoutBuf, writerFor(ctx.stdoutBytes, ctx.streamStdout, 1), !ctx.stdoutBytes, () => { _st.streamedToTerminal = true; });
      stream(stderrBuf, writerFor(ctx.stderrBytes, ctx.streamStderr, 2), !ctx.stderrBytes, () => { _st.streamedStderr = true; });
    }

    // Console and process
    const fakeConsole = createFakeConsole(ctx, stdoutBuf, stderrBuf, _st);
    const fakeProcess = createFakeProcess(ctx, fileArgs, scriptPath, stdoutBuf, stderrBuf, _st, processEvents, pendingPromises);
    _st.fakeProcess = fakeProcess;

    // File cache, module cache, and sync watchdog
    // As a kernel guest (node-worker), files come from blocking syscalls as they're needed
    const guest = nodeGuestOf(ctx);
    const { fileCache, fileMtimes, moduleCache, tickSyncOps } = createFileCache(guest?.readText, guest ? (p) => !!(ctx.fs as any).isDirCached?.(p) : undefined);

    // Pre-load environment (the page's: files into the cache, Claude's bootstrap)
    if (!guest) await preloadEnvironment(ctx, fileCache, fileMtimes, scriptPath);
    const homeDir = ctx.env['HOME'] || '/home/user';

    // Buffer shim
    const FakeBuffer = createFakeBuffer();
    // The process's own globalThis (its writes stay its own; globalThis.process is its process)
    const processGlobal = createProcessGlobal({ process: fakeProcess, Buffer: FakeBuffer, console: fakeConsole });
    const processFunction = createProcessFunction(processGlobal, fakeProcess, FakeBuffer);
    /** Packages this script reaches that run as their browser builds (rolldown): filled before it starts */
    const browserModules = new Map<string, any>();

    // Built-in module registry with caching
    const _builtinCache = new Map<string, any>();
    // A process that exits lets go of what it loaded: a handler it left behind
    // (a page listener, a job-table entry) otherwise reached all of it through
    // these (vite's 112 MB rolldown memory stayed after ^C). One that went idle
    // keeps them: the servers it left up still run its code.
    if (!guest) atExplicitExit(() => {
      moduleCache.clear(); fileCache.clear(); _builtinCache.clear(); browserModules.clear();
      for (const k of Object.keys(processEvents)) delete processEvents[k];
    });
    function getBuiltinModule(name: string): any | null {
      const cacheKey = name.startsWith('node:') ? name.slice(5) : name;
      if (_builtinCache.has(cacheKey)) return _builtinCache.get(cacheKey);
      let mod = _getBuiltinModuleImpl(name);
      // A worker_threads thread (a guest of its own): its parentPort talks to the Worker in the parent
      if (mod && cacheKey === 'worker_threads' && guest?.thread) mod = threadSide(mod, guest.thread);
      if (mod !== null) _builtinCache.set(cacheKey, mod);
      return mod;
    }
    /** What keeps this script running for worker_threads: ref'd Workers it started, or (a thread) a parentPort listened to */
    const liveWorkers = new Set<any>();
    let parentPortAlive = () => false;
    const threadsAlive = () => liveWorkers.size > 0 || parentPortAlive();
    function threadSide(mainWT: any, t: NonNullable<typeof guest>['thread'] & object): any {
      const parentPort: any = mainWT._makeEmitter({});
      let refd = true, closed = false;
      parentPort.postMessage = (v: any) => { if (!closed) t.post(v); };
      parentPort.start = () => {};
      parentPort.close = () => { closed = true; parentPort.emit('close'); };
      parentPort.ref = () => { refd = true; return parentPort; };
      parentPort.unref = () => { refd = false; return parentPort; };
      // As a MessagePort: messages wait until something listens for them, then come a tick later
      const queued: unknown[] = [];
      let flushing = false;
      const flush = () => {
        if (flushing || closed || !parentPort.listenerCount('message') || !queued.length) return;
        flushing = true;
        _baseST(() => { flushing = false; while (queued.length && parentPort.listenerCount('message') && !closed) parentPort.emit('message', queued.shift()); }, 0);
      };
      for (const k of ['on', 'addListener', 'once', 'prependListener']) {
        const orig = parentPort[k];
        if (typeof orig === 'function') parentPort[k] = (ev: string, fn: any) => { const r = orig(ev, fn); if (ev === 'message') flush(); return r; };
      }
      t.onMessage((v) => { queued.push(v); flush(); });
      parentPortAlive = () => !closed && refd && parentPort.listenerCount('message') > 0;
      return { ...mainWT, isMainThread: false, parentPort, workerData: t.workerData, threadId: t.threadId };
    }
    function _getBuiltinModuleImpl(name: string): any | null {
      switch (name) {
        case 'path':
        case 'node:path': return createPathModule(ctx);
        case 'fs':
        case 'node:fs': {
          const fsMod = createFsModule({ ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir, trackAsync, atExit, getProcess: () => fakeProcess });
          fsMod.promises = trackModule(fsMod.promises);
          return fsMod;
        }
        case 'fs/promises':
        case 'node:fs/promises': return trackModule(createFsPromisesModule({ ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir, trackAsync, atExit }));
        case 'child_process':
        case 'node:child_process': return createChildProcessModule({ ctx, fileCache, fileMtimes, pendingPromises, FakeBuffer, getProcess: () => fakeProcess, guest });
        case 'os':
        case 'node:os': return createOsModule(ctx);
        case 'util':
        case 'node:util': return createUtilModule();
        case 'events':
        case 'node:events': return createEventsModule();
        case 'url':
        case 'node:url': return createUrlModule(() => fakeProcess.cwd());
        case 'stream':
        case 'node:stream': return createStreamModule(getBuiltinModule('events'));
        case 'stream/promises':
        case 'node:stream/promises': return getBuiltinModule('stream').promises;
        // The WHATWG streams node has as stream/web are the page's (Next's edge runtime)
        case 'stream/web':
        case 'node:stream/web': {
          const g = globalThis as any;
          const names = ['ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest',
            'ReadableByteStreamController', 'ReadableStreamDefaultController', 'TransformStream', 'TransformStreamDefaultController',
            'WritableStream', 'WritableStreamDefaultWriter', 'WritableStreamDefaultController', 'ByteLengthQueuingStrategy',
            'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream', 'CompressionStream', 'DecompressionStream'];
          return Object.fromEntries(names.filter((n) => g[n]).map((n) => [n, g[n]]));
        }
        case 'stream/consumers':
        case 'node:stream/consumers': return getBuiltinModule('stream').consumers;
        case 'crypto':
        case 'node:crypto': return createCryptoModule({ sha256sync, sha1sync, fnvHash, FakeBuffer });
        case 'http':
        case 'node:http': return createHttpModule({ ctx, iframeServer, fakeConsole, getBuiltinModule, trackAsync, atExit: atExplicitExit });
        case 'https':
        case 'node:https': return createHttpsModule({ ctx, iframeServer, fakeConsole, getBuiltinModule, trackAsync, atExit: atExplicitExit });
        case 'net':
        case 'node:net': return createNetModule({ Buffer: FakeBuffer, ...(nodeGuestOf(ctx)?.netStack ? { stack: nodeGuestOf(ctx)!.netStack as any } : {}) });
        case 'tls':
        case 'node:tls': return createTlsModule({ getBuiltinModule });
        case 'http2':
        case 'node:http2': return createHttp2Module();
        default: {
          const appShim = createAppShim(name, { ctx, fileCache, fakeProcess, FakeBuffer });
          if (appShim !== null) return appShim;
          return createMiscModule(name, { ctx, FakeBuffer, fakeProcess, fakeConsole, getBuiltinModule, fileCache, moduleCache, requireModule, startWorker });
        }
      }
    }

    // Auto-stub factory
    const { createAutoStub } = createAutoStubFactory();

    // Express shim factory
    const expressFactory = createExpressFactory({ ctx, iframeServer, fakeConsole, pendingPromises });

    // Require function (module resolver + loader)
    const requireModule = createRequireFunction({
      ctx, fileCache, fileMtimes, moduleCache, pendingPromises, processEvents,
      getBuiltinModule, fakeConsole, fakeProcess, FakeBuffer, processGlobal, processFunction, browserModules,
      createExpressShim: expressFactory,
      createSqliteShim: () => createSqliteShim({ ctx }),
      createAutoStub,
    });

    const fakeRequire = (moduleName: string) => requireModule(moduleName, ctx.cwd);

    /**
     * worker_threads on this thread: the worker's script runs in its own
     * module cache, with a worker_threads whose parentPort talks to the
     * Worker object (messages structured-cloned, delivered as tasks). Enough
     * for pools that hand a worker jobs by message (pnpm's store workers).
     */
    let evalWorkers = 0;
    function startWorker(filename: string, options: any, worker: any): void {
      if (guest?.startThread) {
        // A kernel guest: the worker is a thread of this process, running in parallel
        const target = options?.eval ? String(filename)
          : filename.startsWith('file://') ? decodeURIComponent(new URL(filename).pathname) : ctx.fs.resolvePath(String(filename), ctx.cwd);
        const env = options?.env && typeof options.env === 'object' ? Object.fromEntries(Object.entries(options.env).map(([k, v]) => [k, String(v)])) : undefined;
        const h = guest.startThread(target, { threadId: worker.threadId, eval: !!options?.eval, workerData: options?.workerData, argv: options?.argv?.map(String), env }, {
          online: () => worker.emit('online'),
          message: (v) => { if (!worker._exited) worker.emit('message', v); },
          error: (e) => {
            const err = Object.assign(new Error(e.message), { stack: e.stack ?? e.message });
            if (worker.listenerCount('error')) worker.emit('error', err);
            else stderrBuf.push(e.message + '\n');
          },
          exit: (code) => {
            liveWorkers.delete(worker);
            if (!worker._exited) { worker._exited = true; worker.emit('exit', code); }
          },
        });
        liveWorkers.add(worker);
        worker._toWorker = (v: any) => h.post(v);
        worker._terminate = () => { liveWorkers.delete(worker); h.terminate(); };
        worker.ref = () => { if (!worker._exited) liveWorkers.add(worker); return worker; };
        worker.unref = () => { liveWorkers.delete(worker); return worker; };
        return;
      }
      // { eval: true }: the "filename" is the worker's code, run as a CommonJS module from here
      let file: string;
      if (options?.eval) {
        file = ctx.fs.resolvePath(`[worker eval ${++evalWorkers}].js`, ctx.cwd);
        fileCache.set(file, String(filename));
      } else {
        file = filename.startsWith('file://') ? decodeURIComponent(new URL(filename).pathname) : ctx.fs.resolvePath(filename, ctx.cwd);
      }
      const mainWT = getBuiltinModule('worker_threads');
      const parentPort: any = mainWT._makeEmitter({});
      let alive = true;
      const clone = (v: any) => { try { return structuredClone(v); } catch { return v; } };
      // A message between the threads is activity from post to handler (pnpm
      // unref()s its workers; under load the hop outlasted the idle window and
      // pnpm exited mid-install)
      const deliver = (fn: () => void) => { trackAsync(new Promise<void>((done) => { _baseST(() => { try { fn(); } finally { done(); } }, 0); })); };
      parentPort.postMessage = (v: any) => { const c = clone(v); deliver(() => { if (!worker._exited) worker.emit('message', c); }); };
      parentPort.start = () => {};
      parentPort.close = () => { alive = false; };
      parentPort.ref = parentPort.unref = () => parentPort;
      worker._toWorker = (v: any) => { const c = clone(v); deliver(() => { if (alive) parentPort.emit('message', c); }); };
      worker._terminate = () => { alive = false; parentPort.removeAllListeners(); };
      const workerWT = { ...mainWT, isMainThread: false, parentPort, workerData: clone(options.workerData), threadId: worker.threadId };
      const workerBuiltin = (name: string) => (name === 'worker_threads' || name === 'node:worker_threads') ? workerWT : getBuiltinModule(name);
      const workerRequire = createRequireFunction({
        ctx, fileCache, fileMtimes, moduleCache: new Map(), pendingPromises, processEvents,
        getBuiltinModule: workerBuiltin, fakeConsole, fakeProcess, FakeBuffer,
        createExpressShim: expressFactory,
        createSqliteShim: () => createSqliteShim({ ctx }),
        createAutoStub,
      });
      deliver(() => {
        try {
          workerRequire(file, file.substring(0, file.lastIndexOf('/')) || '/');
          worker.emit('online');
        } catch (e: any) {
          if (worker.listenerCount('error')) worker.emit('error', e);
          else stderrBuf.push(`Worker ${file}: ${e?.message ?? e}\n`);
          if (!worker._exited) { worker._exited = true; worker.emit('exit', 1); }
        }
      });
    }

    // A script that reads piped stdin synchronously (fs.readFileSync(0), '/dev/stdin',
    // fs.readSync(0)) can't wait for a live stream: load it before the script runs
    // (a guest's stdin is one too; a spawned child in the page leaves its live one be)
    if ((!ctx.stdinStream || (ctx as any).nodeGuest) && /readFileSync\(\s*(?:0\s*[,)]|['"]\/dev\/stdin['"])|readSync\(\s*0\s*,/.test(code)) {
      await fakeProcess.stdin?.__fd0?.fill();
    }
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    // Transform TypeScript/JSX/ESM syntax for execution
    let transformedCode = isClaudeCodeScript(scriptPath) ? patchClaudeCodeSource(code) : patchPackageSource(scriptPath, code);
    if (scriptPath && (scriptPath.endsWith('.ts') || scriptPath.endsWith('.tsx'))) {
      transformedCode = transformTS(transformedCode);
    }
    if (scriptPath && (scriptPath.endsWith('.tsx') || scriptPath.endsWith('.jsx'))) {
      transformedCode = transformJSX(transformedCode);
    }
    transformedCode = transformESModules(transformedCode);
    // spawnSync/execSync results are read right away: await them where the script can
    if (!isClaudeCodeScript(scriptPath)) transformedCode = awaitSyncCalls(transformedCode);

    // Stash real browser console on globalThis so injected code can use it
    if (code.length > 500000) {
      (globalThis as any).__realConsole = console;
    }

    const wrappedCode = printResult ? `return (${transformedCode})` : transformedCode;
    const fn = compileAsyncModule(AsyncFunction, [
      'console', 'process', 'require', 'Buffer', '__filename', '__dirname', 'shiro', '__import_meta', 'module', 'exports', '__dynamic_import',
      '__shiro_module', '__shiro_require', 'global', '__shiro_require_ready', 'globalThis', 'Function',
    ], wrappedCode);

    // Fake import.meta for ES modules
    const entryFilename = scriptPath || ctx.cwd + '/repl.js';
    const entryDirname = scriptPath ? scriptPath.substring(0, scriptPath.lastIndexOf('/')) : ctx.cwd;
    // Browser builds a package here runs as (rolldown → @rolldown/browser): loaded before the script needs them
    try {
      for (const [spec, ns] of await loadBrowserPackages(ctx.fs, entryDirname, getBuiltinModule, fakeProcess, trackAsync, atExit)) browserModules.set(spec, ns);
    } catch (e: any) {
      console.warn('[node] browser build:', e);
      const err = e?.errors?.[0];
      const at = err?.location ? ` (${err.location.file}:${err.location.line}: ${String(err.location.lineText).trim().slice(0, 160)})` : '';
      stderrBuf.push(`node: loading a browser build failed: ${err?.text ?? e?.message ?? e}${at}\n`);
    }
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

    // Create require function for the entry script
    Object.assign(fakeModule, { id: '.', filename: entryFilename, loaded: false, children: [] });
    (requireModule as any).setMain(fakeModule);
    const entryRequire = (requireModule as any).makeRequire(entryDirname, fakeModule);

    // Dynamic import() shim
    const dynamicImport = async (specifier: unknown) => {
      let moduleName = String(specifier);
      // A URL (CDN ES module) is loaded by the browser itself
      if (/^(?:https?|data|blob):/.test(moduleName)) return import(/* @vite-ignore */ moduleName);
      if (moduleName.startsWith('file://')) moduleName = decodeURIComponent(moduleName.slice(7));
      try {
        return esmNamespace(await requireModule.ready(moduleName, entryDirname, entryFilename));
      } catch (e: any) {
        const msg = e?.message || String(e);
        throw new Error(`Failed to dynamically import '${moduleName}': ${msg}`);
      }
    };

    let result;

    if (typeof window !== 'undefined') {
      window.addEventListener('unhandledrejection', suppressRejection);
    } else {
      // a kernel guest: the worker hears them
      nodeGuestOf(ctx)?.onUnhandledRejection?.((reason, promise) => suppressRejection({ reason, promise, preventDefault() {} } as unknown as PromiseRejectionEvent));
    }
    runningScripts++;
    let counted = true;
    uncountScript = () => { if (counted) { counted = false; runningScripts--; } };
    // As node: the process's 'unhandledRejection' listeners take it, or the
    // script ends with exit code 1. The page's event can't say whose promise
    // it was, so a script ends this way only while it is the only one running
    // (overlapping scripts, such as Claude and its tools, just print it).
    onUnhandled = (reason, promise) => {
      const listeners = processEvents['unhandledRejection'];
      if (listeners?.length) {
        for (const fn of [...listeners]) { try { fn(reason, promise); } catch { /* ignore */ } }
        return true;
      }
      if (runningScripts === 1 && !_st.exitCalled && !_st.isInteractiveMode) {
        _st.exitCode = 1;
        _st.exitCalled = true;
        _st.deferredExitResolve?.(1);
      }
      return false;
    };

    // CORS proxy setup
    // (a kernel guest's worker has the page's origin in its own location)
    const corsProxyOrigin = typeof window !== 'undefined' ? getShiroOrigin()
      : nodeGuestOf(ctx) && typeof location !== 'undefined' ? location.origin : '';
    const corsProxyMap: [string, string][] = [
      ['https://api.anthropic.com/', '/api/anthropic/'],
      ['https://platform.claude.com/', '/api/platform/'],
      ['https://mcp-proxy.anthropic.com/', '/api/mcp-proxy/'],
      ['https://generativelanguage.googleapis.com/', '/api/gemini/'],
    ];
    const rewriteUrl = (u: string): string => {
      for (const [prefix, proxy] of corsProxyMap) {
        if (u.startsWith(prefix)) return corsProxyOrigin + proxy + u.slice(prefix.length);
      }
      return u;
    };
    const blockedUrls = [
      'datadoghq.com', 'sentry.io', '/api/event_logging',
      'claude_code_first_token_date', 'claude_code_grove',
      // Gemini CLI's Clearcut telemetry (its CORS only allows play.google.com)
      'play.googleapis.com/log',
    ];
    const isBlocked = (u: string) => blockedUrls.some(b => u.includes(b));

    // A kernel guest routes too (its own servers on localhost), wherever it runs
    if (corsProxyOrigin || nodeGuestOf(ctx)) {
      globalThis.fetch = _st.installedFetch = (input: RequestInfo | URL, init?: RequestInit) => trackAsync(routedFetch(input, init));
      const routedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
              body: typeof init?.body === 'string' ? init.body
                : init?.body instanceof Uint8Array ? init.body as any
                : init?.body instanceof ArrayBuffer ? new Uint8Array(init.body) as any : null,
            }).then(vResp => new Response(
              // bytes stay bytes; a stream (server-sent events) is read as it comes
              typeof vResp.body === 'string' || vResp.body instanceof Uint8Array || vResp.body instanceof ReadableStream ? vResp.body as BodyInit
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
        // Track SSE stream lifecycle for /v1/messages
        const isMessages = url.includes('/v1/messages');
        if (isMessages) {
          const t0 = Date.now();
          return _origFetch(input, init).then(resp => {
            const ct = resp.headers.get('content-type') || '';
            const isSSE = ct.includes('text/event-stream');
            console.log(`[fetch] /v1/messages ${resp.status} ${ct.split(';')[0]} (${Date.now() - t0}ms)`);
            if (isSSE && resp.body) {
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
        // A site without CORS headers fails in the page ("Failed to fetch"), not in node:
        // the request again over the TCP relay, as curl does (commands/relay-fetch.ts)
        return _origFetch(input, init).catch(async (e: unknown) => {
          const target = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
          const { relayAvailable, relayFetch } = await import('../commands/relay-fetch');
          const crossOrigin = /^https?:/.test(target) && typeof location !== 'undefined' && new URL(target).origin !== location.origin;
          if (!(e instanceof TypeError) || !crossOrigin || !relayAvailable() || init?.signal?.aborted) throw e;
          const req = input instanceof Request ? input : null;
          return relayFetch(target, {
            method: init?.method ?? req?.method,
            headers: init?.headers ?? req?.headers,
            body: init?.body ?? (req && req.method !== 'GET' && req.method !== 'HEAD' ? new Uint8Array(await req.clone().arrayBuffer()) : undefined),
            redirect: init?.redirect ?? req?.redirect,
            signal: init?.signal ?? req?.signal,
          });
        });
      };
      // Patch XMLHttpRequest prototype
      if (_origXHR && !(XMLHttpRequest.prototype as any)._shiroProxied) {
        const unsafeHeaders = new Set(['user-agent','host','content-length','connection','accept-encoding','accept-charset','referer','origin','cookie','te','upgrade','via','transfer-encoding','proxy-authorization','proxy-connection','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user']);
        const origOpen = XMLHttpRequest.prototype.open;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
          const u = typeof url === 'string' ? url : url.toString();
          if (isBlocked(u)) { (this as any)._blocked = true; return; }
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
                .then(async vResp => {
                  const text = typeof vResp.body === 'string' ? vResp.body
                    : vResp.body instanceof Uint8Array || vResp.body instanceof ReadableStream ? await new Response(vResp.body as BodyInit).text()
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

    // Polyfill setImmediate/clearImmediate once for the page and never remove it.
    // Node processes share this global and overlap (Claude Code runs for hours
    // while its tool calls start and finish other scripts); a finishing child
    // that deleted it broke the still-running parent mid-call, leaving Claude's
    // Bash tool awaiting a promise that never settled.
    if (typeof (globalThis as any).setImmediate !== 'function') {
      (globalThis as any).setImmediate = (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args);
      (globalThis as any).clearImmediate = (id: any) => clearTimeout(id);
    }

    // Track active timers
    let _activeTimers = 0;
    let _timersResolve: (() => void) | null = null;
    let _timersDone: Promise<void> | null = null;
    const _timerIds = new Set<any>();
    const _intervalIds = new Set<any>();
    const _refdIntervals = new Set<any>(); // a guest's ref'd intervals: activity, as in node
    // (and its open sockets and servers)
    const intervalsAlive = () => _refdIntervals.size > 0 || !!guest?.busy?.() || threadsAlive();
    if (code.length <= 500000) {
      const settle = () => { if (_activeTimers <= 0 && _timersResolve) { _timersResolve(); _timersResolve = null; _timersDone = null; } };
      globalThis.setTimeout = _st.installedSetTimeout = function(fn: any, ms?: number, ...args: any[]) {
        _activeTimers++;
        if (!_timersDone) _timersDone = new Promise(r => { _timersResolve = r; });
        let counted = true; // keeps the script alive until it fires (not once unref'd)
        const uncount = () => { if (counted) { counted = false; _activeTimers--; settle(); } };
        const start = () => {
          const id = _baseST(() => {
            _timerIds.delete(timer);
            try { if (typeof fn === 'function') fn(...args); }
            catch (e) {
              // process.exit() from a timer ends the script (already recorded); it isn't an error
              if (!(e instanceof ProcessExitError)) throw e;
            }
            finally { uncount(); }
          }, ms);
          return id;
        };
        const timer = nodeTimer(start(), {
          onUnref: uncount,
          onRef: () => {
            if (counted || !_timerIds.has(timer)) return;
            counted = true;
            _activeTimers++;
            if (!_timersDone) _timersDone = new Promise(r => { _timersResolve = r; });
          },
          refresh: () => { _baseCT(rawTimer(timer)); return start(); },
        });
        _timerIds.add(timer);
        (timer as any)._uncount = uncount;
        return timer;
      } as typeof setTimeout;
      globalThis.clearTimeout = _st.installedClearTimeout = function(id: any) {
        for (const t of _timerIds) {
          if (t === id || rawTimer(t) === rawTimer(id)) { _timerIds.delete(t); t._uncount(); break; }
        }
        _baseCT(rawTimer(id));
      };
      // Intervals never kept a script alive in the page (one left running would hold the
      // shell); they still answer unref() etc. A kernel guest is a process that can be
      // killed, so there, as in node, a ref'd interval keeps it running until cleared.
      globalThis.setInterval = _st.installedSetInterval = function(fn: any, ms?: number, ...args: any[]) {
        const raw = PAGE_SET_INTERVAL(fn, ms, ...args);
        _intervalIds.add(raw);
        if (!guest) return nodeTimer(raw, {});
        _refdIntervals.add(raw);
        return nodeTimer(raw, {
          onUnref: () => { _refdIntervals.delete(raw); },
          onRef: () => { if (_intervalIds.has(raw)) _refdIntervals.add(raw); },
        });
      } as typeof setInterval;
      globalThis.clearInterval = _st.installedClearInterval = function(id: any) { _intervalIds.delete(rawTimer(id)); _refdIntervals.delete(rawTimer(id)); PAGE_CLEAR_INTERVAL(rawTimer(id)); };
      // When the script ends its timers go with it, as with a process: an
      // interval left running fired into the next script and, through that
      // script's setTimeout, kept it from ever going idle
      atExit(() => {
        for (const raw of _intervalIds) PAGE_CLEAR_INTERVAL(raw);
        _intervalIds.clear();
        _refdIntervals.clear();
        for (const t of _timerIds) _baseCT(rawTimer(t));
        _timerIds.clear();
      });
    }

    // Script execution timeout — scale up for large bundles (e.g. TypeScript ~5MB)
    const SCRIPT_TIMEOUT = code.length > 500_000 ? 60_000 : 15_000;
    let scriptTimedOut = false;
    const runStart = performance.now();
    // It only ends a script that has gone idle: an entry whose top-level await
    // runs the whole program (Gemini CLI's `await run()`) keeps going while
    // requests, fs work or timers are in flight or output is still coming.
    const timeoutPromise = new Promise<never>((_, reject) => {
      let outSeen = stdoutBuf.length + stderrBuf.length;
      const check = () => {
        const out = stdoutBuf.length + stderrBuf.length;
        if (activity.pending > 0 || _activeTimers > 0 || intervalsAlive() || pendingPromises.length > 0 || out !== outSeen) {
          outSeen = out;
          _st.scriptTimeoutId = setTimeout(check, SCRIPT_TIMEOUT);
          return;
        }
        scriptTimedOut = true;
        reject(new ProcessExitError(124));
      };
      _st.scriptTimeoutId = setTimeout(check, SCRIPT_TIMEOUT);
    });

    try {
      result = await Promise.race([
        fn(fakeConsole, fakeProcess, entryRequire, FakeBuffer, entryFilename, entryDirname, {
          fs: ctx.fs,
          shell: ctx.shell,
          env: ctx.env,
          cwd: ctx.cwd,
        }, fakeImportMeta, fakeModule, fakeExports, dynamicImport, fakeModule, entryRequire, processGlobal,
        (p: string) => requireModule.ready(p, entryDirname, entryFilename), processGlobal, processFunction),
        timeoutPromise,
      ]);
    } catch (e: any) {
      if (e instanceof ProcessExitError) {
        _st.exitCode = e.code;
      } else if (_st.outputClosed) {
        // process.exit() already ran; this is what a catch on the way threw
      } else if (e.message?.includes('extends value') || e.message?.includes('is not a constructor') || e.message?.includes('prototype')) {
        stderrBuf.push(e.message + '\n');
        _st.exitCode = 1;
      } else if (e.name === 'ReferenceError' || e.name === 'TypeError' || e.name === 'SyntaxError') {
        stderrBuf.push((e.message || String(e)) + '\n');
        console.error('[node] Runtime error:', e);
        _st.exitCode = 1;
      } else {
        throw e;
      }
    }

    // Clean up script timeout
    if (_st.scriptTimeoutId) { clearTimeout(_st.scriptTimeoutId); _st.scriptTimeoutId = null; }

    // Wait for pending async operations
    while (pendingPromises.length > 0) {
      const current = [...pendingPromises];
      pendingPromises.length = 0;
      await Promise.all(current);
    }

    // Wait for pending timers (max 5s)
    // Timers still pending after this cap (a 60s timeout) don't keep the script alive
    let timersOutlasted = false;
    if (_activeTimers > 0 && _timersDone && !_st.isInteractiveMode && !_st.exitCalled) {
      try {
        // (an exit meanwhile ends the wait: process.exit() or an unhandled
        // rejection in async code, and the timers left go with the script)
        // (a guest waits them out, as node does)
        await Promise.race([_timersDone, deferredExitPromise, guest ? new Promise(() => {}) : new Promise((_, rej) => _baseST(() => rej('timer-wait-timeout'), 5000))]);
      } catch { timersOutlasted = true; }
    }

    // Restore setTimeout/clearTimeout before deferred exit. Scripts that aren't
    // interactive keep them until the wait below, so timers they set from async
    // callbacks still count as activity.
    if (_st.isInteractiveMode) restoreGlobals(false);

    // Deferred exit wait
    if (_st.isInteractiveMode || !(_st.exitCalled || scriptTimedOut)) {
      // A cap on the async phase only; a script that has gone quiet ends sooner
      // (idleExit). 10 s killed package managers mid-install (pnpm's 10 s
      // retry back-off, slow registries), so busy scripts get 10 minutes.
      const DEFERRED_TIMEOUT = _st.isInteractiveMode ? 86400000 : 600000;
      // Like the script timeout, it fires on a script that has gone idle, not
      // on one still waiting on the network (a CLI's model request)
      // (cleared when the wait ends: a pending page timer kept the ended
      // process, and all it loaded, for its 10 minutes)
      let deferredTimer: ReturnType<typeof setTimeout> | undefined;
      const deferredTimeout = new Promise<never>((_, reject) => {
        let outSeen = stdoutBuf.length + stderrBuf.length;
        const check = () => {
          const out = stdoutBuf.length + stderrBuf.length;
          if (!_st.isInteractiveMode && (activity.pending > 0 || intervalsAlive() || out !== outSeen)) {
            outSeen = out;
            deferredTimer = _baseST(check, DEFERRED_TIMEOUT);
            return;
          }
          reject(new ProcessExitError(124));
        };
        deferredTimer = _baseST(check, DEFERRED_TIMEOUT); // untracked: not script activity
      });
      let freshExitPromise = deferredExitPromise;
      if (_st.exitCalled && _st.isInteractiveMode) {
        freshExitPromise = new Promise<number>(resolve => {
          _st.deferredExitResolve = resolve;
        });
        _st.exitCalled = false;
      }
      // An async script (top-level await, promise chain) is finished once nothing
      // it started is in flight and it has been quiet briefly, like node exiting on
      // an empty event loop; don't sit out the whole timeout after it's done.
      let waitOver = false;
      const idleExit = _st.isInteractiveMode ? new Promise<number>(() => {}) : new Promise<number>((resolve) => {
        let outSeen = stdoutBuf.length + stderrBuf.length;
        let quietSince = performance.now();
        // Quiet turns of this poll, besides quiet time: a busy page stretches
        // time, not the order of queued tasks, so work hopping through tasks
        // nothing tracks still gets its turns before the script is called done
        let quietPolls = 0;
        const poll = () => {
          if (waitOver) return;
          const now = performance.now();
          const out = stdoutBuf.length + stderrBuf.length;
          // fs work queued by sync calls after the drain above: in flight
          // until it settles, then no longer activity
          if (pendingPromises.length > 0) trackAsync(Promise.all(pendingPromises.splice(0)));
          if (out !== outSeen || activity.pending > 0 || (_activeTimers > 0 && !timersOutlasted) || intervalsAlive()) {
            outSeen = out;
            quietSince = now;
            quietPolls = 0;
          } else quietPolls++;
          if (activity.last > quietSince) { quietSince = activity.last; quietPolls = 0; }
          // Only sync work so far: exit sooner; after async work, allow a longer lull
          const async = activity.last > runStart;
          const window = async ? IDLE_EXIT_MS : IDLE_EXIT_SYNC_MS;
          if (now - quietSince >= window && quietPolls >= (async ? IDLE_EXIT_POLLS : IDLE_EXIT_SYNC_POLLS)) resolve(_st.exitCode);
          else _baseST(poll, 20);
        };
        _baseST(poll, 20);
      });
      try {
        const waitCode = await Promise.race([freshExitPromise, deferredTimeout, idleExit]);
        _st.exitCode = waitCode;
      } catch (e: any) {
        if (e instanceof ProcessExitError) {
          _st.exitCode = e.code;
        }
      } finally {
        waitOver = true;
        exitedExplicitly = _st.exitCalled;
        _baseCT(deferredTimer);
      }
      while (pendingPromises.length > 0) {
        const current = [...pendingPromises];
        pendingPromises.length = 0;
        await Promise.all(current);
      }
    }
    // The script ended on its own: 'exit' listeners run, and may set
    // process.exitCode (mocha reports failures that way)
    if (!_st.exitCalled && !scriptTimedOut && !_st.isInteractiveMode && processEvents['exit']?.length) {
      _st.exitCalled = true;
      try {
        for (const fn of [...processEvents['exit']]) fn(_st.exitCode);
      } catch (e: any) {
        if (e instanceof ProcessExitError) _st.exitCode = e.code;
        else { stderrBuf.push((e?.stack || String(e)) + '\n'); _st.exitCode = 1; }
      }
    }
    if (!_st.isInteractiveMode) restoreGlobals(false);

    // Flush output
    if (stdoutBuf.length > 0 && !_st.streamedToTerminal) {
      // Entries carry their own newlines: console.log adds one, stdout.write doesn't
      ctx.stdout += stdoutBuf.join('');
    }
    if (stderrBuf.length > 0 && !_st.streamedStderr) {
      ctx.stderr += stderrBuf.join('');
    }

    if (printResult && !_st.exitCalled) {
      ctx.stdout += formatLog([result]) + '\n';
    }

    // Clean up
    uncountScript?.();
    _st.ttyStdin?.close();
    if (ctx.terminal && _st.ownsStdinPassthrough) ctx.terminal.exitStdinPassthrough();
    if (typeof window !== 'undefined') {
      _baseST(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000); // (the page's timer: the global one may be another script's, cleared when it ends)
    }
    restoreGlobals(true);
    runExitHooks();
    _st.restoreCwd?.();

    return _st.exitCode;
  } catch (e: any) {
    // Clean up on error
    uncountScript?.();
    _st.ttyStdin?.close();
    if (ctx.terminal && _st.ownsStdinPassthrough) ctx.terminal.exitStdinPassthrough();
    if (typeof window !== 'undefined') {
      _baseST(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000); // (the page's timer: the global one may be another script's, cleared when it ends)
    }
    restoreGlobals(true);
    runExitHooks();
    _st.restoreCwd?.();
    const msg = e.message || String(e);
    console.error('[node] Script error:', e);
    ctx.stderr += `Error: ${msg}\n`;
    return 1;
  }
}
