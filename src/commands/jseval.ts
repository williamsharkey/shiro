import { Command, CommandContext } from './index';
import { virtualServer, VirtualRequest, VirtualResponse } from '../virtual-server';

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

    // Parse args
    const fileArgs: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      if (ctx.args[i] === '-e' || ctx.args[i] === '--eval') {
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
      }
    }

    // If no -e flag, read from file
    if (!code && fileArgs.length > 0) {
      const filePath = ctx.fs.resolvePath(fileArgs[0], ctx.cwd);
      try {
        code = await ctx.fs.readFile(filePath, 'utf8') as string;
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

    try {
      // Build a minimal Node-like environment
      let exitCode = 0;
      let exitCalled = false;

      const stdoutBuf: string[] = [];
      const stderrBuf: string[] = [];

      const fakeConsole = {
        log: (...args: any[]) => { stdoutBuf.push(args.map(formatArg).join(' ')); },
        info: (...args: any[]) => { stdoutBuf.push(args.map(formatArg).join(' ')); },
        warn: (...args: any[]) => { stderrBuf.push(args.map(formatArg).join(' ')); },
        error: (...args: any[]) => { stderrBuf.push(args.map(formatArg).join(' ')); },
        dir: (obj: any) => { stdoutBuf.push(JSON.stringify(obj, null, 2)); },
      };

      const fakeProcess = {
        env: { ...ctx.env },
        cwd: () => ctx.cwd,
        exit: (c?: number) => { exitCode = c || 0; exitCalled = true; throw new ProcessExitError(exitCode); },
        argv: ['node', ...fileArgs],
        platform: 'browser',
        version: 'v0.1.0-shiro',
        stdout: { write: (s: string) => { stdoutBuf.push(s); } },
        stderr: { write: (s: string) => { stderrBuf.push(s); } },
      };

      // CommonJS require() with pre-loaded file cache
      const fileCache = new Map<string, string>();
      const moduleCache = new Map<string, { exports: any }>();

      // Pre-load node_modules (Shiro readdir returns string[])
      async function preloadDir(dir: string, depth = 0, maxDepth = 5) {
        if (depth > maxDepth) return;
        try {
          const entries = await ctx.fs.readdir(dir);
          for (const name of entries) {
            if (name === '.git') continue;
            // Skip node_modules inside project dirs (handled separately)
            if (name === 'node_modules' && depth > 0) continue;
            const fp = dir + '/' + name;
            try {
              const st = await ctx.fs.stat(fp);
              if (st.isDirectory()) {
                await preloadDir(fp, depth + 1, maxDepth);
              } else if (st.size < 1048576) { // 1MB limit
                const content = await ctx.fs.readFile(fp, 'utf8');
                fileCache.set(fp, content as string);
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }

      // Pre-load files from common locations
      const preloadDirs = [ctx.cwd];
      const homeDir = ctx.env['HOME'] || '/home/user';
      if (homeDir !== ctx.cwd) preloadDirs.push(homeDir);
      preloadDirs.push('/tmp');

      for (const dir of preloadDirs) {
        await preloadDir(dir, 0, 5);
      }

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

      // Buffer shim — provides from(), alloc(), isBuffer(), toString()
      const FakeBuffer: any = {
        from: (input: any, _encoding?: string): any => {
          if (typeof input === 'string') {
            const bytes = new TextEncoder().encode(input);
            return Object.assign(bytes, {
              toString: (_enc?: string) => input,
              toJSON: () => ({ type: 'Buffer', data: Array.from(bytes) }),
            });
          }
          if (input instanceof Uint8Array) {
            return Object.assign(new Uint8Array(input), {
              toString: (_enc?: string) => new TextDecoder().decode(input),
              toJSON: () => ({ type: 'Buffer', data: Array.from(input) }),
            });
          }
          if (Array.isArray(input)) {
            const bytes = new Uint8Array(input);
            return Object.assign(bytes, {
              toString: (_enc?: string) => new TextDecoder().decode(bytes),
              toJSON: () => ({ type: 'Buffer', data: input }),
            });
          }
          return new Uint8Array(0);
        },
        alloc: (size: number) => {
          const bytes = new Uint8Array(size);
          return Object.assign(bytes, { toString: () => new TextDecoder().decode(bytes) });
        },
        isBuffer: (obj: any) => obj instanceof Uint8Array,
        concat: (list: Uint8Array[]) => {
          const total = list.reduce((n: number, b: Uint8Array) => n + b.length, 0);
          const result = new Uint8Array(total);
          let offset = 0;
          for (const buf of list) { result.set(buf, offset); offset += buf.length; }
          return Object.assign(result, { toString: () => new TextDecoder().decode(result) });
        },
      };

      // Built-in Node.js module shims (maps to Shiro VFS/shell)
      function getBuiltinModule(name: string): any | null {
        switch (name) {
          case 'path':
          case 'node:path': return {
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
          };
          case 'fs':
          case 'node:fs': {
            // Synchronous shims that use cached data or throw
            const fsShim: any = {
              readFileSync: (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const cached = fileCache.get(resolved) ?? fileCache.get(resolved + '.js');
                if (cached !== undefined) return cached;
                throw new Error(`ENOENT: no such file or directory, open '${p}'`);
              },
              writeFileSync: (p: string, data: string | Uint8Array) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const strData = typeof data === 'string' ? data : new TextDecoder().decode(data);
                fileCache.set(resolved, strData);
                // Queue actual VFS write (fire-and-forget)
                ctx.fs.writeFile(resolved, strData).catch(() => {});
              },
              existsSync: (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                return fileCache.has(resolved) || fileCache.has(resolved + '.js') || fileCache.has(resolved + '/index.js');
              },
              statSync: (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                // Check if it's a known file or directory prefix
                const isFile = fileCache.has(resolved);
                const isDir = [...fileCache.keys()].some(k => k.startsWith(resolved + '/'));
                if (!isFile && !isDir) throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
                return {
                  isFile: () => isFile,
                  isDirectory: () => isDir && !isFile,
                  isSymbolicLink: () => false,
                  size: isFile ? (fileCache.get(resolved) || '').length : 0,
                  mtime: new Date(),
                };
              },
              readdirSync: (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const prefix = resolved === '/' ? '/' : resolved + '/';
                const entries = new Set<string>();
                for (const key of fileCache.keys()) {
                  if (key.startsWith(prefix)) {
                    const rest = key.slice(prefix.length);
                    const first = rest.split('/')[0];
                    if (first) entries.add(first);
                  }
                }
                return [...entries].sort();
              },
              mkdirSync: (p: string, opts?: any) => {
                ctx.fs.mkdir(ctx.fs.resolvePath(p, ctx.cwd), opts).catch(() => {});
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
                  ctx.fs.writeFile(dstRes, cached).catch(() => {});
                } else {
                  ctx.fs.readFile(srcRes, 'utf8').then((data: any) => ctx.fs.writeFile(dstRes, data)).catch(() => {});
                }
              },
              renameSync: (oldP: string, newP: string) => {
                ctx.fs.rename(ctx.fs.resolvePath(oldP, ctx.cwd), ctx.fs.resolvePath(newP, ctx.cwd)).catch(() => {});
              },
              // Async promises API
              promises: {
                readFile: async (p: string, opts?: any) => {
                  const encoding = typeof opts === 'string' ? opts : opts?.encoding;
                  return await ctx.fs.readFile(ctx.fs.resolvePath(p, ctx.cwd), encoding || 'utf8');
                },
                writeFile: async (p: string, data: string) => {
                  await ctx.fs.writeFile(ctx.fs.resolvePath(p, ctx.cwd), data);
                },
                readdir: async (p: string) => ctx.fs.readdir(ctx.fs.resolvePath(p, ctx.cwd)),
                stat: async (p: string) => ctx.fs.stat(ctx.fs.resolvePath(p, ctx.cwd)),
                mkdir: async (p: string, opts?: any) => ctx.fs.mkdir(ctx.fs.resolvePath(p, ctx.cwd), opts),
                unlink: async (p: string) => ctx.fs.unlink(ctx.fs.resolvePath(p, ctx.cwd)),
                access: async (p: string) => {
                  const exists = await ctx.fs.exists(ctx.fs.resolvePath(p, ctx.cwd));
                  if (!exists) throw new Error(`ENOENT: no such file or directory, access '${p}'`);
                },
              },
            };
            return fsShim;
          }
          case 'child_process':
          case 'node:child_process': {
            // execAsync is the underlying impl — returns a Promise
            const execAsync = async (cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
              let stdout = '';
              let stderr = '';
              const exitCode = await ctx.shell.execute(cmd, (s) => { stdout += s; }, (s) => { stderr += s; });
              return { stdout, stderr, exitCode };
            };
            return {
              execSync: (cmd: string, opts?: any) => {
                // In browser, execSync cannot truly block. We return a placeholder
                // Buffer and queue the actual execution. Works correctly when the
                // result is used at top-level of an async script (node -e).
                let result = '';
                const p = execAsync(cmd).then(r => { result = r.stdout; });
                // Create a thenable Buffer-like that resolves when awaited
                const buf: any = {
                  toString: () => result,
                  then: (resolve: any, reject: any) => p.then(() => resolve(FakeBuffer.from(result))).catch(reject),
                  [Symbol.toPrimitive]: () => result,
                };
                return buf;
              },
              spawnSync: (cmd: string, args?: string[]) => {
                const fullCmd = args ? `${cmd} ${args.join(' ')}` : cmd;
                let stdout = '';
                let stderr = '';
                let status = 0;
                execAsync(fullCmd).then(r => { stdout = r.stdout; stderr = r.stderr; status = r.exitCode; });
                return {
                  get stdout() { return FakeBuffer.from(stdout); },
                  get stderr() { return FakeBuffer.from(stderr); },
                  get status() { return status; },
                };
              },
              exec: (cmd: string, opts: any, cb?: any) => {
                const callback = typeof opts === 'function' ? opts : cb;
                execAsync(cmd)
                  .then(r => callback?.(r.exitCode !== 0 ? new Error(`Exit code ${r.exitCode}`) : null, r.stdout, r.stderr))
                  .catch(e => callback?.(e, '', ''));
              },
              execFile: (file: string, args: string[], opts: any, cb?: any) => {
                const callback = typeof opts === 'function' ? opts : cb;
                const cmd = `${file} ${(args || []).join(' ')}`;
                execAsync(cmd)
                  .then(r => callback?.(r.exitCode !== 0 ? new Error(`Exit code ${r.exitCode}`) : null, r.stdout, r.stderr))
                  .catch(e => callback?.(e, '', ''));
              },
            };
          }
          case 'os':
          case 'node:os': return {
            platform: () => 'browser',
            arch: () => 'wasm',
            homedir: () => ctx.env['HOME'] || '/home/user',
            tmpdir: () => '/tmp',
            hostname: () => 'shiro',
            type: () => 'Shiro',
            release: () => '0.1.0',
            cpus: () => [{ model: 'Browser', speed: 0 }],
            totalmem: () => 0,
            freemem: () => 0,
            EOL: '\n',
          };
          case 'util':
          case 'node:util': return {
            promisify: (fn: Function) => (...args: any[]) => new Promise((resolve, reject) => {
              fn(...args, (err: any, result: any) => err ? reject(err) : resolve(result));
            }),
            inspect: (obj: any) => JSON.stringify(obj, null, 2),
            format: (...args: any[]) => args.map(String).join(' '),
            types: { isDate: (v: any) => v instanceof Date, isRegExp: (v: any) => v instanceof RegExp },
          };
          case 'events':
          case 'node:events': {
            class EventEmitter {
              private _events: Record<string, Function[]> = {};
              on(event: string, fn: Function) { (this._events[event] ??= []).push(fn); return this; }
              off(event: string, fn: Function) { this._events[event] = (this._events[event] || []).filter(f => f !== fn); return this; }
              emit(event: string, ...args: any[]) { (this._events[event] || []).forEach(fn => fn(...args)); return true; }
              once(event: string, fn: Function) {
                const wrapper = (...args: any[]) => { this.off(event, wrapper); fn(...args); };
                return this.on(event, wrapper);
              }
              removeAllListeners(event?: string) { if (event) delete this._events[event]; else this._events = {}; return this; }
            }
            return { EventEmitter, default: EventEmitter };
          }
          case 'url':
          case 'node:url': return {
            URL: globalThis.URL,
            URLSearchParams: globalThis.URLSearchParams,
            parse: (urlStr: string) => new URL(urlStr),
            format: (urlObj: any) => urlObj.toString ? urlObj.toString() : String(urlObj),
          };
          case 'assert':
          case 'node:assert': {
            const assert: any = (val: any, msg?: string) => { if (!val) throw new Error(msg || `AssertionError: ${val}`); };
            assert.ok = assert;
            assert.equal = (a: any, b: any, msg?: string) => { if (a != b) throw new Error(msg || `AssertionError: ${a} != ${b}`); };
            assert.strictEqual = (a: any, b: any, msg?: string) => { if (a !== b) throw new Error(msg || `AssertionError: ${a} !== ${b}`); };
            assert.deepEqual = assert.deepStrictEqual = (a: any, b: any, msg?: string) => {
              if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `AssertionError: deep equal failed`);
            };
            assert.throws = (fn: Function, msg?: string) => {
              try { fn(); throw new Error(msg || 'Expected function to throw'); } catch(e: any) { if (e.message === (msg || 'Expected function to throw')) throw e; }
            };
            assert.notEqual = (a: any, b: any, msg?: string) => { if (a == b) throw new Error(msg || `AssertionError: ${a} == ${b}`); };
            return assert;
          }
          case 'buffer':
          case 'node:buffer': return { Buffer: FakeBuffer };
          case 'stream':
          case 'node:stream': {
            // Minimal stream shim — just enough for common usage
            class Readable {
              _read() {}
              pipe(dest: any) { return dest; }
              on(_event: string, _cb: Function) { return this; }
            }
            class Writable {
              write(_chunk: any) { return true; }
              end() {}
              on(_event: string, _cb: Function) { return this; }
            }
            return { Readable, Writable };
          }
          case 'crypto':
          case 'node:crypto': return {
            randomBytes: (n: number) => {
              const bytes = new Uint8Array(n);
              crypto.getRandomValues(bytes);
              return Object.assign(bytes, { toString: (enc: string) => {
                if (enc === 'hex') return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
                return new TextDecoder().decode(bytes);
              }});
            },
            createHash: (algo: string) => {
              let data = '';
              return {
                update: (d: string) => { data += d; return { digest: (enc: string) => `${algo}:${data.length}` }; },
              };
            },
            randomUUID: () => crypto.randomUUID(),
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
                on(event: string, cb: Function) {
                  if (event === 'request' && !requestHandler) {
                    requestHandler = cb as any;
                  }
                  (this._events[event] ??= []).push(cb);
                  return this;
                },
                emit(event: string, ...args: any[]) {
                  (this._events[event] || []).forEach((fn: Function) => fn(...args));
                },
                listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void) {
                  const cb = typeof hostOrCallback === 'function' ? hostOrCallback : callback;
                  listeningPort = port;

                  // Ensure virtual server is initialized
                  virtualServer.init().then(() => {
                    cleanupFn = virtualServer.listen(port, async (vReq: VirtualRequest): Promise<VirtualResponse> => {
                      return new Promise((resolve) => {
                        // Build Node-like request object
                        const req: any = {
                          method: vReq.method,
                          url: vReq.path + (Object.keys(vReq.query).length ? '?' + new URLSearchParams(vReq.query).toString() : ''),
                          headers: vReq.headers,
                          query: vReq.query,
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
                    }, `http:${port}`);

                    const url = virtualServer.getUrl(port);
                    fakeConsole.log(`Server listening on port ${port}`);
                    fakeConsole.log(`Access at: ${url}`);
                    server.emit('listening');
                    cb?.();
                  });

                  return this;
                },
                close(cb?: () => void) {
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
              };
              return server;
            };

            return {
              createServer,
              Server: function(handler?: any) { return createServer(handler); },
              request: () => { throw new Error('http.request not implemented - use fetch()'); },
              get: () => { throw new Error('http.get not implemented - use fetch()'); },
            };
          }
          default: return null;
        }
      }

      // Express-like framework shim that uses virtual server
      function createExpressShim() {
        const app: any = function(req: any, res: any, next?: any) {
          // Middleware function - pass through
          next?.();
        };

        const middlewares: Array<{ path: string; handler: Function }> = [];
        const routes: Array<{ method: string; path: string; handlers: Function[] }> = [];

        // Helper to match Express-style paths
        function matchPath(pattern: string, path: string): Record<string, string> | null {
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
            };

            // Run middleware chain then routes
            let middlewareIndex = 0;
            const runNext = () => {
              // First run global middleware
              while (middlewareIndex < middlewares.length) {
                const mw = middlewares[middlewareIndex++];
                const params = matchPath(mw.path, req.path);
                if (params !== null) {
                  req.params = { ...req.params, ...params };
                  try {
                    mw.handler(req, res, runNext);
                    return; // Wait for next() to be called
                  } catch (err: any) {
                    resolve({ status: 500, body: `Middleware error: ${err.message}` });
                    return;
                  }
                }
              }

              // Then match routes
              for (const route of routes) {
                if (route.method !== req.method && route.method !== 'ALL') continue;
                const params = matchPath(route.path, req.path);
                if (params !== null) {
                  req.params = { ...req.params, ...params };
                  // Run route handlers in sequence
                  let handlerIndex = 0;
                  const runHandler = () => {
                    if (handlerIndex < route.handlers.length) {
                      try {
                        route.handlers[handlerIndex++](req, res, runHandler);
                      } catch (err: any) {
                        resolve({ status: 500, body: `Handler error: ${err.message}` });
                      }
                    }
                  };
                  runHandler();
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

        // Route methods
        const addRoute = (method: string) => (path: string, ...handlers: Function[]) => {
          routes.push({ method, path, handlers });
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

        // Listen method
        app.listen = (port: number, hostOrCb?: string | (() => void), cb?: () => void) => {
          const callback = typeof hostOrCb === 'function' ? hostOrCb : cb;

          virtualServer.init().then(() => {
            virtualServer.listen(port, app._handleRequest, `express:${port}`);
            const url = virtualServer.getUrl(port);
            fakeConsole.log(`Express app listening on port ${port}`);
            fakeConsole.log(`Access at: ${url}`);
            callback?.();
          });

          return { close: () => virtualServer.close(port) };
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
      (createExpressShim as any).Router = () => {
        const router: any = (req: any, res: any, next: Function) => next();
        router.routes = [] as Array<{ method: string; path: string; handlers: Function[] }>;
        router.get = (path: string, ...handlers: Function[]) => { router.routes.push({ method: 'GET', path, handlers }); return router; };
        router.post = (path: string, ...handlers: Function[]) => { router.routes.push({ method: 'POST', path, handlers }); return router; };
        router.put = (path: string, ...handlers: Function[]) => { router.routes.push({ method: 'PUT', path, handlers }); return router; };
        router.delete = (path: string, ...handlers: Function[]) => { router.routes.push({ method: 'DELETE', path, handlers }); return router; };
        return router;
      };

      // Cache for sql.js initialization
      let sqlJsPromise: Promise<any> | null = null;
      const sqliteDatabases = new Map<string, any>(); // path -> sql.js Database

      // better-sqlite3 shim using sql.js
      function createBetterSqlite3Shim() {
        // Load sql.js from CDN (lazy, once)
        async function loadSqlJs(): Promise<any> {
          // Check if we're in a browser environment
          if (typeof window === 'undefined') {
            throw new Error('better-sqlite3 shim requires browser environment (sql.js WASM)');
          }

          if (!sqlJsPromise) {
            sqlJsPromise = (async () => {
              const initSqlJs = (window as any).initSqlJs;
              if (initSqlJs) {
                return await initSqlJs({
                  locateFile: (file: string) => `https://sql.js.org/dist/${file}`
                });
              }
              // Load the script if not already loaded
              await new Promise<void>((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://sql.js.org/dist/sql-wasm.js';
                script.onload = () => resolve();
                script.onerror = reject;
                document.head.appendChild(script);
              });
              return await (window as any).initSqlJs({
                locateFile: (file: string) => `https://sql.js.org/dist/${file}`
              });
            })();
          }
          return sqlJsPromise;
        }

        // Database class mimicking better-sqlite3
        class Database {
          private db: any = null;
          private dbPath: string;
          private SQL: any = null;
          private initPromise: Promise<void> | null = null;
          private _isReady = false;

          constructor(path: string, options?: any) {
            this.dbPath = ctx.fs.resolvePath(path, ctx.cwd);
            // Don't auto-init - wait until first use (allows structure tests in Node)
          }

          private async _init(): Promise<void> {
            if (this._isReady) return;

            this.SQL = await loadSqlJs();

            // Check if we have this database cached
            if (sqliteDatabases.has(this.dbPath)) {
              this.db = sqliteDatabases.get(this.dbPath);
              this._isReady = true;
              return;
            }

            // Try to load from virtual filesystem
            try {
              const data = await ctx.fs.readFile(this.dbPath);
              if (data instanceof Uint8Array) {
                this.db = new this.SQL.Database(data);
              } else {
                // File exists but is empty or text - create new
                this.db = new this.SQL.Database();
              }
            } catch {
              // File doesn't exist - create new database
              this.db = new this.SQL.Database();
            }

            sqliteDatabases.set(this.dbPath, this.db);
            this._isReady = true;
          }

          private ensureReady(): void {
            if (!this._isReady) {
              // Trigger init synchronously for the error message, but it won't block
              if (!this.initPromise) {
                this.initPromise = this._init();
              }
              throw new Error('Database not initialized. Call await db.ready first, or use async patterns.');
            }
          }

          prepare(sql: string): Statement {
            this.ensureReady();
            return new Statement(this.db, sql);
          }

          exec(sql: string): this {
            this.ensureReady();
            this.db.run(sql);
            this._save();
            return this;
          }

          pragma(pragma: string, options?: any): any {
            this.ensureReady();
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
            return () => {
              this.exec('BEGIN');
              try {
                const result = fn();
                this.exec('COMMIT');
                return result;
              } catch (err) {
                this.exec('ROLLBACK');
                throw err;
              }
            };
          }

          close(): void {
            this._save();
            if (this.db) {
              this.db.close();
              sqliteDatabases.delete(this.dbPath);
              this.db = null;
            }
          }

          private _save(): void {
            if (!this.db) return;
            const data = this.db.export();
            ctx.fs.writeFile(this.dbPath, data).catch(() => {});
          }

          // Expose the init promise for async usage
          get ready(): Promise<void> {
            if (!this.initPromise) {
              this.initPromise = this._init();
            }
            return this.initPromise;
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

        return Database;
      }

      function requireModule(modPath: string, fromDir: string): any {
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
        if (builtin !== null) return builtin;

        let resolved = modPath;

        if (modPath.startsWith('./') || modPath.startsWith('../') || modPath.startsWith('/')) {
          resolved = ctx.fs.resolvePath(modPath, fromDir);
          if (!resolved.endsWith('.js') && !resolved.endsWith('.json')) {
            if (fileCache.has(resolved + '.js')) resolved += '.js';
            else if (fileCache.has(resolved + '/index.js')) resolved += '/index.js';
          }
        } else {
          // Walk up directories to find node_modules (npm resolution)
          let searchDir = fromDir.startsWith('/') ? fromDir : ctx.cwd;
          let found = false;
          while (searchDir) {
            const nmPath = `${searchDir}/node_modules/${modPath}`;
            const pkgPath = `${nmPath}/package.json`;

            if (fileCache.has(pkgPath)) {
              try {
                const pkg = JSON.parse(fileCache.get(pkgPath)!);
                let main = pkg.main || 'index.js';
                main = main.replace(/^\.\//, '');
                if (!main.endsWith('.js') && !main.endsWith('.json')) main += '.js';
                resolved = `${nmPath}/${main}`;
              } catch {
                resolved = `${nmPath}/index.js`;
              }
              found = true;
              break;
            }
            if (fileCache.has(`${nmPath}/index.js`)) {
              resolved = `${nmPath}/index.js`;
              found = true;
              break;
            }
            // Move up one directory
            const parent = searchDir.substring(0, searchDir.lastIndexOf('/')) || '';
            if (parent === searchDir || !parent) break;
            searchDir = parent;
          }
          if (!found) {
            resolved = `${ctx.cwd}/node_modules/${modPath}/index.js`;
          }
        }

        if (moduleCache.has(resolved)) return moduleCache.get(resolved)!.exports;

        const content = fileCache.get(resolved);
        if (content === undefined) {
          throw new Error(`Cannot find module '${modPath}'`);
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
          const wrapped = new Function(
            'module', 'exports', 'require', '__filename', '__dirname',
            'console', 'process', 'global', 'Buffer',
            transformedContent
          );
          wrapped(mod, mod.exports, nestedRequire, resolved, modDir,
            fakeConsole, fakeProcess, globalThis, FakeBuffer
          );
        } catch (err) {
          moduleCache.delete(resolved);
          throw err;
        }

        return mod.exports;
      }

      const fakeRequire = (moduleName: string) => requireModule(moduleName, ctx.cwd);

      // Transform ES module syntax to CommonJS
      function transformESModules(src: string): string {
        // import x from 'y' → const x = require('y')
        src = src.replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          'const $1 = require("$2");');

        // import { a, b } from 'y' → const { a, b } = require('y')
        src = src.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          'const {$1} = require("$2");');

        // import * as x from 'y' → const x = require('y')
        src = src.replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
          'const $1 = require("$2");');

        // import 'y' → require('y')
        src = src.replace(/import\s+['"]([^'"]+)['"]\s*;?/g,
          'require("$1");');

        // export default x → module.exports = x
        src = src.replace(/export\s+default\s+/g, 'module.exports = ');

        // export { x, y } → module.exports = { x, y }
        src = src.replace(/export\s+\{([^}]+)\}\s*;?/g, 'module.exports = {$1};');

        // export const x = ... → const x = ...; module.exports.x = x;
        src = src.replace(/export\s+(const|let|var)\s+(\w+)\s*=/g,
          '$1 $2 =');

        return src;
      }

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      // Transform ES modules and wrap for execution
      const transformedCode = transformESModules(code);
      const wrappedCode = printResult ? `return (${transformedCode})` : transformedCode;
      const fn = new AsyncFunction('console', 'process', 'require', 'Buffer', 'shiro', `
        ${wrappedCode}
      `);

      let result;
      try {
        result = await fn(fakeConsole, fakeProcess, fakeRequire, FakeBuffer, {
          fs: ctx.fs,
          shell: ctx.shell,
          env: ctx.env,
          cwd: ctx.cwd,
        });
      } catch (e: any) {
        if (e instanceof ProcessExitError) {
          exitCode = e.code;
        } else {
          throw e;
        }
      }

      // Flush output
      if (stdoutBuf.length > 0) {
        ctx.stdout += stdoutBuf.join('\n') + '\n';
      }
      if (stderrBuf.length > 0) {
        ctx.stderr += stderrBuf.join('\n') + '\n';
      }

      if (printResult && result !== undefined && !exitCalled) {
        ctx.stdout += formatArg(result) + '\n';
      }

      return exitCode;
    } catch (e: any) {
      ctx.stderr += `${e.stack || e.message}\n`;
      return 1;
    }
  },
};

class ProcessExitError extends Error {
  code: number;
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
