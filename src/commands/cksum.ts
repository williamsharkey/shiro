/**
 * cksum — POSIX CRC32 checksum
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';

// POSIX CRC32 lookup table (polynomial 0x04C11DB7, MSB-first)
const crcTable = new Uint32Array(256);
(function buildTable() {
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
    }
    crcTable[i] = crc >>> 0;
  }
})();

function posixCksum(data: Uint8Array): number {
  let crc = 0;
  // Process data bytes
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0;
  }
  // Fold in the byte count
  let len = data.length;
  while (len > 0) {
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0;
    len = Math.floor(len / 256);
  }
  return (~crc) >>> 0;
}

export const cksumCmd: Command = {
  name: 'cksum',
  description: 'Print CRC checksum and byte count',
  async exec(ctx) {
    try {
      const { positional } = parseArgs(ctx.args, []);

      if (positional.length === 0) {
        // Read from stdin
        const encoder = new TextEncoder();
        const data = encoder.encode(ctx.stdin);
        const crc = posixCksum(data);
        ctx.stdout += `${crc} ${data.length}\n`;
        return 0;
      }

      for (const file of positional) {
        const path = ctx.fs.resolvePath(file, ctx.cwd);
        const content = await ctx.fs.readFile(path);
        let data: Uint8Array;
        if (typeof content === 'string') {
          data = new TextEncoder().encode(content);
        } else {
          data = content;
        }
        const crc = posixCksum(data);
        ctx.stdout += `${crc} ${data.length} ${file}\n`;
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `cksum: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
