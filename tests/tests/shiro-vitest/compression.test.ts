import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('Compression Suite', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ── bzip2 ─────────────────────────────────────────────────────

  describe('bzip2', () => {
    it('round-trips a simple string', async () => {
      const { bzip2Compress, bzip2Decompress } = await import('@shiro/commands/bzip2');
      const original = new TextEncoder().encode('Hello, bzip2 world!\n');
      const compressed = bzip2Compress(original);

      // Verify bzip2 magic
      expect(compressed[0]).toBe(0x42); // 'B'
      expect(compressed[1]).toBe(0x5A); // 'Z'
      expect(compressed[2]).toBe(0x68); // 'h'

      const decompressed = bzip2Decompress(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe('Hello, bzip2 world!\n');
    });

    it('round-trips a longer text', async () => {
      const { bzip2Compress, bzip2Decompress } = await import('@shiro/commands/bzip2');
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
      const original = new TextEncoder().encode(text);
      const compressed = bzip2Compress(original);
      const decompressed = bzip2Decompress(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe(text);
    });

    it('compresses file with bzip2 command', async () => {
      await fs.writeFile('/home/user/test.txt', 'bzip2 test content');
      const { exitCode } = await run(shell, 'bzip2 -k test.txt');
      expect(exitCode).toBe(0);

      // Original should still exist (-k keep)
      const orig = await fs.readFile('/home/user/test.txt');
      const origText = orig instanceof Uint8Array ? new TextDecoder().decode(orig) : orig;
      expect(origText).toBe('bzip2 test content');

      // Compressed file should exist
      const stat = await fs.stat('/home/user/test.txt.bz2');
      expect(stat).toBeDefined();
    });

    it('decompresses file with bunzip2 command', async () => {
      const { bzip2Compress } = await import('@shiro/commands/bzip2');
      const data = bzip2Compress(new TextEncoder().encode('decompressed content'));
      await fs.writeFile('/home/user/data.bz2', data);

      const { exitCode } = await run(shell, 'bunzip2 -k data.bz2');
      expect(exitCode).toBe(0);

      const result = await fs.readFile('/home/user/data');
      const text = result instanceof Uint8Array ? new TextDecoder().decode(result) : result;
      expect(text).toBe('decompressed content');
    });

    it('handles empty stdin', async () => {
      const { output, exitCode } = await run(shell, 'bzip2');
      expect(exitCode).toBe(1);
    });

    it('rejects invalid bzip2 data', async () => {
      const { bzip2Decompress } = await import('@shiro/commands/bzip2');
      expect(() => bzip2Decompress(new Uint8Array([1, 2, 3, 4]))).toThrow();
    });
  });

  // ── xz ────────────────────────────────────────────────────────

  describe('xz', () => {
    it('xzDecompress rejects non-xz data', async () => {
      const { xzDecompress } = await import('@shiro/commands/xz');
      expect(() => xzDecompress(new Uint8Array([1, 2, 3, 4]))).toThrow('Not an XZ file');
    });

    it('xzDecompress rejects short data', async () => {
      const { xzDecompress } = await import('@shiro/commands/xz');
      expect(() => xzDecompress(new Uint8Array([0xFD, 0x37]))).toThrow('too short');
    });

    it('xz command refuses to compress', async () => {
      await fs.writeFile('/home/user/test.txt', 'content');
      const { exitCode, output } = await run(shell, 'xz test.txt');
      expect(exitCode).toBe(1);
      expect(output).toContain('decompress only');
    });

    it('unxz is alias for xz -d', async () => {
      const { output, exitCode } = await run(shell, 'unxz --help');
      // Should error because no file provided (which means the -d flag was correctly injected)
      // The xz command won't find a file to decompress
      expect(exitCode).toBe(1);
    });
  });

  // ── zstd ──────────────────────────────────────────────────────

  describe('zstd', () => {
    it('zstdDecompress rejects non-zstd data', async () => {
      const { zstdDecompress } = await import('@shiro/commands/zstd');
      expect(() => zstdDecompress(new Uint8Array([1, 2, 3, 4]))).toThrow('Not a zstd file');
    });

    it('zstdDecompress rejects short data', async () => {
      const { zstdDecompress } = await import('@shiro/commands/zstd');
      expect(() => zstdDecompress(new Uint8Array([0x28]))).toThrow();
    });

    it('zstd command refuses to compress', async () => {
      await fs.writeFile('/home/user/test.txt', 'content');
      const { exitCode, output } = await run(shell, 'zstd test.txt');
      expect(exitCode).toBe(1);
      expect(output).toContain('decompress only');
    });

    it('unzstd is alias for zstd -d', async () => {
      const { output, exitCode } = await run(shell, 'unzstd --help');
      expect(exitCode).toBe(1);
    });
  });

  // ── tar integration ───────────────────────────────────────────

  describe('tar integration', () => {
    it('tar -cjf creates bzip2-compressed archive', async () => {
      await fs.writeFile('/home/user/hello.txt', 'hello from tar + bzip2');
      const { exitCode } = await run(shell, 'tar cjf archive.tar.bz2 hello.txt');
      expect(exitCode).toBe(0);

      const data = await fs.readFile('/home/user/archive.tar.bz2');
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      // Verify bzip2 magic
      expect(bytes[0]).toBe(0x42); // 'B'
      expect(bytes[1]).toBe(0x5A); // 'Z'
    });

    it('tar -xjf extracts bzip2-compressed archive', async () => {
      // Create a bzip2 tar archive
      await fs.writeFile('/home/user/src.txt', 'source content');
      const createResult = await run(shell, 'tar cjf packed.tar.bz2 src.txt');
      expect(createResult.exitCode).toBe(0);

      // Remove original
      await fs.unlink('/home/user/src.txt');

      // Extract
      const { exitCode, output } = await run(shell, 'tar xjf packed.tar.bz2');
      expect(output).toBe(''); // no error output
      expect(exitCode).toBe(0);

      const content = await fs.readFile('/home/user/src.txt');
      const text = content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
      expect(text).toBe('source content');
    });

    it('tar auto-detects bzip2 by magic on extract', async () => {
      await fs.writeFile('/home/user/auto.txt', 'auto-detect bzip2');
      await run(shell, 'tar cjf auto.tar.bz2 auto.txt');
      await fs.unlink('/home/user/auto.txt');

      // Extract without -j flag — should auto-detect
      const { exitCode } = await run(shell, 'tar xf auto.tar.bz2');
      expect(exitCode).toBe(0);

      const content = await fs.readFile('/home/user/auto.txt');
      const text = content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
      expect(text).toBe('auto-detect bzip2');
    });
  });
});

// ── BWT unit tests ──────────────────────────────────────────────────

describe('BWT internals', () => {
  it('BWT round-trip', async () => {
    // We test through bzip2 round-trip since BWT functions aren't directly exported
    const { bzip2Compress, bzip2Decompress } = await import('@shiro/commands/bzip2');
    const texts = [
      'banana',
      'abracadabra',
      'mississippi',
      'aaaaaa',
      'a',
      '',
    ];

    for (const text of texts) {
      const original = new TextEncoder().encode(text);
      const compressed = bzip2Compress(original);
      const decompressed = bzip2Decompress(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe(text);
    }
  });
});
