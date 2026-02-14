import { Command } from './index';

// CRC-32 lookup table
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
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
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
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
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result;
}

function writeU16(view: DataView, offset: number, val: number) { view.setUint16(offset, val, true); }
function writeU32(view: DataView, offset: number, val: number) { view.setUint32(offset, val, true); }
function readU16(view: DataView, offset: number) { return view.getUint16(offset, true); }
function readU32(view: DataView, offset: number) { return view.getUint32(offset, true); }

export const zipCmd: Command = {
  name: 'zip',
  description: 'Create ZIP archives',
  async exec(ctx) {
    let outputFile = '';
    let recursive = false;
    const inputPaths: string[] = [];

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-r' || arg === '--recurse-paths') recursive = true;
      else if (!arg.startsWith('-')) {
        if (!outputFile) outputFile = arg;
        else inputPaths.push(arg);
      }
      i++;
    }

    if (!outputFile || inputPaths.length === 0) {
      ctx.stderr = 'zip: usage: zip [-r] output.zip file1 [file2...]\n';
      return 1;
    }

    if (!outputFile.endsWith('.zip')) outputFile += '.zip';
    const resolvedOutput = ctx.fs.resolvePath(outputFile, ctx.cwd);

    // Collect files
    const entries: { name: string; data: Uint8Array }[] = [];

    async function addPath(path: string, name: string) {
      const resolved = ctx.fs.resolvePath(path, ctx.cwd);
      const stat = await ctx.fs.stat(resolved);
      if (stat.isDirectory()) {
        if (recursive) {
          const children = await ctx.fs.readdir(resolved);
          for (const child of children) {
            await addPath(resolved + '/' + child, name + '/' + child);
          }
        }
      } else {
        const data = await ctx.fs.readFile(resolved);
        const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
        entries.push({ name, data: bytes });
      }
    }

    try {
      for (const p of inputPaths) {
        await addPath(p, p);
      }
    } catch (e: any) {
      ctx.stderr = `zip: ${e.message}\n`;
      return 1;
    }

    // Build ZIP file
    const localHeaders: Uint8Array[] = [];
    const centralHeaders: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = new TextEncoder().encode(entry.name);
      const crc = crc32(entry.data);
      const compressed = await deflateRaw(entry.data);

      // Local file header
      const lh = new ArrayBuffer(30 + nameBytes.length);
      const lhv = new DataView(lh);
      writeU32(lhv, 0, 0x04034b50); // signature
      writeU16(lhv, 4, 20);         // version needed
      writeU16(lhv, 6, 0);          // flags
      writeU16(lhv, 8, 8);          // compression (deflate)
      writeU16(lhv, 10, 0);         // mod time
      writeU16(lhv, 12, 0);         // mod date
      writeU32(lhv, 14, crc);
      writeU32(lhv, 18, compressed.length);
      writeU32(lhv, 22, entry.data.length);
      writeU16(lhv, 26, nameBytes.length);
      writeU16(lhv, 28, 0);         // extra field length
      new Uint8Array(lh).set(nameBytes, 30);
      localHeaders.push(new Uint8Array(lh));
      localHeaders.push(compressed);

      // Central directory header
      const ch = new ArrayBuffer(46 + nameBytes.length);
      const chv = new DataView(ch);
      writeU32(chv, 0, 0x02014b50); // signature
      writeU16(chv, 4, 20);         // version made by
      writeU16(chv, 6, 20);         // version needed
      writeU16(chv, 8, 0);          // flags
      writeU16(chv, 10, 8);         // compression
      writeU16(chv, 12, 0);         // mod time
      writeU16(chv, 14, 0);         // mod date
      writeU32(chv, 16, crc);
      writeU32(chv, 20, compressed.length);
      writeU32(chv, 24, entry.data.length);
      writeU16(chv, 28, nameBytes.length);
      writeU16(chv, 30, 0);         // extra field length
      writeU16(chv, 32, 0);         // comment length
      writeU16(chv, 34, 0);         // disk number
      writeU16(chv, 36, 0);         // internal attrs
      writeU32(chv, 38, 0);         // external attrs
      writeU32(chv, 42, offset);    // local header offset
      new Uint8Array(ch).set(nameBytes, 46);
      centralHeaders.push(new Uint8Array(ch));

      offset += 30 + nameBytes.length + compressed.length;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const ch of centralHeaders) cdSize += ch.length;

    // End of central directory
    const eocd = new ArrayBuffer(22);
    const eocdv = new DataView(eocd);
    writeU32(eocdv, 0, 0x06054b50);
    writeU16(eocdv, 4, 0);              // disk number
    writeU16(eocdv, 6, 0);              // disk with CD
    writeU16(eocdv, 8, entries.length);  // entries on disk
    writeU16(eocdv, 10, entries.length); // total entries
    writeU32(eocdv, 12, cdSize);
    writeU32(eocdv, 16, cdOffset);
    writeU16(eocdv, 20, 0);             // comment length

    // Concatenate all parts
    const totalSize = offset + cdSize + 22;
    const zipData = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of localHeaders) { zipData.set(part, pos); pos += part.length; }
    for (const part of centralHeaders) { zipData.set(part, pos); pos += part.length; }
    zipData.set(new Uint8Array(eocd), pos);

    await ctx.fs.writeFile(resolvedOutput, zipData);
    ctx.stdout = `  adding: ${entries.length} files to ${outputFile}\n`;
    return 0;
  },
};

export const unzipCmd: Command = {
  name: 'unzip',
  description: 'Extract ZIP archives',
  async exec(ctx) {
    let listOnly = false;
    let outputDir = '';
    let overwrite = false;
    let zipFile = '';

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-l') listOnly = true;
      else if (arg === '-o') overwrite = true;
      else if (arg === '-d' && ctx.args[i + 1]) {
        outputDir = ctx.args[++i];
      } else if (!arg.startsWith('-')) {
        zipFile = arg;
      }
      i++;
    }

    if (!zipFile) {
      ctx.stderr = 'unzip: missing archive\n';
      return 1;
    }

    const resolved = ctx.fs.resolvePath(zipFile, ctx.cwd);
    let data: Uint8Array;
    try {
      const raw = await ctx.fs.readFile(resolved);
      data = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
    } catch (e: any) {
      ctx.stderr = `unzip: ${zipFile}: ${e.message}\n`;
      return 1;
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Find end of central directory
    let eocdPos = -1;
    for (let j = data.length - 22; j >= 0; j--) {
      if (readU32(view, j) === 0x06054b50) { eocdPos = j; break; }
    }
    if (eocdPos < 0) {
      ctx.stderr = 'unzip: invalid ZIP archive\n';
      return 1;
    }

    const numEntries = readU16(view, eocdPos + 8);
    let cdOffset = readU32(view, eocdPos + 16);

    const baseDir = outputDir
      ? ctx.fs.resolvePath(outputDir, ctx.cwd)
      : ctx.cwd;

    if (listOnly) {
      ctx.stdout += '  Length      Name\n';
      ctx.stdout += '---------  --------------------\n';
    }

    let totalSize = 0;

    for (let n = 0; n < numEntries; n++) {
      if (readU32(view, cdOffset) !== 0x02014b50) break;

      const compression = readU16(view, cdOffset + 10);
      const compSize = readU32(view, cdOffset + 20);
      const uncompSize = readU32(view, cdOffset + 24);
      const nameLen = readU16(view, cdOffset + 28);
      const extraLen = readU16(view, cdOffset + 30);
      const commentLen = readU16(view, cdOffset + 32);
      const localOffset = readU32(view, cdOffset + 42);

      const name = new TextDecoder().decode(data.subarray(cdOffset + 46, cdOffset + 46 + nameLen));

      if (listOnly) {
        ctx.stdout += `${String(uncompSize).padStart(9)}  ${name}\n`;
        totalSize += uncompSize;
        cdOffset += 46 + nameLen + extraLen + commentLen;
        continue;
      }

      // Read from local file header
      const lfNameLen = readU16(view, localOffset + 26);
      const lfExtraLen = readU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + lfNameLen + lfExtraLen;

      const fullPath = baseDir + '/' + name;

      if (name.endsWith('/')) {
        await ctx.fs.mkdir(fullPath, { recursive: true });
        ctx.stdout += `   creating: ${name}\n`;
      } else {
        // Ensure parent directory exists
        const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        await ctx.fs.mkdir(parentDir, { recursive: true });

        // Check if file exists
        if (!overwrite) {
          try {
            await ctx.fs.stat(fullPath);
            // File exists, skip
            ctx.stdout += `   skipping: ${name} (already exists)\n`;
            cdOffset += 46 + nameLen + extraLen + commentLen;
            continue;
          } catch { /* doesn't exist, proceed */ }
        }

        let fileData: Uint8Array;
        const compressedData = data.subarray(dataStart, dataStart + compSize);

        if (compression === 0) {
          fileData = compressedData;
        } else if (compression === 8) {
          try {
            fileData = await inflateRaw(compressedData);
          } catch (e: any) {
            ctx.stderr += `unzip: error inflating ${name}: ${e.message}\n`;
            cdOffset += 46 + nameLen + extraLen + commentLen;
            continue;
          }
        } else {
          ctx.stderr += `unzip: unsupported compression method ${compression} for ${name}\n`;
          cdOffset += 46 + nameLen + extraLen + commentLen;
          continue;
        }

        await ctx.fs.writeFile(fullPath, fileData);
        ctx.stdout += `  inflating: ${name}\n`;
      }

      cdOffset += 46 + nameLen + extraLen + commentLen;
    }

    if (listOnly) {
      ctx.stdout += '---------  --------------------\n';
      ctx.stdout += `${String(totalSize).padStart(9)}  ${numEntries} files\n`;
    }

    return 0;
  },
};
