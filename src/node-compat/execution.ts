/**
 * Node.js script execution harness.
 * Orchestrates all node-compat modules and manages script lifecycle.
 * Extracted from node-cmd.ts exec() body.
 */

import { createActivity } from './activity';
import type { CommandContext } from '../commands/index';
import { iframeServer } from '../iframe-server';
import { sha256sync, sha1sync, fnvHash } from '../commands/jseval/crypto';
import { ProcessExitError, formatArg } from '../commands/jseval/utils';
import { transformESModules, transformTS, transformJSX } from '../commands/jseval/module-transform';
import type { SharedState } from './types';
import { createFakeBuffer } from './buffer';
import { createFakeConsole } from './console';
import { createFakeProcess } from './process';
import { createFileCache } from './file-cache';
import { preloadEnvironment } from './preload';
import { isClaudeCodeScript, patchClaudeCodeSource } from '../claude-code-version';
import { createAutoStubFactory } from './auto-stub';
import { createRequireFunction, compileAsyncModule, esmNamespace } from './require';
import { createExpressFactory } from './shims/express';
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
  const suppressRejection = (event: PromiseRejectionEvent) => {
    const msg = event.reason?.message || String(event.reason || '');
    if (event.reason?._isProcessExit || msg === 'unreachable' || msg.startsWith('Aborted(') || msg === 'need dylink section') {
      event.preventDefault();
    } else {
      const errStr = msg || 'Unknown error';
      console.warn('[node] unhandled rejection:', event.reason?.stack || errStr);
      _nodeStderrBuf?.push(`UnhandledPromiseRejection: ${errStr}`);
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

    // Console and process
    const fakeConsole = createFakeConsole(ctx, stdoutBuf, stderrBuf, _st);
    const fakeProcess = createFakeProcess(ctx, fileArgs, scriptPath, stdoutBuf, stderrBuf, _st, processEvents, pendingPromises);
    _st.fakeProcess = fakeProcess;

    // File cache, module cache, and sync watchdog
    const { fileCache, fileMtimes, moduleCache, tickSyncOps } = createFileCache();

    // Pre-load environment
    await preloadEnvironment(ctx, fileCache, fileMtimes, scriptPath);
    const homeDir = ctx.env['HOME'] || '/home/user';

    // Buffer shim
    const FakeBuffer = createFakeBuffer();

    // Built-in module registry with caching
    const _builtinCache = new Map<string, any>();
    function getBuiltinModule(name: string): any | null {
      const cacheKey = name.startsWith('node:') ? name.slice(5) : name;
      if (_builtinCache.has(cacheKey)) return _builtinCache.get(cacheKey);
      const mod = _getBuiltinModuleImpl(name);
      if (mod !== null) _builtinCache.set(cacheKey, mod);
      return mod;
    }
    function _getBuiltinModuleImpl(name: string): any | null {
      switch (name) {
        case 'path':
        case 'node:path': return createPathModule(ctx);
        case 'fs':
        case 'node:fs': {
          const fsMod = createFsModule({ ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir, trackAsync });
          fsMod.promises = trackModule(fsMod.promises);
          return fsMod;
        }
        case 'fs/promises':
        case 'node:fs/promises': return trackModule(createFsPromisesModule({ ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir }));
        case 'child_process':
        case 'node:child_process': return createChildProcessModule({ ctx, fileCache, fileMtimes, pendingPromises, FakeBuffer, getProcess: () => fakeProcess });
        case 'os':
        case 'node:os': return createOsModule(ctx);
        case 'util':
        case 'node:util': return createUtilModule();
        case 'events':
        case 'node:events': return createEventsModule();
        case 'url':
        case 'node:url': return createUrlModule();
        case 'stream':
        case 'node:stream': return createStreamModule(getBuiltinModule('events'));
        case 'stream/promises':
        case 'node:stream/promises': return getBuiltinModule('stream').promises;
        case 'stream/consumers':
        case 'node:stream/consumers': return getBuiltinModule('stream').consumers;
        case 'crypto':
        case 'node:crypto': return createCryptoModule({ sha256sync, sha1sync, fnvHash, FakeBuffer });
        case 'http':
        case 'node:http': return createHttpModule({ ctx, iframeServer, fakeConsole, getBuiltinModule, trackAsync });
        case 'https':
        case 'node:https': return createHttpsModule({ ctx, iframeServer, fakeConsole, getBuiltinModule, trackAsync });
        case 'net':
        case 'node:net': return createNetModule({ Buffer: FakeBuffer });
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
      getBuiltinModule, fakeConsole, fakeProcess, FakeBuffer,
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
    function startWorker(filename: string, options: any, worker: any): void {
      const file = filename.startsWith('file://') ? decodeURIComponent(new URL(filename).pathname) : ctx.fs.resolvePath(filename, ctx.cwd);
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

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    // Transform TypeScript/JSX/ESM syntax for execution
    let transformedCode = isClaudeCodeScript(scriptPath) ? patchClaudeCodeSource(code) : code;
    if (scriptPath && (scriptPath.endsWith('.ts') || scriptPath.endsWith('.tsx'))) {
      transformedCode = transformTS(transformedCode);
    }
    if (scriptPath && (scriptPath.endsWith('.tsx') || scriptPath.endsWith('.jsx'))) {
      transformedCode = transformJSX(transformedCode);
    }
    transformedCode = transformESModules(transformedCode);

    // Stash real browser console on globalThis so injected code can use it
    if (code.length > 500000) {
      (globalThis as any).__realConsole = console;
    }

    const wrappedCode = printResult ? `return (${transformedCode})` : transformedCode;
    const fn = compileAsyncModule(AsyncFunction, [
      'console', 'process', 'require', 'Buffer', '__filename', '__dirname', 'shiro', '__import_meta', 'module', 'exports', '__dynamic_import',
      '__shiro_module', '__shiro_require', 'global', '__shiro_require_ready',
    ], wrappedCode);

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
    }

    // CORS proxy setup
    const corsProxyOrigin = typeof window !== 'undefined' ? getShiroOrigin() : '';
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

    if (corsProxyOrigin) {
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
        return _origFetch(input, init);
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
      // Intervals never kept a script alive here; they still answer unref() etc.
      globalThis.setInterval = _st.installedSetInterval = function(fn: any, ms?: number, ...args: any[]) {
        return nodeTimer(PAGE_SET_INTERVAL(fn, ms, ...args), {});
      } as typeof setInterval;
      globalThis.clearInterval = _st.installedClearInterval = function(id: any) { PAGE_CLEAR_INTERVAL(rawTimer(id)); };
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
        if (activity.pending > 0 || _activeTimers > 0 || pendingPromises.length > 0 || out !== outSeen) {
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
        }, fakeImportMeta, fakeModule, fakeExports, dynamicImport, fakeModule, entryRequire, globalThis,
        (p: string) => requireModule.ready(p, entryDirname, entryFilename)),
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
    if (_activeTimers > 0 && _timersDone && !_st.isInteractiveMode) {
      try {
        await Promise.race([_timersDone, new Promise((_, rej) => _baseST(() => rej('timer-wait-timeout'), 5000))]);
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
      const deferredTimeout = new Promise<never>((_, reject) => {
        let outSeen = stdoutBuf.length + stderrBuf.length;
        const check = () => {
          const out = stdoutBuf.length + stderrBuf.length;
          if (!_st.isInteractiveMode && (activity.pending > 0 || out !== outSeen)) {
            outSeen = out;
            _baseST(check, DEFERRED_TIMEOUT);
            return;
          }
          reject(new ProcessExitError(124));
        };
        _baseST(check, DEFERRED_TIMEOUT); // untracked: not script activity
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
          if (out !== outSeen || activity.pending > 0 || (_activeTimers > 0 && !timersOutlasted)) {
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
      ctx.stdout += formatArg(result) + '\n';
    }

    // Clean up
    if (ctx.terminal && _st.ownsStdinPassthrough) ctx.terminal.exitStdinPassthrough();
    if (typeof window !== 'undefined') {
      setTimeout(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000);
    }
    restoreGlobals(true);

    return _st.exitCode;
  } catch (e: any) {
    // Clean up on error
    if (ctx.terminal && _st.ownsStdinPassthrough) ctx.terminal.exitStdinPassthrough();
    if (typeof window !== 'undefined') {
      setTimeout(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000);
    }
    restoreGlobals(true);
    const msg = e.message || String(e);
    console.error('[node] Script error:', e);
    ctx.stderr += `Error: ${msg}\n`;
    return 1;
  }
}
