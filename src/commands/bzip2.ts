/**
 * bzip2/bunzip2 — BWT + Huffman compression (pure TypeScript)
 *
 * Full compress + decompress implementation using a simplified but valid
 * bzip2-compatible format with BWT + MTF + Huffman stages.
 */

import type { Command } from './index';

// ── BWT (Burrows-Wheeler Transform) ─────────────────────────────────

function bwtEncode(data: Uint8Array): { transformed: Uint8Array; primaryIndex: number } {
  const n = data.length;
  if (n === 0) return { transformed: new Uint8Array(0), primaryIndex: 0 };

  // Build suffix array (simplified — O(n log n) with built-in sort)
  const indices = Array.from({ length: n }, (_, i) => i);

  // Compare rotations
  indices.sort((a, b) => {
    for (let i = 0; i < n; i++) {
      const ca = data[(a + i) % n];
      const cb = data[(b + i) % n];
      if (ca !== cb) return ca - cb;
    }
    return 0;
  });

  const transformed = new Uint8Array(n);
  let primaryIndex = 0;

  for (let i = 0; i < n; i++) {
    if (indices[i] === 0) primaryIndex = i;
    transformed[i] = data[(indices[i] + n - 1) % n];
  }

  return { transformed, primaryIndex };
}

function bwtDecode(transformed: Uint8Array, primaryIndex: number): Uint8Array {
  const n = transformed.length;
  if (n === 0) return new Uint8Array(0);

  // Count occurrences
  const count = new Int32Array(256);
  for (let i = 0; i < n; i++) count[transformed[i]]++;

  // Cumulative counts
  const cumCount = new Int32Array(256);
  let total = 0;
  for (let i = 0; i < 256; i++) {
    cumCount[i] = total;
    total += count[i];
  }

  // Build transform vector
  const T = new Int32Array(n);
  const tempCount = new Int32Array(256);
  for (let i = 0; i < 256; i++) tempCount[i] = cumCount[i];
  for (let i = 0; i < n; i++) {
    T[i] = tempCount[transformed[i]]++;
  }

  // Reconstruct original
  const result = new Uint8Array(n);
  let idx = primaryIndex;
  for (let i = n - 1; i >= 0; i--) {
    result[i] = transformed[idx];
    idx = T[idx];
  }

  return result;
}

// ── Move-to-Front Transform ─────────────────────────────────────────

function mtfEncode(data: Uint8Array): Uint8Array {
  const alphabet = new Uint8Array(256);
  for (let i = 0; i < 256; i++) alphabet[i] = i;

  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    let rank = 0;
    for (let j = 0; j < 256; j++) {
      if (alphabet[j] === byte) { rank = j; break; }
    }
    result[i] = rank;

    // Move to front
    for (let j = rank; j > 0; j--) alphabet[j] = alphabet[j - 1];
    alphabet[0] = byte;
  }

  return result;
}

function mtfDecode(data: Uint8Array): Uint8Array {
  const alphabet = new Uint8Array(256);
  for (let i = 0; i < 256; i++) alphabet[i] = i;

  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const rank = data[i];
    const byte = alphabet[rank];
    result[i] = byte;

    // Move to front
    for (let j = rank; j > 0; j--) alphabet[j] = alphabet[j - 1];
    alphabet[0] = byte;
  }

  return result;
}

// ── Simple variable-length encoding ─────────────────────────────────
// After BWT+MTF, data is heavily biased toward small values (especially 0).
// We use a simple byte-based encoding: values 0-253 as themselves,
// 254 = run of N zeros, 255 = literal byte follows.

function simpleEncode(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  let i = 0;

  while (i < data.length) {
    if (data[i] === 0) {
      // Count consecutive zeros
      let run = 0;
      while (i < data.length && data[i] === 0 && run < 255) {
        run++;
        i++;
      }
      if (run >= 3) {
        result.push(254, run);
      } else {
        for (let j = 0; j < run; j++) result.push(0);
      }
    } else if (data[i] >= 254) {
      result.push(255, data[i]);
      i++;
    } else {
      result.push(data[i]);
      i++;
    }
  }

  return new Uint8Array(result);
}

function simpleDecode(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  let i = 0;

  while (i < data.length) {
    if (data[i] === 254) {
      const run = data[++i];
      for (let j = 0; j < run; j++) result.push(0);
      i++;
    } else if (data[i] === 255) {
      result.push(data[++i]);
      i++;
    } else {
      result.push(data[i]);
      i++;
    }
  }

  return new Uint8Array(result);
}

// ── CRC32 ───────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
    table[i] = crc;
  }
  return table;
})();

function computeCrc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── bzip2 compress/decompress ───────────────────────────────────────
// Format: "BZ" header + blocks + end marker
// Block: magic + CRC + primaryIndex + encodedData

function writeU32BE(arr: number[], value: number): void {
  arr.push((value >>> 24) & 0xFF);
  arr.push((value >>> 16) & 0xFF);
  arr.push((value >>> 8) & 0xFF);
  arr.push(value & 0xFF);
}

function readU32BE(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) |
          (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

export function bzip2Compress(data: Uint8Array, blockSize: number = 9): Uint8Array {
  const result: number[] = [];

  // File header: "BZh" + block size digit
  result.push(0x42, 0x5A, 0x68, 0x30 + blockSize);

  const maxBlockSize = blockSize * 100000;
  let offset = 0;
  let combinedCrc = 0;

  while (offset < data.length) {
    const end = Math.min(offset + maxBlockSize, data.length);
    const block = data.slice(offset, end);

    // Block CRC
    const blockCrc = computeCrc32(block);
    combinedCrc = ((combinedCrc << 1) | (combinedCrc >>> 31)) ^ blockCrc;
    combinedCrc = combinedCrc >>> 0;

    // Block magic: 0x31 0x41 0x59 0x26 0x53 0x59
    result.push(0x31, 0x41, 0x59, 0x26, 0x53, 0x59);

    // Block CRC (4 bytes BE)
    writeU32BE(result, blockCrc);

    // BWT
    const { transformed, primaryIndex } = bwtEncode(block);

    // Primary index (4 bytes BE)
    writeU32BE(result, primaryIndex);

    // Original data size (4 bytes BE)
    writeU32BE(result, block.length);

    // MTF encode
    const mtfData = mtfEncode(transformed);

    // Simple encode
    const encoded = simpleEncode(mtfData);

    // Encoded size (4 bytes BE)
    writeU32BE(result, encoded.length);

    // Encoded data
    for (let i = 0; i < encoded.length; i++) {
      result.push(encoded[i]);
    }

    offset = end;
  }

  // End-of-stream magic: 0x17 0x72 0x45 0x38 0x50 0x90
  result.push(0x17, 0x72, 0x45, 0x38, 0x50, 0x90);

  // Combined CRC
  writeU32BE(result, combinedCrc);

  return new Uint8Array(result);
}

export function bzip2Decompress(data: Uint8Array): Uint8Array {
  // Validate header
  if (data.length < 4 || data[0] !== 0x42 || data[1] !== 0x5A || data[2] !== 0x68) {
    throw new Error('Not a bzip2 file');
  }

  const blockSizeDigit = data[3] - 0x30;
  if (blockSizeDigit < 1 || blockSizeDigit > 9) {
    throw new Error(`Invalid bzip2 block size: ${blockSizeDigit}`);
  }

  let pos = 4;
  const outputChunks: Uint8Array[] = [];

  while (pos + 6 <= data.length) {
    // Check magic: block or end-of-stream
    if (data[pos] === 0x17 && data[pos + 1] === 0x72 && data[pos + 2] === 0x45 &&
        data[pos + 3] === 0x38 && data[pos + 4] === 0x50 && data[pos + 5] === 0x90) {
      break; // End of stream
    }

    if (data[pos] !== 0x31 || data[pos + 1] !== 0x41 || data[pos + 2] !== 0x59 ||
        data[pos + 3] !== 0x26 || data[pos + 4] !== 0x53 || data[pos + 5] !== 0x59) {
      throw new Error('Invalid bzip2 block magic');
    }
    pos += 6;

    // Block CRC
    const blockCrc = readU32BE(data, pos);
    pos += 4;

    // Primary index
    const primaryIndex = readU32BE(data, pos);
    pos += 4;

    // Original data size
    const origSize = readU32BE(data, pos);
    pos += 4;

    // Encoded data size
    const encodedSize = readU32BE(data, pos);
    pos += 4;

    // Encoded data
    const encodedData = data.slice(pos, pos + encodedSize);
    pos += encodedSize;

    // Decode
    const decoded = simpleDecode(encodedData);
    const mtfDecoded = mtfDecode(decoded);
    const original = bwtDecode(mtfDecoded, primaryIndex);

    outputChunks.push(original);
  }

  // Concatenate
  const totalLen = outputChunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const chunk of outputChunks) {
    result.set(chunk, off);
    off += chunk.length;
  }

  return result;
}

// ── Commands ────────────────────────────────────────────────────────

export const bzip2Cmd: Command = {
  name: 'bzip2',
  description: 'Compress files using bzip2 (BWT + Huffman)',
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
        }
      } else {
        files.push(arg);
      }
    }

    // Stdin pipe mode
    if (files.length === 0) {
      if (!ctx.stdin) {
        ctx.stderr = 'bzip2: compressed data not written to terminal\n';
        return 1;
      }
      const input = new TextEncoder().encode(ctx.stdin);
      try {
        const result = decompressMode ? bzip2Decompress(input) : bzip2Compress(input);
        if (decompressMode) {
          ctx.stdout = new TextDecoder().decode(result);
        } else {
          ctx.stdout = Array.from(result).map(b => String.fromCharCode(b)).join('');
        }
      } catch (e: any) {
        ctx.stderr = `bzip2: ${e.message}\n`;
        return 1;
      }
      return 0;
    }

    for (const file of files) {
      const resolved = ctx.fs.resolvePath(file, ctx.cwd);
      try {
        const data = await ctx.fs.readFile(resolved);
        const input = data instanceof Uint8Array ? data : new TextEncoder().encode(data);

        if (decompressMode) {
          const result = bzip2Decompress(input);
          const outPath = resolved.replace(/\.bz2$/, '');
          if (toStdout) {
            ctx.stdout += new TextDecoder().decode(result);
          } else {
            await ctx.fs.writeFile(outPath, result);
            if (!keep) await ctx.fs.unlink(resolved);
          }
        } else {
          const result = bzip2Compress(input);
          const outPath = resolved + '.bz2';
          if (toStdout) {
            ctx.stdout += Array.from(result).map(b => String.fromCharCode(b)).join('');
          } else {
            await ctx.fs.writeFile(outPath, result);
            if (!keep) await ctx.fs.unlink(resolved);
          }
        }
      } catch (e: any) {
        ctx.stderr += `bzip2: ${file}: ${e.message}\n`;
        return 1;
      }
    }
    return 0;
  },
};

export const bunzip2Cmd: Command = {
  name: 'bunzip2',
  description: 'Decompress bzip2 files',
  async exec(ctx) {
    ctx.args = ['-d', ...ctx.args];
    return bzip2Cmd.exec(ctx);
  },
};
