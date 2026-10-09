/**
 * gzip / gunzip / zcat. Compression uses the browser's CompressionStream;
 * decompression uses compress/gzip-codec.ts, which (unlike DecompressionStream
 * in Chrome) handles concatenated members and trailing garbage like gzip.
 */

import type { Command, CommandContext } from './index';
import { gunzipDetailed, GzipError } from './compress/gzip-codec';
import { concatBytes, latin1, outputString, stdinBytes, unmangle } from './compress/bytes';

export { gunzip, gunzipDetailed, GzipError } from './compress/gzip-codec';

/** gzip-compress bytes (CompressionStream's default level) */
export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data as any).catch(() => {});
  writer.close().catch(() => {});
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks.length ? chunks : [new Uint8Array(0)]);
}

type Mode = 'compress' | 'decompress' | 'test';

// gunzip's suffixes, and what they become
const GUNZIP_SUFFIXES: [string, string][] = [['.gz', ''], ['-gz', ''], ['.z', ''], ['-z', ''], ['_z', ''], ['.Z', ''], ['.tgz', '.tar'], ['.taz', '.tar']];

async function runGzip(ctx: CommandContext, prog: string, defaultMode: Mode, defaultStdout: boolean): Promise<number> {
  let mode = defaultMode;
  let toStdout = defaultStdout;
  let keep = false, force = false, quiet = false, verbose = false;
  let suffix = '.gz';
  const files: string[] = [];
  let endOpts = false;
  const args = ctx.args;

  const badOption = (opt: string) => {
    ctx.stderr += `${prog}: invalid option -- '${opt}'\nTry \`${prog} --help' for more information.\n`;
    return 1;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (endOpts || !arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    if (arg === '--') { endOpts = true; continue; }
    if (arg.startsWith('--')) {
      const [name, value] = arg.split(/=(.*)/s);
      switch (name) {
        case '--stdout': case '--to-stdout': toStdout = true; break;
        case '--decompress': case '--uncompress': mode = 'decompress'; break;
        case '--keep': keep = true; break;
        case '--force': force = true; break;
        case '--test': mode = 'test'; break;
        case '--quiet': quiet = true; break;
        case '--verbose': verbose = true; break;
        case '--suffix': {
          const v = value ?? args[++i];
          if (!v) return badOption('S');
          suffix = v;
          break;
        }
        case '--fast': case '--best': case '--no-name': case '--name': case '--rsyncable': case '--synchronous': case '--no-time': break;
        default:
          ctx.stderr += `${prog}: unrecognized option '${arg}'\nTry \`${prog} --help' for more information.\n`;
          return 1;
      }
      continue;
    }
    const flags = arg.slice(1);
    for (let j = 0; j < flags.length; j++) {
      const f = flags[j];
      if (f >= '1' && f <= '9') continue;
      switch (f) {
        case 'c': toStdout = true; break;
        case 'd': mode = 'decompress'; break;
        case 'k': keep = true; break;
        case 'f': force = true; break;
        case 't': mode = 'test'; break;
        case 'q': quiet = true; break;
        case 'v': verbose = true; break;
        case 'n': case 'N': break;
        case 'S': {
          const v = j + 1 < flags.length ? flags.slice(j + 1) : args[++i];
          if (!v) return badOption('S');
          suffix = v;
          j = flags.length;
          break;
        }
        default: return badOption(f);
      }
    }
  }

  const useStdin = files.length === 0;
  if (useStdin) files.push('-');
  if (useStdin && !ctx.stdin && ctx.stdoutIsTTY && !force) {
    ctx.stderr += mode === 'compress'
      ? `${prog}: compressed data not written to a terminal. Use -f to force compression.\nFor help, type: ${prog} -h\n`
      : `${prog}: compressed data not read from a terminal. Use -f to force decompression.\nFor help, type: ${prog} -h\n`;
    return 1;
  }

  let status = 0;
  const setExit = (n: number) => { if (n > status) status = n; };
  const out: Uint8Array[] = [];
  let stdinUsed = false;
  const suffixes: [string, string][] = suffix === '.gz' ? GUNZIP_SUFFIXES : [[suffix, ''], ...GUNZIP_SUFFIXES];

  for (const file of files) {
    const isStdin = file === '-';
    const name = isStdin ? 'stdin' : file;
    const writesStdout = isStdin || toStdout;
    let input: Uint8Array;
    let resolved = '';
    let fileMode: number | undefined;
    if (isStdin) {
      input = stdinUsed ? new Uint8Array(0) : stdinBytes(ctx.stdin ?? '', mode !== 'compress');
      stdinUsed = true;
    } else {
      resolved = ctx.fs.resolvePath(file, ctx.cwd);
      let st;
      try { st = await ctx.fs.stat(resolved); } catch {
        ctx.stderr += `${prog}: ${file}: No such file or directory\n`;
        setExit(1);
        continue;
      }
      if (st.isDirectory()) {
        if (!quiet) ctx.stderr += `${prog}: ${file} is a directory -- ignored\n`;
        setExit(2);
        continue;
      }
      fileMode = st.mode;
      const data = await ctx.fs.readFile(resolved);
      input = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    }

    if (mode === 'compress') {
      let outPath = '';
      if (!writesStdout) {
        if (suffixes.some(([s]) => file.endsWith(s))) {
          if (!quiet) ctx.stderr += `${prog}: ${file} already has ${suffixes.find(([s]) => file.endsWith(s))![0]} suffix -- unchanged\n`;
          setExit(2);
          continue;
        }
        outPath = resolved + suffix;
        if (!force && await ctx.fs.exists(outPath)) {
          ctx.stderr += `${prog}: ${file}${suffix} already exists; not overwritten\n`;
          setExit(2);
          continue;
        }
      }
      const gz = await gzipCompress(input);
      if (verbose) {
        const saved = input.length ? (100 * (1 - (gz.length - 18) / input.length)).toFixed(1) : '0.0';
        ctx.stderr += writesStdout ? `${name}:\t${saved.padStart(5)}%\n` : `${file}:\t${saved.padStart(5)}% -- replaced with ${file}${suffix}\n`;
      }
      if (writesStdout) out.push(gz);
      else {
        await ctx.fs.writeFile(outPath, gz, fileMode !== undefined ? { mode: fileMode } : undefined);
        if (!keep) await ctx.fs.unlink(resolved);
      }
      continue;
    }

    let outPath = '';
    if (mode === 'decompress' && !writesStdout) {
      const suf = suffixes.find(([s]) => file.endsWith(s) && file.length > s.length);
      if (!suf) {
        if (!quiet) ctx.stderr += `${prog}: ${file}: unknown suffix -- ignored\n`;
        setExit(2);
        continue;
      }
      outPath = resolved.slice(0, resolved.length - suf[0].length) + suf[1];
      if (!force && await ctx.fs.exists(outPath)) {
        ctx.stderr += `${prog}: ${outPath.slice(outPath.lastIndexOf('/') + 1)} already exists; not overwritten\n`;
        setExit(2);
        continue;
      }
    }

    let result;
    try {
      try {
        result = gunzipDetailed(input);
      } catch (e) {
        const fixed = isStdin ? null : unmangle(input);
        if (!fixed) throw e;
        try { result = gunzipDetailed(fixed); } catch { throw e; }
      }
    } catch (e) {
      if (!(e instanceof GzipError)) throw e;
      if (e.kind === 'format' && force && writesStdout && mode === 'decompress') { out.push(input); continue; } // zcat -f
      ctx.stderr += `${prog}: ${name}: ${e.kind === 'corrupt' ? 'invalid compressed data--format violated' : e.message}\n`;
      setExit(1);
      continue;
    }
    if (result.trailingGarbage) {
      if (!quiet) ctx.stderr += `${prog}: ${name}: decompression OK, trailing garbage ignored\n`;
      setExit(2);
    }
    if (mode === 'test') {
      if (verbose) ctx.stderr += `${name}:\t OK\n`;
      continue;
    }
    if (writesStdout) out.push(result.data);
    else {
      await ctx.fs.writeFile(outPath, result.data, fileMode !== undefined ? { mode: fileMode } : undefined);
      if (!keep) await ctx.fs.unlink(resolved);
    }
  }
  if (out.length) {
    const bytes = concatBytes(out);
    ctx.stdout += mode === 'compress' ? latin1(bytes) : outputString(bytes);
  }
  return status;
}

export const gzipCmd: Command = {
  name: 'gzip',
  description: 'Compress or decompress files (gzip)',
  exec: (ctx) => runGzip(ctx, 'gzip', 'compress', false),
};

export const gunzipCmd: Command = {
  name: 'gunzip',
  description: 'Decompress gzip files',
  exec: (ctx) => runGzip(ctx, 'gunzip', 'decompress', false),
};

export const zcatCmd: Command = {
  name: 'zcat',
  description: 'Decompress gzip files to standard output',
  exec: (ctx) => runGzip(ctx, 'zcat', 'decompress', true),
};
