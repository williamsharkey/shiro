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

      // Create require() function for npm packages
      // Note: This is a best-effort implementation. In browser, use dynamic import() instead.
      const fakeRequire = (moduleName: string) => {
        // Try to use global import map
        let importMap: any = {};
        if (typeof window !== 'undefined' && (window as any).__shiro?.importMap) {
          importMap = (window as any).__shiro.importMap;
        }

        // Check if module is in import map
        const moduleUrl = importMap[moduleName];
        if (!moduleUrl) {
          throw new Error(
            `Cannot find module '${moduleName}'.\n` +
            `Run 'npm install ${moduleName}' first, then use:\n` +
            `  import { ... } from '${moduleName}'  (ESM syntax)\n` +
            `  await import('${moduleName}')  (dynamic import)\n`
          );
        }

        // For browser ESM, require() cannot be truly synchronous
        // Throw a helpful error directing to use import instead
        throw new Error(
          `require('${moduleName}') is not supported in browser.\n` +
          `Use ESM syntax instead:\n` +
          `  import { ... } from '${moduleName}'  or\n` +
          `  const mod = await import('${moduleName}')\n` +
          `Package URL: ${moduleUrl}`
        );
      };

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      // When printing (-p), wrap in return to capture expression value
      const wrappedCode = printResult ? `return (${code})` : code;
      const fn = new AsyncFunction('console', 'process', 'require', 'shiro', `
        ${wrappedCode}
      `);

      let result;
      try {
        result = await fn(fakeConsole, fakeProcess, fakeRequire, {
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
