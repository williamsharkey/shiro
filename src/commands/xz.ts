/**
 * xz / unxz / xzcat — .xz and .lzma decompression (see compress/xz-codec.ts).
 * Compression is not implemented.
 */

import type { Command } from './index';
import { isLzmaAlone, lzmaAloneDecompress, xzDecompressDetailed, XzError } from './compress/xz-codec';
import { runDecompressor, type DecoderCli } from './compress/decompress-cli';

export { XzError } from './compress/xz-codec';

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

function decodeAny(data: Uint8Array): { data: Uint8Array; warning?: string } {
  if (data.length >= 6 && XZ_MAGIC.every((m, i) => data[i] === m)) {
    const r = xzDecompressDetailed(data);
    return r.unsupportedCheck !== undefined
      ? { data: r.data, warning: 'Unsupported type of integrity check; not verifying file integrity' }
      : { data: r.data };
  }
  if (isLzmaAlone(data)) return { data: lzmaAloneDecompress(data) };
  if (data.length < 12) {
    // A prefix of the magic is a truncated file
    const truncated = data.length > 0 && XZ_MAGIC.slice(0, data.length).every((m, i) => data[i] === m);
    throw new XzError(truncated ? 'eof' : 'format', 'Not an XZ file: too short');
  }
  throw new XzError('format', 'Not an XZ file: bad magic');
}

/** Decompress .xz (any number of streams) or .lzma data; throws XzError */
export function xzDecompress(data: Uint8Array): Uint8Array {
  return decodeAny(data).data;
}

const XZ_CLI: DecoderCli = {
  prog: 'xz',
  suffixes: [['.xz', ''], ['.txz', '.tar'], ['.lzma', ''], ['.tlz', '.tar']],
  keepByDefault: false,
  decode: decodeAny,
  describe(e) {
    if (!(e instanceof XzError)) return null;
    switch (e.kind) {
      case 'format': return 'File format not recognized';
      case 'corrupt': return 'Compressed data is corrupt';
      case 'eof': return 'Unexpected end of input';
      default: return e.message.includes('filter') ? 'Unsupported filter chain or filter options' : 'Unsupported options';
    }
  },
  ignoredLong: ['--threads', '--memlimit', '--memlimit-decompress', '--memory', '--no-sparse', '--format', '--single-stream', '--ignore-check', '--extreme', '--best', '--fast', '--no-warn'],
  shortWithValue: 'TMF',
};

export const xzCmd: Command = {
  name: 'xz',
  description: 'Decompress .xz and .lzma files (compression not implemented)',
  exec: (ctx) => runDecompressor(ctx, XZ_CLI, { decompress: false, toStdout: false }),
};

export const unxzCmd: Command = {
  name: 'unxz',
  description: 'Decompress XZ files',
  exec: (ctx) => runDecompressor(ctx, XZ_CLI, { decompress: true, toStdout: false }),
};

export const xzcatCmd: Command = {
  name: 'xzcat',
  description: 'Decompress XZ files to standard output',
  exec: (ctx) => runDecompressor(ctx, XZ_CLI, { decompress: true, toStdout: true }),
};
