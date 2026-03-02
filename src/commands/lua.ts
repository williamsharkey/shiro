import { Command, CommandContext } from './index';

/**
 * lua: Lua 5.4 interpreter
 *
 * Primary: wasmoon (Emscripten). Fallback: WASI lua package.
 *
 * Usage:
 *   lua script.lua              # run a file
 *   lua -e "print('hello')"     # one-liner
 *   lua -v                      # show version
 *   echo 'print(42)' | lua      # pipe
 */

const WASMOON_CDN = 'https://esm.sh/wasmoon@1.16.0';

let factory: any = null;
let loadPromise: Promise<any> | null = null;
let wasmoonFailed = false;

async function ensureLua(ctx: CommandContext): Promise<any> {
  if (factory) return factory;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ctx.stdout += 'Loading Lua 5.4 (wasmoon)... ';

    const mod = await import(/* @vite-ignore */ WASMOON_CDN);
    const LuaFactory = mod.LuaFactory || mod.default?.LuaFactory;
    if (!LuaFactory) throw new Error('Failed to load wasmoon');

    factory = new LuaFactory();
    ctx.stdout += 'done.\n';
    return factory;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    factory = null;
    throw err;
  }
}

/**
 * Run lua via the WASI lua package (fallback when wasmoon fails)
 */
async function runWasiLua(ctx: CommandContext): Promise<number> {
  const { findPackage, getCompiledModule } = await import('../wasi-packages');
  const { WasiRT, WasiExit } = await import('../wasi-runtime');

  const pkg = findPackage('lua');
  if (!pkg) {
    ctx.stderr += 'lua: WASI lua package not available\n';
    return 1;
  }

  // Build WASI args: lua [original args...]
  const wasiArgs = ['lua', ...ctx.args];

  // If no file arg and stdin is present, pass '-' to read from stdin
  if (ctx.args.length === 0 && ctx.stdin) {
    wasiArgs.push('-');
  }

  try {
    const wasmModule = await getCompiledModule(pkg.name, (msg) => {
      ctx.stderr += `  ${msg}\n`;
    });

    const config = {
      fs: ctx.fs,
      cwd: ctx.cwd,
      args: wasiArgs,
      env: { ...ctx.env },
      stdin: ctx.stdin || '',
      onStdout: (text: string) => { ctx.stdout += text; },
      onStderr: (text: string) => { ctx.stderr += text; },
      preopens: { '/': '/', '.': ctx.cwd } as Record<string, string>,
    };

    const wasi = new WasiRT(config);
    await wasi.preloadTree(ctx.cwd, 3, 100);
    return await wasi.run(wasmModule);
  } catch (e: any) {
    if (e && typeof e === 'object' && 'code' in e) return (e as any).code;
    ctx.stderr += `lua: ${e.message}\n`;
    return 1;
  }
}

export const luaCmd: Command = {
  name: 'lua',
  description: 'Lua 5.4 interpreter',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    // Handle -v / --version
    if (args.includes('-v') || args.includes('--version')) {
      ctx.stdout = 'Lua 5.4 -- browser WebAssembly build\n';
      return 0;
    }

    if (args.length === 0 && !ctx.stdin) {
      ctx.stdout = [
        'Lua 5.4 (Shiro)',
        '',
        'Usage:',
        '  lua script.lua              Run a Lua script',
        '  lua -e "print(\'hello\')"     Execute a one-liner',
        '  lua -v                      Show version',
        '  echo \'print(42)\' | lua      Pipe Lua code',
        '',
      ].join('\n');
      return 0;
    }

    // If wasmoon previously failed, go straight to WASI
    if (wasmoonFailed) {
      return runWasiLua(ctx);
    }

    // Try wasmoon first
    let luaFactory: any;
    try {
      luaFactory = await ensureLua(ctx);
    } catch {
      wasmoonFailed = true;
      return runWasiLua(ctx);
    }

    let engine: any;
    try {
      engine = await luaFactory.createEngine();
    } catch {
      // wasmoon loaded but engine creation fails (Emscripten environment issue)
      wasmoonFailed = true;
      factory = null;
      loadPromise = null;
      return runWasiLua(ctx);
    }

    try {
      // Redirect print() to ctx.stdout
      let output = '';
      engine.global.set('print', (...printArgs: any[]) => {
        output += printArgs.map((a: any) => String(a)).join('\t') + '\n';
      });

      // Provide io.write and io.read
      let stdinConsumed = false;
      engine.global.set('io', {
        write: (...writeArgs: any[]) => {
          output += writeArgs.map((a: any) => String(a)).join('');
        },
        read: (fmt: string) => {
          if (!stdinConsumed && ctx.stdin) {
            stdinConsumed = true;
            if (fmt === '*a' || fmt === '*all') return ctx.stdin;
            if (fmt === '*l' || fmt === '*line') return ctx.stdin.split('\n')[0];
            return ctx.stdin;
          }
          return null;
        },
      });

      // Determine what to execute
      let code = '';
      const eIdx = args.indexOf('-e');
      if (eIdx !== -1 && args[eIdx + 1]) {
        code = args[eIdx + 1];
      } else if (args.length > 0 && !args[0].startsWith('-')) {
        // Run a file
        const filePath = ctx.fs.resolvePath(args[0], ctx.cwd);
        try {
          const data = await ctx.fs.readFile(filePath, 'utf8');
          code = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
        } catch (err: any) {
          ctx.stderr = `lua: ${args[0]}: ${err.message}\n`;
          return 1;
        }
      } else if (ctx.stdin) {
        code = ctx.stdin;
      }

      if (!code) {
        ctx.stderr = 'lua: no input\n';
        return 1;
      }

      await engine.doString(code);
      ctx.stdout += output;
      return 0;
    } catch (err: any) {
      ctx.stderr = `lua: ${err.message}\n`;
      return 1;
    } finally {
      try { engine.global.close(); } catch { /* ignore */ }
    }
  },
};
