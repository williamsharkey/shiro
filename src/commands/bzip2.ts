/**
 * bzip2 / bunzip2 / bzcat — the real .bz2 format (see compress/bzip2-codec.ts),
 * with bzip2 1.0.x's flags, file naming and messages.
 */

import type { Command, CommandContext } from './index';
import { bzip2Compress, bzip2DecompressDetailed, Bzip2Error } from './compress/bzip2-codec';
import { concatBytes, latin1, outputString, stdinBytes, unmangle } from './compress/bytes';

export { bzip2Compress, bzip2Decompress, bzip2DecompressDetailed, Bzip2Error } from './compress/bzip2-codec';

type Mode = 'compress' | 'decompress' | 'test';

const USAGE = (prog: string) => `bzip2, a block-sorting file compressor.  Version 1.0.8 (Shiro).

   usage: ${prog} [flags and input files in any order]

   -h --help           print this message
   -d --decompress     force decompression
   -z --compress       force compression
   -k --keep           keep (don't delete) input files
   -f --force          overwrite existing output files
   -t --test           test compressed file integrity
   -c --stdout         output to standard out
   -q --quiet          suppress noncritical error messages
   -v --verbose        be verbose (a 2nd -v gives more)
   -s --small          use less memory (ignored)
   -1 .. -9            set block size to 100k .. 900k
   --fast              alias for -1
   --best              alias for -9

   If invoked as \`bzip2', default action is to compress.
              as \`bunzip2',  default action is to decompress.
              as \`bzcat', default action is to decompress to stdout.

   If no file names are given, bzip2 compresses or decompresses
   from standard input to standard output.
`;

const RECOVER_HINT = `
It is possible that the compressed file(s) have become corrupted.
You can use the -tvv option to test integrity of such files.

You can use the \`bzip2recover' program to attempt to recover
data from undamaged sections of corrupted files.

`;

const COMPRESSED_SUFFIXES: [string, string][] = [['.bz2', ''], ['.bz', ''], ['.tbz2', '.tar'], ['.tbz', '.tar']];

async function runBzip2(ctx: CommandContext, prog: string, defaultMode: Mode, defaultStdout: boolean): Promise<number> {
  let mode = defaultMode;
  let toStdout = defaultStdout;
  let keep = false, force = false, quiet = false;
  let verbose = 0;
  let level = 9;
  const files: string[] = [];
  let endOpts = false;

  const badFlag = (f: string) => {
    ctx.stderr += `${prog}: Bad flag \`${f}'\n` + USAGE(prog);
    return 1;
  };

  for (const arg of ctx.args) {
    if (endOpts || !arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    if (arg === '--') { endOpts = true; continue; }
    if (arg.startsWith('--')) {
      switch (arg) {
        case '--stdout': toStdout = true; break;
        case '--decompress': mode = 'decompress'; break;
        case '--compress': mode = 'compress'; break;
        case '--keep': keep = true; break;
        case '--force': force = true; break;
        case '--test': mode = 'test'; break;
        case '--quiet': quiet = true; break;
        case '--verbose': verbose++; break;
        case '--small': case '--repetitive-fast': case '--repetitive-best': case '--exponential': break;
        case '--fast': level = 1; break;
        case '--best': level = 9; break;
        case '--help': ctx.stderr += USAGE(prog); return 0;
        case '--version': case '--license':
          ctx.stdout += 'bzip2, a block-sorting file compressor.  Version 1.0.8 (Shiro).\n';
          return 0;
        default: return badFlag(arg);
      }
      continue;
    }
    for (const f of arg.slice(1)) {
      if (f >= '1' && f <= '9') { level = f.charCodeAt(0) - 48; continue; }
      switch (f) {
        case 'c': toStdout = true; break;
        case 'd': mode = 'decompress'; break;
        case 'z': mode = 'compress'; break;
        case 'k': keep = true; break;
        case 'f': force = true; break;
        case 't': mode = 'test'; break;
        case 'q': quiet = true; break;
        case 'v': verbose++; break;
        case 's': break;
        case 'h': ctx.stderr += USAGE(prog); return 0;
        case 'L': case 'V':
          ctx.stdout += 'bzip2, a block-sorting file compressor.  Version 1.0.8 (Shiro).\n';
          return 0;
        default: return badFlag(`-${f}`);
      }
    }
  }

  const useStdin = files.length === 0;
  if (useStdin) files.push('-');
  if (mode === 'test') toStdout = false;

  // Shiro can't tell a terminal from a command substitution, so only refuse the interactive case
  if (mode === 'compress' && useStdin && !ctx.stdin && ctx.stdoutIsTTY && !force) {
    ctx.stderr += `${prog}: I won't write compressed data to a terminal.\n${prog}: For help, type: \`${prog} --help'.\n`;
    return 1;
  }
  if (mode !== 'compress' && useStdin && !ctx.stdin && ctx.stdoutIsTTY && !force) {
    ctx.stderr += `${prog}: I won't read compressed data from a terminal.\n${prog}: For help, type: \`${prog} --help'.\n`;
    return 1;
  }

  let status = 0;
  const setExit = (n: number) => { if (n > status) status = n; };
  const stdoutChunks: Uint8Array[] = [];
  let testFailed = false;
  let stdinUsed = false;

  for (const file of files) {
    const isStdin = file === '-';
    const inName = isStdin ? '(stdin)' : file;
    const writesStdout = isStdin || toStdout;
    let input: Uint8Array;
    let resolved = '';
    let inMode: number | undefined;

    if (isStdin) {
      input = stdinUsed ? new Uint8Array(0) : stdinBytes(ctx.stdin ?? '', mode !== 'compress');
      stdinUsed = true;
    } else {
      resolved = ctx.fs.resolvePath(file, ctx.cwd);
      let st;
      try {
        st = await ctx.fs.stat(resolved);
      } catch {
        ctx.stderr += `${prog}: Can't open input file ${file}: No such file or directory.\n`;
        setExit(1);
        continue;
      }
      if (st.isDirectory()) {
        ctx.stderr += `${prog}: Input file ${file} is a directory.\n`;
        setExit(1);
        continue;
      }
      inMode = st.mode;
      const data = await ctx.fs.readFile(resolved);
      input = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    }

    if (mode === 'compress') {
      let outPath = '';
      if (!writesStdout) {
        if (COMPRESSED_SUFFIXES.some(([s]) => file.endsWith(s))) {
          if (!quiet) ctx.stderr += `${prog}: Input file ${file} already has ${COMPRESSED_SUFFIXES.find(([s]) => file.endsWith(s))![0]} suffix.\n`;
          setExit(1);
          continue;
        }
        outPath = resolved + '.bz2';
        if (!force && await ctx.fs.exists(outPath)) {
          ctx.stderr += `${prog}: Output file ${file}.bz2 already exists.\n`;
          setExit(1);
          continue;
        }
      }
      const out = bzip2Compress(input, level);
      if (verbose) {
        if (input.length === 0) ctx.stderr += `  ${inName}: no data compressed.\n`;
        else {
          const ratio = input.length / out.length;
          ctx.stderr += `  ${inName}: ${ratio.toFixed(3).padStart(6)}:1, ${(8 * out.length / input.length).toFixed(3).padStart(6)} bits/byte, ` +
            `${(100 * (1 - out.length / input.length)).toFixed(2).padStart(5)}% saved, ${input.length} in, ${out.length} out.\n`;
        }
      }
      if (writesStdout) stdoutChunks.push(out);
      else {
        await ctx.fs.writeFile(outPath, out, inMode !== undefined ? { mode: inMode } : undefined);
        if (!keep) await ctx.fs.unlink(resolved);
      }
      continue;
    }

    // Decompress or test
    let outPath = '', outName = '(stdout)';
    if (mode === 'decompress' && !writesStdout) {
      const suf = COMPRESSED_SUFFIXES.find(([s]) => file.endsWith(s) && file.length > s.length);
      if (suf) {
        outPath = resolved.slice(0, resolved.length - suf[0].length) + suf[1];
        outName = file.slice(0, file.length - suf[0].length) + suf[1];
      } else {
        outPath = resolved + '.out';
        outName = file + '.out';
        if (!quiet) ctx.stderr += `${prog}: Can't guess original name for ${file} -- using ${outName}\n`;
      }
      if (!force && await ctx.fs.exists(outPath)) {
        ctx.stderr += `${prog}: Output file ${outName} already exists.\n`;
        setExit(1);
        continue;
      }
    }

    let result;
    try {
      try {
        result = bzip2DecompressDetailed(input);
      } catch (e) {
        const fixed = isStdin ? null : unmangle(input);
        if (!fixed) throw e;
        try { result = bzip2DecompressDetailed(fixed); } catch { throw e; }
      }
    } catch (e) {
      if (!(e instanceof Bzip2Error)) throw e;
      if (mode === 'test') {
        const what = e.kind === 'magic' ? 'bad magic number (file not created by bzip2)'
          : e.kind === 'eof' ? 'file ends unexpectedly' : 'data integrity (CRC) error in data';
        ctx.stderr += `${prog}: ${inName}: ${what}\n`;
        testFailed = true;
        setExit(2);
        continue;
      }
      if (e.kind === 'magic') {
        if (force && writesStdout) { stdoutChunks.push(input); continue; } // like bzip2 -dcf: pass it through
        ctx.stderr += `${prog}: ${inName} is not a bzip2 file.\n`;
        setExit(2);
        continue;
      }
      if (writesStdout && e.partial.length) stdoutChunks.push(e.partial);
      if (e.kind === 'eof') {
        ctx.stderr += `\n${prog}: Compressed file ends unexpectedly;\n\tperhaps it is corrupted?  *Possible* reason follows.\n` +
          `${prog}: Success\n\tInput file = ${inName}, output file = ${outName}\n` + RECOVER_HINT;
      } else {
        ctx.stderr += `\n${prog}: Data integrity error when decompressing.\n\tInput file = ${inName}, output file = ${outName}\n` + RECOVER_HINT;
      }
      setExit(2);
      break; // bzip2 gives up on the remaining files too
    }

    if (result.trailingGarbage && !quiet) {
      ctx.stderr += `${prog}: ${inName}: trailing garbage after EOF ignored\n`;
    }
    if (mode === 'test') {
      if (verbose) ctx.stderr += `  ${inName}: ok\n`;
      continue;
    }
    if (verbose) ctx.stderr += `  ${inName}: done\n`;
    if (writesStdout) stdoutChunks.push(result.data);
    else {
      await ctx.fs.writeFile(outPath, result.data, inMode !== undefined ? { mode: inMode } : undefined);
      if (!keep) await ctx.fs.unlink(resolved);
    }
  }

  if (testFailed) {
    ctx.stderr += `\nYou can use the \`bzip2recover' program to attempt to recover\ndata from undamaged sections of corrupted files.\n\n`;
  }
  if (stdoutChunks.length) {
    const bytes = concatBytes(stdoutChunks);
    ctx.stdout += mode === 'compress' ? latin1(bytes) : outputString(bytes);
  }
  return status;
}

export const bzip2Cmd: Command = {
  name: 'bzip2',
  description: 'Compress or decompress files (bzip2 .bz2 format)',
  exec: (ctx) => runBzip2(ctx, 'bzip2', 'compress', false),
};

export const bunzip2Cmd: Command = {
  name: 'bunzip2',
  description: 'Decompress bzip2 files',
  exec: (ctx) => runBzip2(ctx, 'bunzip2', 'decompress', false),
};

export const bzcatCmd: Command = {
  name: 'bzcat',
  description: 'Decompress bzip2 files to standard output',
  exec: (ctx) => runBzip2(ctx, 'bzcat', 'decompress', true),
};
