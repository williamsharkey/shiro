import { Command, CommandContext } from './index';
import { virtualServer, VirtualRequest, VirtualResponse } from '../virtual-server';
import { iframeServer } from '../iframe-server';

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
    console.log('[node] Command invoked with args:', ctx.args);
    console.log('[node] cwd:', ctx.cwd);

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

    console.log('[node] Code loaded, length:', code.length, 'first 100 chars:', code.slice(0, 100));

    try {
      // Build a minimal Node-like environment
      let exitCode = 0;
      let exitCalled = false;

      const stdoutBuf: string[] = [];
      const stderrBuf: string[] = [];
      const pendingPromises: Promise<any>[] = []; // Track async operations like app.listen()

      const fakeConsole = {
        log: (...args: any[]) => { stdoutBuf.push(args.map(formatArg).join(' ')); },
        info: (...args: any[]) => { stdoutBuf.push(args.map(formatArg).join(' ')); },
        warn: (...args: any[]) => { stderrBuf.push(args.map(formatArg).join(' ')); },
        error: (...args: any[]) => { stderrBuf.push(args.map(formatArg).join(' ')); },
        dir: (obj: any) => { stdoutBuf.push(JSON.stringify(obj, null, 2)); },
      };

      const processEvents: Record<string, Function[]> = {};
      const fakeProcess = {
        env: { ...ctx.env },
        cwd: () => ctx.cwd,
        exit: (c?: number) => {
          exitCode = c || 0;
          exitCalled = true;
          console.log('[node] process.exit(' + exitCode + ') called');
          console.log('[node] stdout buffer:', stdoutBuf.join('\n').slice(-500));
          console.log('[node] stderr buffer:', stderrBuf.join('\n').slice(-500));
          console.trace('[node] process.exit stack trace');
          throw new ProcessExitError(exitCode);
        },
        argv: ['node', ...fileArgs],
        platform: 'browser',
        version: 'v0.1.0-shiro',
        versions: { node: '20.0.0' },
        stdout: { write: (s: string) => { stdoutBuf.push(s); } },
        stderr: { write: (s: string) => { stderrBuf.push(s); } },
        on: (event: string, fn: Function) => {
          if (event === 'uncaughtException' || event === 'unhandledRejection') {
            console.log('[node] process.on(' + event + ') registered');
          }
          (processEvents[event] ??= []).push(fn);
          return fakeProcess;
        },
        off: (event: string, fn: Function) => { processEvents[event] = (processEvents[event] || []).filter(f => f !== fn); return fakeProcess; },
        once: (event: string, fn: Function) => {
          const wrapper = (...args: any[]) => { fakeProcess.off(event, wrapper); fn(...args); };
          return fakeProcess.on(event, wrapper);
        },
        emit: (event: string, ...args: any[]) => {
          if (event === 'uncaughtException' || event === 'unhandledRejection') {
            console.log('[node] process.emit(' + event + '):', args[0]?.message || args[0], args[0]?.stack?.slice(0, 500));
          }
          (processEvents[event] || []).forEach(fn => fn(...args));
        },
        nextTick: (fn: Function, ...args: any[]) => { queueMicrotask(() => fn(...args)); },
        hrtime: { bigint: () => BigInt(Date.now()) * BigInt(1000000) },
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
              } else if (st.size < 16777216) { // 16MB limit (for large bundled packages like claude-code)
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
        console.log('[node] Preloaded project root:', projectRoot);
      }
      console.log('[node] Files in cache:', fileCache.size);

      // Buffer shim — must be a constructor with prototype for safe-buffer compatibility
      function FakeBuffer(arg?: any, encodingOrOffset?: any, length?: any): any {
        if (typeof arg === 'number') {
          return FakeBuffer.alloc(arg);
        }
        return FakeBuffer.from(arg, encodingOrOffset);
      }
      FakeBuffer.prototype = Object.create(Uint8Array.prototype);
      FakeBuffer.prototype.constructor = FakeBuffer;
      FakeBuffer.prototype.toString = function(encoding?: string) {
        return new TextDecoder().decode(this);
      };
      FakeBuffer.prototype.toJSON = function() {
        return { type: 'Buffer', data: Array.from(this) };
      };
      FakeBuffer.from = (input: any, encoding?: string): any => {
        let bytes: Uint8Array;
        if (typeof input === 'string') {
          if (encoding === 'base64') {
            const binary = atob(input);
            bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          } else if (encoding === 'hex') {
            const hex = input.replace(/[^0-9a-fA-F]/g, '');
            bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
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
      FakeBuffer.isBuffer = (obj: any) => obj instanceof Uint8Array;
      FakeBuffer.isEncoding = (enc: string) => ['utf8', 'utf-8', 'ascii', 'base64', 'hex', 'binary'].includes(enc?.toLowerCase());
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
          case 'fs/promises':
          case 'node:fs/promises': {
            // Async fs promises API
            return {
              readFile: async (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const data = await ctx.fs.readFile(resolved);
                const encoding = typeof opts === 'string' ? opts : opts?.encoding;
                if (encoding === 'utf8' || encoding === 'utf-8') {
                  return typeof data === 'string' ? data : new TextDecoder().decode(data);
                }
                return typeof data === 'string' ? FakeBuffer.from(data) : FakeBuffer.from(data);
              },
              writeFile: async (p: string, data: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
                await ctx.fs.writeFile(resolved, content);
              },
              readdir: async (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                return await ctx.fs.readdir(resolved);
              },
              stat: async (p: string) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                return await ctx.fs.stat(resolved);
              },
              mkdir: async (p: string, opts?: any) => {
                const resolved = ctx.fs.resolvePath(p, ctx.cwd);
                await ctx.fs.mkdir(resolved, opts?.recursive);
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
                const exists = await ctx.fs.exists(resolved);
                if (!exists) throw new Error(`ENOENT: no such file or directory, access '${p}'`);
              },
            };
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
            types: {
              isDate: (v: any) => v instanceof Date,
              isRegExp: (v: any) => v instanceof RegExp,
              isCryptoKey: (key: any) => typeof CryptoKey !== 'undefined' && key instanceof CryptoKey,
              isTypedArray: (v: any) => ArrayBuffer.isView(v) && !(v instanceof DataView),
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
            debuglog: () => () => {}, // No-op debug logger
            TextEncoder,
            TextDecoder,
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
            // Stream shim with Transform for libraries like iconv-lite
            console.log('[stream shim] Creating stream module with Transform');
            const streamModule: any = {};

            // Debug flag to trace Transform usage
            (globalThis as any).__streamShimDebug = true;

            const Stream = function(this: any) {} as any;
            Stream.prototype.pipe = function(dest: any) { return dest; };
            Stream.prototype.on = function(_event: string, _cb: Function) { return this; };
            Stream.prototype.once = function(_event: string, _cb: Function) { return this; };
            Stream.prototype.emit = function(_event: string, ..._args: any[]) { return true; };
            Stream.prototype.removeListener = function(_event: string, _cb: Function) { return this; };
            Stream.prototype.addListener = function(_event: string, _cb: Function) { return this; };
            streamModule.Stream = Stream;

            const Readable = function(this: any, opts?: any) { Stream.call(this); } as any;
            Readable.prototype = Object.create(Stream.prototype);
            Readable.prototype.constructor = Readable;
            Readable.prototype._read = function() {};
            Readable.prototype.push = function(_chunk: any) { return true; };
            Readable.prototype.read = function() { return null; };
            streamModule.Readable = Readable;

            const Writable = function(this: any, opts?: any) { Stream.call(this); } as any;
            Writable.prototype = Object.create(Stream.prototype);
            Writable.prototype.constructor = Writable;
            Writable.prototype._write = function(_chunk: any, _encoding: string, callback: Function) { callback(); };
            Writable.prototype.write = function(_chunk: any, _encoding?: any, _cb?: any) { return true; };
            Writable.prototype.end = function(_chunk?: any, _encoding?: any, _cb?: any) {};
            streamModule.Writable = Writable;

            const Duplex = function(this: any, opts?: any) { Readable.call(this, opts); } as any;
            Duplex.prototype = Object.create(Readable.prototype);
            Duplex.prototype.constructor = Duplex;
            Duplex.prototype._write = function(_chunk: any, _encoding: string, callback: Function) { callback(); };
            Duplex.prototype.write = function(_chunk: any, _encoding?: any, _cb?: any) { return true; };
            Duplex.prototype.end = function(_chunk?: any, _encoding?: any, _cb?: any) {};
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

            console.log('[stream shim] Module ready, Transform:', typeof Transform, Transform?.name);
            console.log('[stream shim] Returning:', Object.keys(streamModule));
            return streamModule;
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

                  server.emit('listening');
                  cb?.();

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
            isatty: (_fd?: number) => true,
            ReadStream: class ReadStream { constructor() {} setRawMode() { return this; } isTTY = true; },
            WriteStream: class WriteStream {
              isTTY = true;
              columns = 80;
              rows = 24;
              getColorDepth() { return 24; }
              hasColors(count?: number) { return (count || 0) <= 16777216; }
              getWindowSize() { return [this.columns, this.rows]; }
              cursorTo() {}
              moveCursor() {}
              clearLine() {}
              clearScreenDown() {}
              write(data: any) {}
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
              constants: {
                Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
                Z_DEFAULT_COMPRESSION: -1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3,
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
          case 'node:process': return fakeProcess;

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
            createInterface: (opts: any) => ({
              on: () => ({}),
              close: () => {},
              question: (q: string, cb: Function) => cb(''),
              [Symbol.asyncIterator]: async function*() {},
            }),
            Interface: class Interface {},
          };

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
                console.log(`[Express] REDIRECT ${statusCode} -> ${redirectUrl}`);
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
            console.log(`[Express] ${req.method} ${req.path} - ${middlewares.length} middlewares, ${routes.length} routes`);
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
        console.log('[express.static] Registered for root:', root);
        return async (req: any, res: any, next: Function) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next();
          const filePath = ctx.fs.resolvePath(root + req.path, ctx.cwd);
          console.log('[express.static] Checking:', filePath, 'for request:', req.path);
          try {
            const stat = await ctx.fs.stat(filePath);
            if (!stat || stat.type !== 'file') {
              console.log('[express.static] Not a file or not found:', filePath);
              return next();
            }
            console.log('[express.static] Serving:', filePath);
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
            console.log('[express.static] Error:', filePath, err.message);
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
        console.log('[better-sqlite3 shim] Creating shim');

        // Load sql.js from CDN - START LOADING IMMEDIATELY when shim is created
        async function loadSqlJs(): Promise<any> {
          // Check if we're in a browser environment
          if (typeof window === 'undefined') {
            throw new Error('better-sqlite3 shim requires browser environment (sql.js WASM)');
          }

          if (!sqlJsPromise) {
            console.log('[better-sqlite3 shim] Starting sql.js load...');
            sqlJsPromise = (async () => {
              try {
                const initSqlJs = (window as any).initSqlJs;
                if (initSqlJs) {
                  console.log('[better-sqlite3 shim] initSqlJs already available, initializing...');
                  const SQL = await initSqlJs({
                    locateFile: (file: string) => `https://sql.js.org/dist/${file}`
                  });
                  console.log('[better-sqlite3 shim] sql.js initialized successfully');
                  return SQL;
                }
                // Load the script if not already loaded
                console.log('[better-sqlite3 shim] Loading sql-wasm.js script...');
                await new Promise<void>((resolve, reject) => {
                  const script = document.createElement('script');
                  script.src = 'https://sql.js.org/dist/sql-wasm.js';
                  script.onload = () => {
                    console.log('[better-sqlite3 shim] sql-wasm.js script loaded');
                    resolve();
                  };
                  script.onerror = (e) => {
                    console.error('[better-sqlite3 shim] Failed to load sql-wasm.js:', e);
                    reject(e);
                  };
                  document.head.appendChild(script);
                });
                console.log('[better-sqlite3 shim] Initializing sql.js WASM...');
                const SQL = await (window as any).initSqlJs({
                  locateFile: (file: string) => `https://sql.js.org/dist/${file}`
                });
                console.log('[better-sqlite3 shim] sql.js WASM initialized successfully');
                return SQL;
              } catch (err) {
                console.error('[better-sqlite3 shim] sql.js loading failed:', err);
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
            console.log('[better-sqlite3 shim] new Database(' + path + ')');
            this.dbPath = ctx.fs.resolvePath(path, ctx.cwd);
            // Start initialization immediately in constructor
            // This allows sql.js loading to happen while other code runs
            this.initPromise = this._init();
          }

          private async _init(): Promise<void> {
            console.log('[better-sqlite3 shim] _init() called for', this.dbPath);
            if (this._isReady) return;

            try {
              console.log('[better-sqlite3 shim] Waiting for sql.js...');
              // Use the early-loaded promise so sql.js may already be ready
              this.SQL = await earlyLoadPromise;
              console.log('[better-sqlite3 shim] sql.js ready');

              // Check if we have this database cached
              if (sqliteDatabases.has(this.dbPath)) {
                this.db = sqliteDatabases.get(this.dbPath);
                this._isReady = true;
                console.log('[better-sqlite3 shim] Using cached database');
                return;
              }

              // Try to load from virtual filesystem
              try {
                console.log('[better-sqlite3 shim] Loading database from:', this.dbPath);
                const data = await ctx.fs.readFile(this.dbPath);
                if (data instanceof Uint8Array) {
                  this.db = new this.SQL.Database(data);
                  console.log('[better-sqlite3 shim] Loaded existing database');
                } else {
                  // File exists but is empty or text - create new
                  this.db = new this.SQL.Database();
                  console.log('[better-sqlite3 shim] Created new database (file was empty/text)');
                }
              } catch {
                // File doesn't exist - create new database
                this.db = new this.SQL.Database();
                console.log('[better-sqlite3 shim] Created new database (file not found)');
              }

              sqliteDatabases.set(this.dbPath, this.db);
              this._isReady = true;
              console.log('[better-sqlite3 shim] Database ready:', this.dbPath);
            } catch (err) {
              console.error('[better-sqlite3 shim] _init failed:', err);
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
      function requireModule(modPath: string, fromDir: string): any {
        // Debug logging for iconv-lite and stream modules
        if (modPath === 'stream' || modPath.includes('iconv') || modPath.includes('streams')) {
          console.log(`[require] Called for '${modPath}' from '${fromDir}'`);
        }
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
          if (modPath === 'stream' || modPath === 'node:stream') {
            console.log(`[require] Returning stream builtin with Transform:`, typeof builtin.Transform, builtin.Transform?.name);
          }
          return builtin;
        }

        let resolved = modPath;

        if (modPath.startsWith('./') || modPath.startsWith('../') || modPath.startsWith('/')) {
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
                  if (!/\.(js|cjs|mjs|json)$/.test(main)) main += '.js';
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
                  if (!/\.(js|cjs|mjs|json)$/.test(main)) main += '.js';
                  resolved = `${globalPkgDir}/${main}`;
                } catch {
                  resolved = `${globalPkgDir}/index.js`;
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

        // Debug for iconv-lite streams
        if (resolved.includes('streams.js') && resolved.includes('iconv')) {
          console.log(`[module] Loading: ${resolved}`);
          console.log(`[module] Original content first 500 chars:`, content.slice(0, 500));
        }

        try {
          // Transform ES module syntax to CommonJS
          const transformedContent = transformESModules(content);

          // Debug for iconv-lite streams transformed content
          if (resolved.includes('streams.js') && resolved.includes('iconv')) {
            console.log(`[module] Transformed content first 800 chars:`, transformedContent.slice(0, 800));
          }

          const modImportMeta = {
            url: `file://${resolved}`,
            dirname: modDir,
            filename: resolved,
          };
          // Use AsyncFunction but don't await - allows top-level await in modules
          // The async execution will continue and populate module.exports
          const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
          const wrapped = new AsyncFn(
            'module', 'exports', 'require', '__filename', '__dirname',
            'console', 'process', 'global', 'Buffer', '__import_meta',
            transformedContent
          );
          // Execute async but track the promise for later awaiting
          const execPromise = wrapped(mod, mod.exports, nestedRequire, resolved, modDir,
            fakeConsole, fakeProcess, globalThis, FakeBuffer, modImportMeta
          );
          // For modules with top-level await, add promise to pending
          pendingPromises.push(execPromise.catch((e: any) => {
            if (!(e instanceof ProcessExitError)) {
              console.error(`Error in module ${resolved}:`, e.message, e.stack?.slice(0, 300));
              // Emit as uncaughtException if handlers are registered
              if (processEvents['uncaughtException']?.length) {
                fakeProcess.emit('uncaughtException', e);
              }
            }
          }));

          // Debug for iconv-lite streams
          if (resolved.includes('streams.js') || resolved.includes('iconv')) {
            console.log(`[module] ${resolved} exports:`, typeof mod.exports, mod.exports?.name || Object.keys(mod.exports || {}).slice(0, 5));
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

        return src;
      }

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      // Transform ES modules and wrap for execution
      const transformedCode = transformESModules(code);
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
      };

      // Create module/exports for CommonJS compatibility
      const fakeModule: { exports: any } = { exports: {} };
      const fakeExports = fakeModule.exports;

      // Create require function for the entry script - must use entryDirname, not ctx.cwd
      const entryRequire = (moduleName: string) => requireModule(moduleName, entryDirname);

      // Dynamic import() shim — used by transformBundledESM's import( → __dynamic_import( transform
      const dynamicImport = async (moduleName: string) => {
        return requireModule(moduleName, entryDirname);
      };

      let result;
      console.log('[node] Starting main script execution...');
      console.log('[node] Entry script dirname:', entryDirname);
      // Log lines around the try-catch to see the error source
      const codeLines = wrappedCode.split('\n');
      console.log('[node] Main script lines 50-90:\n' + codeLines.slice(49, 90).map((l, i) => `${50+i}: ${l.slice(0, 120)}`).join('\n'));
      try {
        result = await fn(fakeConsole, fakeProcess, entryRequire, FakeBuffer, entryFilename, entryDirname, {
          fs: ctx.fs,
          shell: ctx.shell,
          env: ctx.env,
          cwd: ctx.cwd,
        }, fakeImportMeta, fakeModule, fakeExports, dynamicImport);
        console.log('[node] Main script execution completed');
      } catch (e: any) {
        console.log('[node] Main script threw error:', e.message);
        if (e instanceof ProcessExitError) {
          exitCode = e.code;
        } else {
          throw e;
        }
      }

      // Wait for any pending async operations (like app.listen())
      // Loop because new promises may be added during module execution (e.g., app.listen in top-level await)
      console.log('[node] Pending promises:', pendingPromises.length);
      while (pendingPromises.length > 0) {
        const current = [...pendingPromises]; // Snapshot current promises
        pendingPromises.length = 0; // Clear array so new ones can be detected
        console.log('[node] Waiting for', current.length, 'promises...');
        await Promise.all(current);
        console.log('[node] Promises resolved, checking for more...');
      }
      console.log('[node] All promises resolved, exiting');

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
