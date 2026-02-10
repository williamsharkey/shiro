/**
 * gif-encoder.ts — Zero-dependency GIF89a encoder + SHIRO1.0 seed extractor
 *
 * Exports:
 * - captureTerminal(term): Grabs terminal content onto a canvas
 * - addOverlay(canvas, stats, hostname): Draws info bar at bottom
 * - encodeGIF(canvas, seedPayload?): Full GIF encoding pipeline
 * - extractShiroSeed(gif): Scans GIF for SHIRO1.0 extension
 */

import type { Terminal } from '@xterm/xterm';

export interface SeedData {
  version: string;
  hostname: string;
  timestamp: number;
  files: number;
  dirs: number;
  totalBytes: number;
  ndjson: string;
  storage: string;
}

// ─── Terminal Capture ────────────────────────────────────────

export function captureTerminal(term: Terminal): HTMLCanvasElement {
  const cols = term.cols;
  const rows = term.rows;
  const buffer = term.buffer.active;

  const charW = 8;
  const charH = 16;
  const pad = 8;

  const width = cols * charW + pad * 2;
  const height = rows * charH + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, width, height);

  // Render each cell from the viewport
  ctx.font = '14px monospace';
  ctx.textBaseline = 'top';

  const theme = term.options.theme || {};
  const fgDefault = theme.foreground || '#e0e0e0';

  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(y + buffer.viewportY);
    if (!line) continue;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const char = cell.getChars();
      if (!char || char === ' ') continue;

      ctx.fillStyle = getCellColor(cell, theme, fgDefault);
      ctx.fillText(char, pad + x * charW, pad + y * charH);
    }
  }

  return canvas;
}

function getCellColor(cell: any, theme: any, defaultFg: string): string {
  const mode = cell.getFgColorMode();
  const color = cell.getFgColor();

  if (mode === 0) return defaultFg;

  // P16 palette (0-15)
  if (mode === 16777216 && color >= 0 && color < 16) {
    const names = [
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ];
    return theme[names[color]] || defaultFg;
  }

  // P256: convert index to hex
  if (mode === 33554432) {
    if (color < 16) {
      const names = [
        'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
        'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
      ];
      return theme[names[color]] || defaultFg;
    }
    if (color < 232) {
      const c = color - 16;
      const r = Math.floor(c / 36) * 51;
      const g = Math.floor((c % 36) / 6) * 51;
      const b = (c % 6) * 51;
      return `rgb(${r},${g},${b})`;
    }
    const gray = (color - 232) * 10 + 8;
    return `rgb(${gray},${gray},${gray})`;
  }

  // RGB (24-bit)
  if (mode === 50331648) {
    return `#${((color >> 16) & 0xff).toString(16).padStart(2, '0')}${((color >> 8) & 0xff).toString(16).padStart(2, '0')}${(color & 0xff).toString(16).padStart(2, '0')}`;
  }

  return defaultFg;
}

// ─── Overlay Drawing ─────────────────────────────────────────

interface OverlayStats {
  files: number;
  sizeMB: string;
}

export function addOverlay(canvas: HTMLCanvasElement, stats: OverlayStats, hostname: string): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;

  const barH = 56;
  ctx.fillStyle = 'rgba(26, 26, 46, 0.85)';
  ctx.fillRect(0, h - barH, w, barH);

  // Top border
  ctx.strokeStyle = '#3d3d5c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - barH);
  ctx.lineTo(w, h - barH);
  ctx.stroke();

  // Stats
  ctx.font = '12px monospace';
  ctx.fillStyle = '#8888cc';
  ctx.fillText(hostname, 12, h - barH + 14);
  ctx.fillStyle = '#666';
  ctx.fillText(`${stats.files} files  ${stats.sizeMB} MB`, 12, h - barH + 30);

  // Instructions
  ctx.fillStyle = '#51cf66';
  ctx.fillText(`Drag this GIF to https://${hostname}`, 12, h - barH + 44);
}

// ─── GIF Encoding ────────────────────────────────────────────

export function encodeGIF(canvas: HTMLCanvasElement, seedPayload?: Uint8Array): Uint8Array {
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { width, height, data } = imageData;

  // Color quantization — collect unique colors
  const colorMap = new Map<number, number>();
  const palette: number[] = [];

  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (!colorMap.has(key) && palette.length / 3 < 256) {
      colorMap.set(key, palette.length / 3);
      palette.push(data[i], data[i + 1], data[i + 2]);
    }
  }

  // If >256 unique colors, map extras to nearest existing palette entry
  const needsNearestColor = colorMap.size < (data.length / 4);

  // Pad palette to 256 entries
  while (palette.length < 768) palette.push(0);

  // Map pixels to indices
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const pi = i * 4;
    const key = (data[pi] << 16) | (data[pi + 1] << 8) | data[pi + 2];
    let idx = colorMap.get(key);
    if (idx === undefined) {
      // Nearest color fallback
      idx = findNearestColor(data[pi], data[pi + 1], data[pi + 2], palette);
    }
    indices[i] = idx;
  }

  // LZW encode
  const lzwData = lzwEncode(indices, 8);

  // Assemble GIF
  return assembleGIF(width, height, palette, lzwData, seedPayload);
}

function findNearestColor(r: number, g: number, b: number, palette: number[]): number {
  let best = 0;
  let bestDist = Infinity;
  const count = Math.min(palette.length / 3, 256);
  for (let i = 0; i < count; i++) {
    const dr = r - palette[i * 3];
    const dg = g - palette[i * 3 + 1];
    const db = b - palette[i * 3 + 2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// ─── LZW Encoder ─────────────────────────────────────────────

function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;

  const output: number[] = [];
  let curByte = 0;
  let curBit = 0;

  function writeBits(code: number, size: number) {
    curByte |= (code << curBit);
    curBit += size;
    while (curBit >= 8) {
      output.push(curByte & 0xff);
      curByte >>= 8;
      curBit -= 8;
    }
  }

  // Use numeric keys for dictionary performance
  let dict = new Map<string, number>();

  function resetDict() {
    dict.clear();
    for (let i = 0; i < clearCode; i++) {
      dict.set(String(i), i);
    }
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  }

  resetDict();
  writeBits(clearCode, codeSize);

  if (indices.length === 0) {
    writeBits(eoiCode, codeSize);
    if (curBit > 0) output.push(curByte & 0xff);
    return new Uint8Array(output);
  }

  let current = String(indices[0]);

  for (let i = 1; i < indices.length; i++) {
    const next = current + ',' + indices[i];
    if (dict.has(next)) {
      current = next;
    } else {
      writeBits(dict.get(current)!, codeSize);

      if (nextCode < 4096) {
        dict.set(next, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
      } else {
        writeBits(clearCode, codeSize);
        resetDict();
      }

      current = String(indices[i]);
    }
  }

  writeBits(dict.get(current)!, codeSize);
  writeBits(eoiCode, codeSize);

  if (curBit > 0) output.push(curByte & 0xff);

  return new Uint8Array(output);
}

// ─── GIF Assembler ───────────────────────────────────────────

function assembleGIF(
  width: number, height: number,
  palette: number[],
  lzwData: Uint8Array,
  seedPayload?: Uint8Array,
): Uint8Array {
  const parts: Uint8Array[] = [];

  // Header
  parts.push(new TextEncoder().encode('GIF89a'));

  // Logical Screen Descriptor (7 bytes)
  const lsd = new Uint8Array(7);
  lsd[0] = width & 0xff; lsd[1] = (width >> 8) & 0xff;
  lsd[2] = height & 0xff; lsd[3] = (height >> 8) & 0xff;
  lsd[4] = 0xf7; // GCT flag + 8 bits (256 entries)
  lsd[5] = 0;    // Background color index
  lsd[6] = 0;    // Pixel aspect ratio
  parts.push(lsd);

  // Global Color Table (768 bytes)
  parts.push(new Uint8Array(palette));

  // SHIRO1.0 Application Extension
  if (seedPayload && seedPayload.length > 0) {
    parts.push(new Uint8Array([0x21, 0xFF, 0x0B]));
    parts.push(new TextEncoder().encode('SHIRO1.0'));
    parts.push(new Uint8Array([0x4F, 0x53, 0x00])); // "OS\0"

    // First 4 bytes: payload length as uint32 LE
    const lenBytes = new Uint8Array(4);
    new DataView(lenBytes.buffer).setUint32(0, seedPayload.length, true);
    const fullData = new Uint8Array(4 + seedPayload.length);
    fullData.set(lenBytes, 0);
    fullData.set(seedPayload, 4);

    let offset = 0;
    while (offset < fullData.length) {
      const chunkSize = Math.min(255, fullData.length - offset);
      parts.push(new Uint8Array([chunkSize]));
      parts.push(fullData.slice(offset, offset + chunkSize));
      offset += chunkSize;
    }
    parts.push(new Uint8Array([0x00])); // Block terminator
  }

  // Image Descriptor (10 bytes)
  const imgDesc = new Uint8Array(10);
  imgDesc[0] = 0x2C; // Image separator
  imgDesc[5] = width & 0xff; imgDesc[6] = (width >> 8) & 0xff;
  imgDesc[7] = height & 0xff; imgDesc[8] = (height >> 8) & 0xff;
  imgDesc[9] = 0; // No local color table
  parts.push(imgDesc);

  // LZW Minimum Code Size
  parts.push(new Uint8Array([8]));

  // Image data sub-blocks
  let offset = 0;
  while (offset < lzwData.length) {
    const chunkSize = Math.min(255, lzwData.length - offset);
    parts.push(new Uint8Array([chunkSize]));
    parts.push(lzwData.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  parts.push(new Uint8Array([0x00])); // Block terminator

  // Trailer
  parts.push(new Uint8Array([0x3B]));

  // Concatenate
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}

// ─── Seed Extraction ─────────────────────────────────────────

function readSubBlocks(data: Uint8Array, pos: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  while (pos < data.length && data[pos] !== 0) {
    const size = data[pos];
    chunks.push(data.slice(pos + 1, pos + 1 + size));
    pos += 1 + size;
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function decompressGzip(compressed: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(compressed as unknown as BufferSource);
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
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}

export async function extractShiroSeed(gif: Uint8Array): Promise<SeedData | null> {
  // Verify GIF header
  const header = String.fromCharCode(...gif.slice(0, 6));
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;

  // Skip Logical Screen Descriptor
  let pos = 6;
  const packed = gif[pos + 4];
  const hasGCT = (packed & 0x80) !== 0;
  const gctSize = hasGCT ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  pos += 7 + gctSize;

  // Scan blocks
  while (pos < gif.length) {
    const byte = gif[pos];

    if (byte === 0x3B) break; // Trailer

    if (byte === 0x21) {
      const label = gif[pos + 1];

      if (label === 0xFF) {
        // Application Extension
        const blockSize = gif[pos + 2];
        if (blockSize === 11) {
          const id = String.fromCharCode(...gif.slice(pos + 3, pos + 3 + 11));
          if (id === 'SHIRO1.0OS\0') {
            pos += 3 + 11;
            const data = readSubBlocks(gif, pos);
            if (data.length < 4) return null;
            const payloadLen = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
            const compressed = data.slice(4, 4 + payloadLen);
            try {
              const json = await decompressGzip(compressed);
              return JSON.parse(json) as SeedData;
            } catch {
              return null;
            }
          }
        }
      }

      // Skip extension sub-blocks
      pos += 2;
      const extBlockSize = gif[pos];
      pos += 1 + extBlockSize;
      while (pos < gif.length && gif[pos] !== 0) {
        const subSize = gif[pos];
        pos += 1 + subSize;
      }
      pos++; // Block terminator
      continue;
    }

    if (byte === 0x2C) {
      // Image Descriptor — skip image data
      const imgPacked = gif[pos + 9];
      const hasLCT = (imgPacked & 0x80) !== 0;
      const lctSize = hasLCT ? 3 * (1 << ((imgPacked & 0x07) + 1)) : 0;
      pos += 10 + lctSize;
      pos++; // LZW minimum code size
      while (pos < gif.length && gif[pos] !== 0) {
        const subSize = gif[pos];
        pos += 1 + subSize;
      }
      pos++; // Block terminator
      continue;
    }

    pos++;
  }

  return null;
}
