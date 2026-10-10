/**
 * xxd — hex dump and reverse
 */

import { decodeBytes, encodeText } from '../utils/byte-text';
import type { Command } from './index';
import { parseArgs, readInput } from './flags';

export const xxdCmd: Command = {
  name: 'xxd',
  description: 'Make a hex dump or reverse it',
  async exec(ctx) {
    try {
      const { values, positional, flags } = parseArgs(ctx.args, ['l', 'c', 's']);

      const reverse = flags.r;
      const plain = flags.p;
      const limit = values.l ? parseInt(values.l, 10) : -1;
      const cols = values.c ? parseInt(values.c, 10) : (plain ? 30 : 16);
      const seekOffset = values.s ? parseInt(values.s, 10) : 0;

      const { content } = await readInput(positional, () => ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);

      if (reverse) {
        // Reverse hex dump → binary
        let hex = '';
        if (plain) {
          hex = content.replace(/\s/g, '');
        } else {
          // Parse standard xxd format: skip offset and ASCII columns
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            // Standard format: "00000000: 4865 6c6c ..."
            const colonIdx = line.indexOf(':');
            if (colonIdx >= 0) {
              const hexPart = line.substring(colonIdx + 1);
              // Take only hex part (before ASCII section marked by two spaces)
              const parts = hexPart.split('  ').filter(p => p.trim());
              if (parts.length > 0) {
                hex += parts[0].replace(/\s/g, '');
              }
            } else {
              hex += line.replace(/\s/g, '');
            }
          }
        }

        const out = new Uint8Array(hex.length >> 1);
        for (let i = 0; i + 1 < hex.length; i += 2) out[i >> 1] = parseInt(hex.substring(i, i + 2), 16);
        // (byte-exact text: written back as these bytes)
        ctx.stdout += decodeBytes(out);
        return 0;
      }

      // Forward: create hex dump
      // The input's bytes (byte-exact text), not its UTF-16 units
      let data = encodeText(content);
      if (seekOffset > 0) data = data.subarray(seekOffset);
      if (limit >= 0) data = data.subarray(0, limit);

      if (plain) {
        // Plain hex dump
        const output: string[] = [];
        let line = '';
        for (let i = 0; i < data.length; i++) {
          line += data[i].toString(16).padStart(2, '0');
          if ((i + 1) % cols === 0) {
            output.push(line);
            line = '';
          }
        }
        if (line) output.push(line);
        ctx.stdout += output.join('\n') + '\n';
      } else {
        // Standard xxd format
        const output: string[] = [];
        for (let i = 0; i < data.length; i += cols) {
          const chunk = data.subarray(i, i + cols);
          const offset = (seekOffset + i).toString(16).padStart(8, '0');

          // Hex groups (2-byte pairs separated by spaces)
          const hexParts: string[] = [];
          for (let j = 0; j < cols; j += 2) {
            let pair = '';
            if (j < chunk.length) pair += chunk[j].toString(16).padStart(2, '0');
            else pair += '  ';
            if (j + 1 < chunk.length) pair += chunk[j + 1].toString(16).padStart(2, '0');
            else if (j < chunk.length) pair += '  ';
            else pair += '  ';
            if (j < chunk.length || j + 1 < chunk.length) hexParts.push(pair);
          }

          // ASCII representation
          let ascii = '';
          for (let j = 0; j < chunk.length; j++) {
            const code = chunk[j];
            ascii += (code >= 32 && code < 127) ? String.fromCharCode(code) : '.';
          }

          output.push(`${offset}: ${hexParts.join(' ').padEnd(Math.ceil(cols / 2) * 5 - 1)}  ${ascii}`);
        }
        ctx.stdout += output.join('\n') + '\n';
      }

      return 0;
    } catch (e: unknown) {
      ctx.stderr += `xxd: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
