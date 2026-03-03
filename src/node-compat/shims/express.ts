/**
 * Express framework shim for Shiro's virtual server.
 * Extracted from node-cmd.ts createExpressShim().
 */

import type { CommandContext } from '../../commands/index';
import type { VirtualRequest, VirtualResponse } from '../../iframe-server';

export interface ExpressDeps {
  ctx: CommandContext;
  iframeServer: {
    serve: (port: number, handler: (req: any) => Promise<any>, label: string) => () => void;
    createIframe: (port: number, container: any, opts: { height: string }) => Promise<any>;
  };
  fakeConsole: { log: (...args: any[]) => void; warn: (...args: any[]) => void };
  pendingPromises: Promise<any>[];
}

export function createExpressFactory(deps: ExpressDeps): any {
  const { ctx, iframeServer, fakeConsole, pendingPromises } = deps;

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
          if (vReq.headers?.['content-type']?.includes('application/json') && vReq.body) {
            parsedBody = JSON.parse(vReq.body);
          }
        } catch {}

        // Build request object
        const req: any = {
          method: vReq.method,
          url: vReq.path,
          path: vReq.path,
          headers: vReq.headers || {},
          query: vReq.query || {},
          body: parsedBody,
          params: {},
          get(name: string) { return (vReq.headers || {})[name.toLowerCase()]; },
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
          // Close split-view pane
          try {
            if (typeof document !== 'undefined') {
              import('../../split-view').then(({ closeSplitView }) => closeSplitView()).catch(() => {});
            }
          } catch {}
          resolve();
        };

        fakeConsole.log(`Express app listening on port ${port}`);

        // Open split-view preview pane
        try {
          if (typeof document !== 'undefined') {
            import('../../split-view').then(({ createSplitView }) => {
              createSplitView({ port, direction: 'right', title: `Express :${port}` });
              fakeConsole.log('Browser window opened');
            }).catch((err: Error) => fakeConsole.warn('Could not open browser:', err.message));
          }
        } catch {}

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

  return createExpressShim;
}
