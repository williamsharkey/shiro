/**
 * base32 — RFC 4648 Base32 encode/decode
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PAD = '=';

function base32Encode(input: string): string {
  if (!input) return '';
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i);

  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  // Pad to multiple of 8
  while (result.length % 8 !== 0) result += PAD;
  return result;
}

function base32Decode(input: string): string {
  const lookup = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) lookup.set(ALPHABET[i], i);

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of input) {
    if (ch === PAD) break;
    const v = lookup.get(ch.toUpperCase());
    if (v === undefined) continue; // skip invalid
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return String.fromCharCode(...bytes);
}

export const base32Cmd: Command = {
  name: 'base32',
  description: 'Base32 encode or decode',
  async exec(ctx) {
    const { flags, values, positional } = parseArgs(ctx.args, ['w']);
    const decode = flags.d || flags.decode;
    const wrap = values.w !== undefined ? parseInt(values.w, 10) : 76;
    const ignoreGarbage = flags.i || flags['ignore-garbage'];

    try {
      const { content } = await readInput(positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);

      let result: string;

      if (decode) {
        const cleaned = ignoreGarbage
          ? content.replace(/[^A-Za-z2-7=]/g, '')
          : content.replace(/\s/g, '');
        result = base32Decode(cleaned);
      } else {
        const encoded = base32Encode(content.endsWith('\n') ? content : content);
        if (wrap > 0) {
          const lines: string[] = [];
          for (let i = 0; i < encoded.length; i += wrap) {
            lines.push(encoded.substring(i, i + wrap));
          }
          result = lines.join('\n');
        } else {
          result = encoded;
        }
      }

      ctx.stdout += result + (result ? '\n' : '');
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `base32: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
