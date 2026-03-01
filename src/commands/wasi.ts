import { Command, CommandContext } from './index';
import { WasiRT, WasiExit, WasiConfig } from '../wasi-runtime';
import { findPackage, getCompiledModule } from '../wasi-packages';

/**
 * wasi — Run WASM+WASI binaries in Shiro
 *
 * Usage:
 *   wasi run <file.wasm> [args...]    Run a local WASM binary
 *   wasi run <url> [args...]          Fetch and run a remote WASM binary
 *   wasi exec <pkg> [args...]         Run a package (downloads if needed, like npx)
 *   wasi                              Show help
 */
export const wasiCmd: Command = {
  name: 'wasi',
  description: 'Run WASM+WASI binaries',

  async exec(ctx: CommandContext): Promise<number> {
    const subcmd = ctx.args[0];

    if (!subcmd || subcmd === '--help' || subcmd === '-h') {
      ctx.stdout += 'Usage:\n';
      ctx.stdout += '  wasi run <file.wasm|url> [args...]   Run a WASM binary\n';
      ctx.stdout += '  wasi exec <package> [args...]        Run a package (auto-downloads)\n';
      ctx.stdout += '\nRun any WASM+WASI binary against Shiro\'s filesystem.\n';
      ctx.stdout += '\nExamples:\n';
      ctx.stdout += '  wasi run ./program.wasm\n';
      ctx.stdout += '  wasi run https://example.com/tool.wasm --flag\n';
      ctx.stdout += '  wasi exec cowsay "hello world"\n';
      return 0;
    }

    if (subcmd === 'exec') {
      return wasiExec(ctx);
    }

    if (subcmd !== 'run') {
      ctx.stderr += `wasi: unknown subcommand '${subcmd}'\n`;
      ctx.stderr += 'Usage: wasi run <file.wasm|url> [args...] | wasi exec <package> [args...]\n';
      return 1;
    }

    const target = ctx.args[1];
    if (!target) {
      ctx.stderr += 'wasi: missing WASM file path or URL\n';
      return 1;
    }

    const wasmArgs = ctx.args.slice(2);

    try {
      // Load the WASM binary
      let wasmBytes: ArrayBuffer;

      if (target.startsWith('http://') || target.startsWith('https://')) {
        // Fetch from URL
        const resp = await fetch(target);
        if (!resp.ok) {
          ctx.stderr += `wasi: failed to fetch ${target}: ${resp.status} ${resp.statusText}\n`;
          return 1;
        }
        wasmBytes = await resp.arrayBuffer();
      } else {
        // Read from Shiro filesystem
        const resolvedPath = ctx.fs.resolvePath(target, ctx.cwd);
        try {
          const data = await ctx.fs.readFile(resolvedPath) as Uint8Array;
          wasmBytes = new Uint8Array(data).buffer;
        } catch (e: any) {
          ctx.stderr += `wasi: ${resolvedPath}: ${e.message}\n`;
          return 1;
        }
      }

      // Validate WASM magic bytes
      const magic = new Uint8Array(wasmBytes, 0, 4);
      if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
        ctx.stderr += `wasi: ${target}: not a valid WASM binary\n`;
        return 1;
      }

      // Compile
      const wasmModule = await WebAssembly.compile(wasmBytes);

      // Set up WASI config
      const programName = target.split('/').pop() || target;
      const config: WasiConfig = {
        fs: ctx.fs,
        cwd: ctx.cwd,
        args: [programName, ...wasmArgs],
        env: { ...ctx.env },
        stdin: ctx.stdin || '',
        onStdout: (text) => { ctx.stdout += text; },
        onStderr: (text) => { ctx.stderr += text; },
        preopens: {
          '/': '/',
          '.': ctx.cwd,
        },
      };

      // Create runtime and run
      const wasi = new WasiRT(config);

      // Recursively pre-load the working directory tree so path_open/fd_readdir work
      await wasi.preloadTree(ctx.cwd, 3, 100);

      // Run
      const exitCode = await wasi.run(wasmModule);
      return exitCode;
    } catch (e: any) {
      if (e instanceof WasiExit) {
        return e.code;
      }
      ctx.stderr += `wasi: ${e.message}\n`;
      return 1;
    }
  },
};

/**
 * wasi exec <pkg> [args...] — like npx for WASM packages.
 * Downloads the package if not cached, compiles, and runs immediately.
 */
async function wasiExec(ctx: CommandContext): Promise<number> {
  const pkgName = ctx.args[1];
  if (!pkgName) {
    ctx.stderr += 'wasi exec: missing package name\n';
    ctx.stderr += 'Usage: wasi exec <package> [args...]\n';
    return 1;
  }

  const pkg = findPackage(pkgName);
  if (!pkg) {
    ctx.stderr += `wasi exec: unknown package '${pkgName}'\n`;
    ctx.stderr += 'Run "pkg available" to see available packages.\n';
    return 1;
  }

  const wasmArgs = ctx.args.slice(2);

  try {
    const wasmModule = await getCompiledModule(pkg.name, (msg) => {
      ctx.stderr += `  ${msg}\n`;
    });

    const config: WasiConfig = {
      fs: ctx.fs,
      cwd: ctx.cwd,
      args: [pkg.name, ...wasmArgs],
      env: { ...ctx.env },
      stdin: ctx.stdin || '',
      onStdout: (text) => { ctx.stdout += text; },
      onStderr: (text) => { ctx.stderr += text; },
      preopens: { '/': '/', '.': ctx.cwd },
    };

    const wasi = new WasiRT(config);
    await wasi.preloadTree(ctx.cwd, 3, 100);
    return await wasi.run(wasmModule);
  } catch (e: any) {
    if (e instanceof WasiExit) return e.code;
    ctx.stderr += `wasi exec: ${e.message}\n`;
    return 1;
  }
}
