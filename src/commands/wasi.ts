import { Command, CommandContext } from './index';
import { WasiRT, WasiExit, WasiConfig } from '../wasi-runtime';
import { WasiTTY, LineDiscipline, jspiAvailable } from '../wasi-tty';
import { findPackage, getCompiledModule } from '../wasi-packages';

/**
 * wasi — Run WASM+WASI binaries in Shiro
 *
 * Usage:
 *   wasi run [--raw] <file.wasm> [args...]    Run a local WASM binary
 *     On a terminal (JSPI browsers), stdin is interactive: cooked lines by
 *     default, or every keystroke with --raw (for TUIs).
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
      ctx.stdout += '  wasi run [--raw] <file.wasm|url> [args...]   Run a WASM binary\n';
      ctx.stdout += '  wasi exec [--raw] <package> [args...]        Run a package (auto-downloads)\n';
      ctx.stdout += '\nOn a terminal, stdin is interactive: line-edited by default,\n';
      ctx.stdout += 'or raw keystrokes with --raw for full-screen programs.\n';
      ctx.stdout += '\nRun any WASM+WASI binary against Shiro\'s filesystem.\n';
      ctx.stdout += '\nExamples:\n';
      ctx.stdout += '  wasi run ./program.wasm\n';
      ctx.stdout += '  wasi run https://example.com/tool.wasm --flag\n';
      ctx.stdout += '  wasi exec cowsay "hello world"\n';
      return 0;
    }

    const raw = ctx.args[1] === '--raw';
    if (raw) ctx.args.splice(1, 1);

    if (subcmd === 'exec') {
      return wasiExec(ctx, raw);
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
      return await runWithTerminal(ctx, config, raw, async (wasi) => {
        // Recursively pre-load the working directory tree so path_open/fd_readdir work
        await wasi.preloadTree(ctx.cwd, 3, 100);
        return wasi.run(wasmModule);
      });
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
async function wasiExec(ctx: CommandContext, raw = false): Promise<number> {
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

    return await runWithTerminal(ctx, config, raw, async (wasi) => {
      await wasi.preloadTree(ctx.cwd, 3, 100);
      return wasi.run(wasmModule);
    });
  } catch (e: any) {
    if (e instanceof WasiExit) return e.code;
    ctx.stderr += `wasi exec: ${e.message}\n`;
    return 1;
  }
}

/**
 * Run with interactive stdin when attached to a terminal, stdin is not piped,
 * and the browser supports JSPI. Output then streams to the terminal; cooked
 * mode maps \n to \r\n like a real tty, raw mode writes bytes unchanged.
 * Otherwise this is the classic run: fixed stdin, buffered output.
 */
async function runWithTerminal(
  ctx: CommandContext,
  config: WasiConfig,
  raw: boolean,
  start: (wasi: WasiRT) => Promise<number>,
): Promise<number> {
  const term = ctx.terminal;
  if (!term || ctx.stdin || ctx.stdoutIsTTY === false || !jspiAvailable()) {
    if (raw && term && !jspiAvailable()) {
      ctx.stderr += 'wasi: interactive stdin needs a browser with WebAssembly JSPI; running without it\n';
    }
    return start(new WasiRT(config));
  }

  const tty = new WasiTTY();
  tty.raw = raw;
  const write = (text: string) => term.writeOutput(tty.raw ? text : text.replace(/\r?\n/g, '\r\n'));
  const size = () => { const s = term.getSize(); return { cols: s.cols, rows: s.rows }; };
  const { cols, rows } = size();
  config.tty = tty;
  config.ttySize = size;
  config.env = { TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows), ...config.env };
  config.onStdout = write;
  config.onStderr = write;

  const kill = () => tty.abort(new WasiExit(130));
  const discipline = new LineDiscipline(tty, (text) => term.writeOutput(text), kill);
  term.enterStdinPassthrough((data) => discipline.input(data), kill);
  try {
    return await start(new WasiRT(config));
  } catch (e) {
    if (e instanceof WasiExit) return e.code;
    throw e;
  } finally {
    term.exitStdinPassthrough();
  }
}
