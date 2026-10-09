/**
 * zstd / unzstd / zstdcat — Zstandard decompression (see compress/zstd-codec.ts).
 * Compression is not implemented.
 */

import type { Command } from './index';
import { zstdDecodeAll, ZstdError } from './compress/zstd-codec';
import { runDecompressor, type DecoderCli } from './compress/decompress-cli';

export { ZstdError } from './compress/zstd-codec';

/** Decompress all frames in a .zst file; throws ZstdError */
export function zstdDecompress(data: Uint8Array): Uint8Array {
  if (data.length < 4) throw new ZstdError('format', 'Not a zstd file: too short');
  const zstd = data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd;
  const skippable = (data[0] & 0xf0) === 0x50 && data[1] === 0x2a && data[2] === 0x4d && data[3] === 0x18;
  if (!zstd && !skippable) throw new ZstdError('format', 'Not a zstd file: bad magic');
  return zstdDecodeAll(data);
}

const ZSTD_CLI: DecoderCli = {
  prog: 'zstd',
  suffixes: [['.zst', ''], ['.tzst', '.tar'], ['.zstd', '']],
  keepByDefault: true,
  decode: (d) => ({ data: zstdDecompress(d) }),
  describe(e) {
    if (!(e instanceof ZstdError)) return null;
    switch (e.kind) {
      case 'format': return 'unsupported format';
      case 'eof': return 'Read error (39) : premature end';
      case 'checksum': return 'Decoding error (36) : Restored data doesn\'t match checksum';
      case 'dictionary': return 'Decoding error (36) : Dictionary mismatch';
      default: return 'Decoding error (36) : Corrupted block detected';
    }
  },
  ignoredLong: ['--threads', '--memory', '--long', '--no-check', '--check', '--sparse', '--no-sparse', '--no-progress', '--progress', '--ultra', '--fast', '--single-thread', '--format'],
  shortWithValue: 'oTMD',
};

export const zstdCmd: Command = {
  name: 'zstd',
  description: 'Decompress Zstandard files (compression not implemented)',
  exec: (ctx) => runDecompressor(ctx, ZSTD_CLI, { decompress: false, toStdout: false }),
};

export const unzstdCmd: Command = {
  name: 'unzstd',
  description: 'Decompress Zstandard files',
  exec: (ctx) => runDecompressor(ctx, ZSTD_CLI, { decompress: true, toStdout: false }),
};

export const zstdcatCmd: Command = {
  name: 'zstdcat',
  description: 'Decompress Zstandard files to standard output',
  exec: (ctx) => runDecompressor(ctx, ZSTD_CLI, { decompress: true, toStdout: true }),
};
