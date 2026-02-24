import { Command, CommandContext } from './index';

/**
 * lua: Lua 5.4 interpreter via wasmoon (WebAssembly)
 *
 * Downloads wasmoon (~130KB WASM) on first use, browser-cached.
 * Full Lua 5.4 VM with filesystem access.
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

export const luaCmd: Command = {
  name: 'lua',
  description: 'Lua 5.4 interpreter (wasmoon)',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    // Handle -v / --version
    if (args.includes('-v') || args.includes('--version')) {
      ctx.stdout = 'Lua 5.4 (wasmoon 1.16.0) -- browser WebAssembly build\n';
      return 0;
    }

    if (args.length === 0 && !ctx.stdin) {
      ctx.stdout = [
        'Lua 5.4 (Shiro) — powered by wasmoon',
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

    let luaFactory: any;
    try {
      luaFactory = await ensureLua(ctx);
    } catch (err: any) {
      ctx.stderr = `lua: failed to load: ${err.message}\n`;
      return 1;
    }

    // Create a fresh engine for each invocation
    let engine: any;
    try {
      engine = await luaFactory.createEngine();
    } catch (err: any) {
      ctx.stderr = `lua: failed to create engine: ${err.message}\n`;
      return 1;
    }

    try {
      // Redirect print() to ctx.stdout
      let output = '';
      engine.global.set('print', (...args: any[]) => {
        output += args.map((a: any) => String(a)).join('\t') + '\n';
      });

      // Provide io.write
      engine.global.set('io', {
        write: (...args: any[]) => {
          output += args.map((a: any) => String(a)).join('');
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
