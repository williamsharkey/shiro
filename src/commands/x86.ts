/**
 * x86 command — run, inspect, and debug x86-64 ELF binaries.
 *
 * Usage:
 *   x86 run <file> [args...]    — Execute an ELF64 binary
 *   x86 info <file>             — Show ELF headers
 *   x86 debug <file> [args...]  — Step-through with register dump
 *   x86 help                    — Show usage
 */

import type { Command, CommandContext } from './index';

export const x86Cmd: Command = {
  name: 'x86',
  description: 'Run x86-64 ELF binaries in the built-in emulator',
  async exec(ctx: CommandContext): Promise<number> {
    const subCmd = ctx.args[0] || 'help';
    const rest = ctx.args.slice(1);

    const writeStdout = (s: string) => { ctx.stdout += s; };
    const writeStderr = (s: string) => { ctx.stderr += s; };

    if (subCmd === 'help' || subCmd === '--help') {
      writeStdout([
        'Usage: x86 <command> [args...]',
        '',
        'Commands:',
        '  run <file> [args...]    Execute an ELF64 binary',
        '  info <file>             Show ELF headers and program info',
        '  debug <file> [args...]  Step-through execution with register dump',
        '  help                    Show this help',
        '',
        'ELF binaries can also be run directly: ./binary [args...]',
        'The emulator supports statically-linked x86-64 Linux ELF binaries.',
        '',
      ].join('\r\n'));
      return 0;
    }

    if (!rest[0]) {
      writeStderr('x86: missing file argument\r\n');
      return 1;
    }

    const filePath = rest[0].startsWith('/') ? rest[0] : ctx.cwd + '/' + rest[0];
    const fileArgs = rest.slice(1);

    // Lazy-load the runtime
    const { executeElf, getElfInfo, debugElf } = await import('../x86/runtime');

    const x86Ctx = {
      fs: ctx.fs,
      cwd: ctx.cwd,
      args: fileArgs,
      env: ctx.env || {},
      stdin: ctx.stdin || '',
      writeStdout,
      writeStderr,
    };

    if (subCmd === 'run') {
      return executeElf(filePath, fileArgs, x86Ctx);
    }

    if (subCmd === 'info') {
      try {
        const raw = await ctx.fs.readFile(filePath);
        let data: Uint8Array;
        if (raw instanceof Uint8Array) data = raw;
        else data = new TextEncoder().encode(raw as string);

        const info = getElfInfo(data);
        writeStdout(info.split('\n').join('\r\n') + '\r\n');
        return 0;
      } catch (e: any) {
        writeStderr(`x86: ${rest[0]}: ${e.message}\r\n`);
        return 1;
      }
    }

    if (subCmd === 'debug') {
      // Parse debug options: --break ADDR, --watch ADDR, --dump ADDR SIZE
      const breakpoints: bigint[] = [];
      const watchpoints: bigint[] = [];
      let dumpAddr: bigint | undefined;
      let dumpSize: number | undefined;
      const debugFileArgs: string[] = [];

      for (let i = 0; i < fileArgs.length; i++) {
        if (fileArgs[i] === '--break' && i + 1 < fileArgs.length) {
          breakpoints.push(BigInt(fileArgs[++i]));
        } else if (fileArgs[i] === '--watch' && i + 1 < fileArgs.length) {
          watchpoints.push(BigInt(fileArgs[++i]));
        } else if (fileArgs[i] === '--dump' && i + 1 < fileArgs.length) {
          dumpAddr = BigInt(fileArgs[++i]);
          if (i + 1 < fileArgs.length && /^\d+$/.test(fileArgs[i + 1])) {
            dumpSize = parseInt(fileArgs[++i], 10);
          }
        } else {
          debugFileArgs.push(fileArgs[i]);
        }
      }

      const debugOpts = {
        breakpoints: breakpoints.length > 0 ? breakpoints : undefined,
        watchpoints: watchpoints.length > 0 ? watchpoints : undefined,
        dumpAddr,
        dumpSize,
      };

      x86Ctx.args = debugFileArgs;
      return debugElf(filePath, debugFileArgs, x86Ctx, debugOpts);
    }

    writeStderr(`x86: unknown command '${subCmd}'\r\n`);
    return 1;
  },
};
