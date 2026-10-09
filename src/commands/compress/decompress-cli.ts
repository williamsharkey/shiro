/**
 * Command-line front end shared by the decompress-only tools (xz, zstd):
 * flags, stdin/stdout, output names, keeping or removing the input.
 */

import type { CommandContext } from '../index';
import { concatBytes, outputString, stdinBytes, unmangle } from './bytes';

export interface DecoderCli {
  /** Name used in messages */
  prog: string;
  /** Compressed suffix → replacement, in match order */
  suffixes: [string, string][];
  /** zstd keeps its input unless --rm; xz removes it unless -k */
  keepByDefault: boolean;
  decode(input: Uint8Array): { data: Uint8Array; warning?: string };
  /** Message for a decode error, or null when it is not one */
  describe(e: unknown): string | null;
  /** Long options the tool accepts and ignores (they only matter for compression or threads) */
  ignoredLong: string[];
  /** Short options that take a value (-T 4, -o file) */
  shortWithValue: string;
}

export interface CliDefaults { decompress: boolean; toStdout: boolean }

export async function runDecompressor(ctx: CommandContext, cli: DecoderCli, defaults: CliDefaults): Promise<number> {
  const { prog } = cli;
  let decompress = defaults.decompress, toStdout = defaults.toStdout;
  let test = false, keep = cli.keepByDefault, force = false, quiet = false, verbose = false;
  let outFile: string | null = null;
  const files: string[] = [];
  let endOpts = false;
  const args = ctx.args;

  const unknown = (opt: string) => {
    ctx.stderr += `${prog}: unrecognized option '${opt}'\n${prog}: Try \`${prog} --help' for more information.\n`;
    return 1;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (endOpts || !arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    if (arg === '--') { endOpts = true; continue; }
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      switch (name) {
        case '--decompress': case '--uncompress': decompress = true; break;
        case '--compress': decompress = false; break;
        case '--stdout': case '--to-stdout': toStdout = true; break;
        case '--keep': keep = true; break;
        case '--rm': keep = false; break;
        case '--force': force = true; break;
        case '--test': test = true; decompress = true; break;
        case '--quiet': quiet = true; break;
        case '--verbose': verbose = true; break;
        default:
          if (!cli.ignoredLong.includes(name)) return unknown(arg);
      }
      continue;
    }
    const flags = arg.slice(1);
    for (let j = 0; j < flags.length; j++) {
      const f = flags[j];
      if (cli.shortWithValue.includes(f)) {
        const value = j + 1 < flags.length ? flags.slice(j + 1) : args[++i];
        if (value === undefined) {
          ctx.stderr += `${prog}: option requires an argument -- '${f}'\n`;
          return 1;
        }
        if (f === 'o') outFile = value;
        break;
      }
      if (f >= '0' && f <= '9') continue;
      switch (f) {
        case 'd': decompress = true; break;
        case 'z': decompress = false; break;
        case 'c': toStdout = true; break;
        case 'k': keep = true; break;
        case 'f': force = true; break;
        case 't': test = true; decompress = true; break;
        case 'q': quiet = true; break;
        case 'v': verbose = true; break;
        case 'e': break;
        default: return unknown(`-${f}`);
      }
    }
  }

  if (!decompress) {
    ctx.stderr += `${prog}: compression not implemented (decompress only, use -d)\n`;
    return 1;
  }

  const useStdin = files.length === 0;
  if (useStdin) files.push('-');
  if (useStdin && !ctx.stdin && ctx.stdoutIsTTY && !force) {
    ctx.stderr += `${prog}: Compressed data cannot be read from a terminal\n`;
    return 1;
  }

  let status = 0;
  const out: Uint8Array[] = [];
  let stdinUsed = false;
  for (const file of files) {
    const isStdin = file === '-';
    const name = isStdin ? '(stdin)' : file;
    let input: Uint8Array;
    let resolved = '';
    let mode: number | undefined;
    if (isStdin) {
      input = stdinUsed ? new Uint8Array(0) : stdinBytes(ctx.stdin ?? '', true);
      stdinUsed = true;
    } else {
      resolved = ctx.fs.resolvePath(file, ctx.cwd);
      let st;
      try { st = await ctx.fs.stat(resolved); } catch {
        ctx.stderr += `${prog}: ${file}: No such file or directory\n`;
        status = 1;
        continue;
      }
      if (st.isDirectory()) {
        ctx.stderr += `${prog}: ${file}: Is a directory, skipping\n`;
        status = Math.max(status, 2);
        continue;
      }
      mode = st.mode;
      const data = await ctx.fs.readFile(resolved);
      input = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    }

    const writesStdout = isStdin || toStdout || test;
    let outPath = '';
    if (!writesStdout) {
      if (outFile) outPath = ctx.fs.resolvePath(outFile, ctx.cwd);
      else {
        const suf = cli.suffixes.find(([s]) => file.endsWith(s) && file.length > s.length);
        if (!suf) {
          ctx.stderr += `${prog}: ${file}: Filename has an unknown suffix, skipping\n`;
          status = Math.max(status, quiet ? status : 2);
          continue;
        }
        outPath = resolved.slice(0, resolved.length - suf[0].length) + suf[1];
      }
      if (!force && await ctx.fs.exists(outPath)) {
        ctx.stderr += `${prog}: ${outFile ?? outPath.slice(outPath.lastIndexOf('/') + 1)}: File exists\n`;
        status = 1;
        continue;
      }
    }

    let result: { data: Uint8Array; warning?: string };
    try {
      try {
        result = cli.decode(input);
      } catch (e) {
        const fixed = isStdin ? null : unmangle(input);
        if (!fixed) throw e;
        try { result = cli.decode(fixed); } catch { throw e; }
      }
    } catch (e) {
      const msg = cli.describe(e);
      if (msg === null) throw e;
      ctx.stderr += `${prog}: ${name}: ${msg}\n`;
      status = 1;
      continue;
    }
    if (result.warning && !quiet) {
      ctx.stderr += `${prog}: ${name}: ${result.warning}\n`;
      status = Math.max(status, 2);
    }
    if (verbose) ctx.stderr += `${prog}: ${name}: ${result.data.length} bytes\n`;
    if (test) continue;
    if (writesStdout) out.push(result.data);
    else {
      await ctx.fs.writeFile(outPath, result.data, mode !== undefined ? { mode } : undefined);
      if (!keep) await ctx.fs.unlink(resolved);
    }
  }
  if (out.length) ctx.stdout += outputString(concatBytes(out));
  return status;
}
