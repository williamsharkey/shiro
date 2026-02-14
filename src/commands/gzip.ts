import { Command } from './index';

async function compress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data as any);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

async function decompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data as any);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

export const gzipCmd: Command = {
  name: 'gzip',
  description: 'Compress files (gzip)',
  async exec(ctx) {
    let toStdout = false;
    let decompressMode = false;
    let keep = false;
    const files: string[] = [];

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-c' || arg === '--stdout') toStdout = true;
      else if (arg === '-d' || arg === '--decompress') decompressMode = true;
      else if (arg === '-k' || arg === '--keep') keep = true;
      else if (arg === '-f' || arg === '--force') { /* ignore */ }
      else if (arg.startsWith('-') && !arg.startsWith('--')) {
        for (const f of arg.slice(1)) {
          if (f === 'c') toStdout = true;
          else if (f === 'd') decompressMode = true;
          else if (f === 'k') keep = true;
          else if (f === 'f') { /* ignore */ }
        }
      } else {
        files.push(arg);
      }
    }

    // Stdin pipe mode
    if (files.length === 0) {
      if (!ctx.stdin) {
        ctx.stderr = 'gzip: compressed data not written to terminal\n';
        return 1;
      }
      const input = new TextEncoder().encode(ctx.stdin);
      const result = decompressMode ? await decompress(input) : await compress(input);
      if (decompressMode) {
        ctx.stdout = new TextDecoder().decode(result);
      } else {
        // Binary output to stdout — encode as latin1 so it survives pipe
        ctx.stdout = Array.from(result).map(b => String.fromCharCode(b)).join('');
      }
      return 0;
    }

    for (const file of files) {
      const resolved = ctx.fs.resolvePath(file, ctx.cwd);
      try {
        const data = await ctx.fs.readFile(resolved);
        const input = data instanceof Uint8Array ? data : new TextEncoder().encode(data);

        if (decompressMode) {
          const result = await decompress(input);
          const outPath = resolved.replace(/\.gz$/, '');
          if (toStdout) {
            ctx.stdout += new TextDecoder().decode(result);
          } else {
            await ctx.fs.writeFile(outPath, result);
            if (!keep) await ctx.fs.unlink(resolved);
          }
        } else {
          const result = await compress(input);
          const outPath = resolved + '.gz';
          if (toStdout) {
            ctx.stdout += Array.from(result).map(b => String.fromCharCode(b)).join('');
          } else {
            await ctx.fs.writeFile(outPath, result);
            if (!keep) await ctx.fs.unlink(resolved);
          }
        }
      } catch (e: any) {
        ctx.stderr += `gzip: ${file}: ${e.message}\n`;
        return 1;
      }
    }
    return 0;
  },
};

export const gunzipCmd: Command = {
  name: 'gunzip',
  description: 'Decompress gzip files',
  async exec(ctx) {
    // Prepend -d flag and delegate to gzip
    ctx.args = ['-d', ...ctx.args];
    return gzipCmd.exec(ctx);
  },
};
