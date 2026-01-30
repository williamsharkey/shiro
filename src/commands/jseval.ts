import { Command, CommandContext } from './index';

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
      async function preloadPkg(dir: string) {
        try {
          const entries = await ctx.fs.readdir(dir);
          for (const name of entries) {
            const fp = dir + '/' + name;
            if (name.endsWith('.js') || name.endsWith('.json')) {
              try {
                const content = await ctx.fs.readFile(fp, 'utf8');
                fileCache.set(fp, content as string);
              } catch { /* skip */ }
            } else if (name !== 'node_modules' && !name.includes('.')) {
              // Likely a directory - try to recurse
              try {
                await ctx.fs.stat(fp);
                await preloadPkg(fp);
              } catch { /* not a dir or doesn't exist */ }
            }
          }
        } catch { /* skip */ }
      }

      // Pre-load project .js/.json files from cwd
      await preloadPkg(ctx.cwd);
      // Pre-load node_modules
      const nmDir = ctx.fs.resolvePath('node_modules', ctx.cwd);
      try {
        const entries = await ctx.fs.readdir(nmDir);
        for (const name of entries) {
          await preloadPkg(nmDir + '/' + name);
        }
      } catch { /* no node_modules */ }

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
                  then: (resolve: any, reject: any) => p.then(() => resolve(Buffer.from(result))).catch(reject),
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
                  get stdout() { return Buffer.from(stdout); },
                  get stderr() { return Buffer.from(stderr); },
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
          default: return null;
        }
      }

      function requireModule(modPath: string, fromDir: string): any {
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
          const wrapped = new Function(
            'module', 'exports', 'require', '__filename', '__dirname',
            'console', 'process', 'global', 'Buffer',
            content
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

      // Buffer shim — provides from(), alloc(), isBuffer(), toString()
      const FakeBuffer = {
        from: (input: any, encoding?: string): any => {
          if (typeof input === 'string') {
            const bytes = new TextEncoder().encode(input);
            return Object.assign(bytes, {
              toString: (enc?: string) => input,
              toJSON: () => ({ type: 'Buffer', data: Array.from(bytes) }),
            });
          }
          if (input instanceof Uint8Array) {
            return Object.assign(new Uint8Array(input), {
              toString: (enc?: string) => new TextDecoder().decode(input),
              toJSON: () => ({ type: 'Buffer', data: Array.from(input) }),
            });
          }
          if (Array.isArray(input)) {
            const bytes = new Uint8Array(input);
            return Object.assign(bytes, {
              toString: (enc?: string) => new TextDecoder().decode(bytes),
              toJSON: () => ({ type: 'Buffer', data: input }),
            });
          }
          return new Uint8Array(0);
        },
        alloc: (size: number) => {
          const bytes = new Uint8Array(size);
          return Object.assign(bytes, {
            toString: () => new TextDecoder().decode(bytes),
          });
        },
        isBuffer: (obj: any) => obj instanceof Uint8Array,
        concat: (list: Uint8Array[]) => {
          const total = list.reduce((n, b) => n + b.length, 0);
          const result = new Uint8Array(total);
          let offset = 0;
          for (const buf of list) { result.set(buf, offset); offset += buf.length; }
          return Object.assign(result, {
            toString: () => new TextDecoder().decode(result),
          });
        },
      };

      const fakeRequire = (moduleName: string) => requireModule(moduleName, ctx.cwd);

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      // When printing (-p), wrap in return to capture expression value
      const wrappedCode = printResult ? `return (${code})` : code;
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
