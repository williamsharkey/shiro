/**
 * Node.js script execution harness.
 * Orchestrates all node-compat modules and manages script lifecycle.
 * Extracted from node-cmd.ts exec() body.
 */

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
import { createAutoStubFactory } from './auto-stub';
import { createRequireFunction } from './require';
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
      _nodeStderrBuf?.push(`UnhandledPromiseRejection: ${errStr}`);
      if (ctx.terminal) ctx.terminal.writeOutput(`\x1b[31mUnhandledPromiseRejection: ${errStr}\x1b[0m\r\n`);
      event.preventDefault();
    }
  };

  // Save originals for CORS proxy interception
  const _origFetch = globalThis.fetch;
  const _origXHR = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined;
  const _prevST = globalThis.setTimeout;
  const _prevCT = globalThis.clearTimeout;

  // Shared mutable state
  const _st: SharedState = {
    exitCode: 0,
    exitCalled: false,
    streamedToTerminal: false,
    isInteractiveMode: false,
    scriptTimeoutId: null,
    ownsStdinPassthrough: false,
    deferredExitResolve: null,
    fakeProcess: null,
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
        case 'node:fs': return createFsModule({ ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir });
        case 'fs/promises':
        case 'node:fs/promises': return createFsPromisesModule({ ctx, fileCache, fileMtimes, pendingPromises, tickSyncOps, FakeBuffer, getBuiltinModule, homeDir });
        case 'child_process':
        case 'node:child_process': return createChildProcessModule({ ctx, fileCache, fileMtimes, pendingPromises, FakeBuffer });
        case 'os':
        case 'node:os': return createOsModule(ctx);
        case 'util':
        case 'node:util': return createUtilModule();
        case 'events':
        case 'node:events': return createEventsModule();
        case 'url':
        case 'node:url': return createUrlModule();
        case 'stream':
        case 'node:stream': return createStreamModule();
        case 'stream/promises':
        case 'node:stream/promises': return createStreamModule().promises;
        case 'crypto':
        case 'node:crypto': return createCryptoModule({ sha256sync, sha1sync, fnvHash, FakeBuffer });
        case 'http':
        case 'node:http': return createHttpModule({ ctx, iframeServer, fakeConsole, getBuiltinModule });
        case 'https':
        case 'node:https': return createHttpsModule({ ctx, iframeServer, fakeConsole, getBuiltinModule });
        case 'net':
        case 'node:net': return createNetModule();
        case 'tls':
        case 'node:tls': return createTlsModule({ getBuiltinModule });
        case 'http2':
        case 'node:http2': return createHttp2Module();
        default: {
          const appShim = createAppShim(name, { ctx, fileCache, fakeProcess });
          if (appShim !== null) return appShim;
          return createMiscModule(name, { ctx, FakeBuffer, fakeProcess, fakeConsole, getBuiltinModule, fileCache, moduleCache, requireModule });
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

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    // Transform TypeScript/JSX/ESM syntax for execution
    let transformedCode = code;
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

    // Create require function for the entry script
    const entryRequire = (moduleName: string) => requireModule(moduleName, entryDirname);

    // Dynamic import() shim
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

    // CORS proxy setup
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

    // Polyfill setImmediate/clearImmediate
    const _origSetImmediate = (globalThis as any).setImmediate;
    const _origClearImmediate = (globalThis as any).clearImmediate;
    (globalThis as any).setImmediate = (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args);
    (globalThis as any).clearImmediate = (id: any) => clearTimeout(id);

    // Track active timers
    let _activeTimers = 0;
    let _timersResolve: (() => void) | null = null;
    let _timersDone: Promise<void> | null = null;
    const _timerIds = new Set<any>();
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

    // Script execution timeout — scale up for large bundles (e.g. TypeScript ~5MB)
    const SCRIPT_TIMEOUT = code.length > 500_000 ? 60_000 : 15_000;
    let scriptTimedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      _st.scriptTimeoutId = setTimeout(() => {
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
        _st.exitCode = e.code;
      } else if (e.message?.includes('extends value') || e.message?.includes('is not a constructor') || e.message?.includes('prototype')) {
        stderrBuf.push(e.message);
        _st.exitCode = 1;
      } else if (e.name === 'ReferenceError' || e.name === 'TypeError' || e.name === 'SyntaxError') {
        stderrBuf.push(e.message || String(e));
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
    if (_activeTimers > 0 && _timersDone && !_st.isInteractiveMode) {
      try {
        await Promise.race([_timersDone, new Promise((_, rej) => _prevST(() => rej('timer-wait-timeout'), 5000))]);
      } catch { /* timeout is fine */ }
    }

    // Restore setTimeout/clearTimeout before deferred exit
    if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }

    // Deferred exit wait
    const hasFinishedOutput = _st.exitCalled || scriptTimedOut
      || stdoutBuf.length > 0 || stderrBuf.length > 0 || _st.streamedToTerminal
      || printResult;
    if (_st.isInteractiveMode || !hasFinishedOutput) {
      const DEFERRED_TIMEOUT = _st.isInteractiveMode ? 86400000 : code.length > 500000 ? 300000 : 10000;
      const deferredTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new ProcessExitError(124)), DEFERRED_TIMEOUT);
      });
      let freshExitPromise = deferredExitPromise;
      if (_st.exitCalled && _st.isInteractiveMode) {
        freshExitPromise = new Promise<number>(resolve => {
          _st.deferredExitResolve = resolve;
        });
        _st.exitCalled = false;
      }
      try {
        const waitCode = await Promise.race([freshExitPromise, deferredTimeout]);
        _st.exitCode = waitCode;
      } catch (e: any) {
        if (e instanceof ProcessExitError) {
          _st.exitCode = e.code;
        }
      }
    }

    // Flush output
    if (stdoutBuf.length > 0 && !_st.streamedToTerminal) {
      ctx.stdout += stdoutBuf.join('\n') + '\n';
    }
    if (stderrBuf.length > 0 && !_st.streamedToTerminal) {
      ctx.stderr += stderrBuf.join('\n') + '\n';
    }

    if (printResult && !_st.exitCalled) {
      ctx.stdout += formatArg(result) + '\n';
    }

    // Clean up
    if (ctx.terminal && _st.ownsStdinPassthrough) ctx.terminal.exitStdinPassthrough();
    if (typeof window !== 'undefined') {
      setTimeout(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000);
    }
    globalThis.fetch = _origFetch;
    if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }
    if (_origSetImmediate) (globalThis as any).setImmediate = _origSetImmediate; else delete (globalThis as any).setImmediate;
    if (_origClearImmediate) (globalThis as any).clearImmediate = _origClearImmediate; else delete (globalThis as any).clearImmediate;

    return _st.exitCode;
  } catch (e: any) {
    // Clean up on error
    if (ctx.terminal && _st.ownsStdinPassthrough) ctx.terminal.exitStdinPassthrough();
    if (typeof window !== 'undefined') {
      setTimeout(() => window.removeEventListener('unhandledrejection', suppressRejection), 1000);
    }
    globalThis.fetch = _origFetch;
    if (code.length <= 500000) { globalThis.setTimeout = _prevST; globalThis.clearTimeout = _prevCT; }
    delete (globalThis as any).setImmediate;
    delete (globalThis as any).clearImmediate;
    const msg = e.message || String(e);
    console.error('[node] Script error:', e);
    ctx.stderr += `Error: ${msg}\n`;
    return 1;
  }
}
