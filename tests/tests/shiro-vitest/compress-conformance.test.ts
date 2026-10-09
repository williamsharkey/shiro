/**
 * Compression formats against the real tools: bzip2, xz/lzma, zstd and gzip.
 *
 * The fixtures at the bottom were made by the host's bzip2 1.0.8, xz 5.4.5,
 * gzip and python-zstandard 0.25 (libzstd), from deterministic text plus a
 * small tar tree; each carries the sha256 and size of its decompressed data.
 * Tests that need a host tool (to check that it reads Shiro's output) run
 * only when the tool is installed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { bzip2Compress, bzip2Decompress, bzip2DecompressDetailed, Bzip2Error, bzcatCmd } from '@shiro/commands/bzip2';
import { xzDecompress, XzError, xzcatCmd } from '@shiro/commands/xz';
import { zstdDecompress, ZstdError } from '@shiro/commands/zstd';
import { gunzipDetailed, GzipError, zcatCmd } from '@shiro/commands/gzip';
import { suffixArray, bwtForTest } from '@shiro/commands/compress/bzip2-codec';

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const fixture = (name: string) => b64(FIXTURES[name][0]);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const lf = (s: string) => s.replace(/\r\n/g, '\n');

/** The fixture tree's UTF-8 file (found by listing: this checks content, not tar's name decoding) */
async function readCafe(fs: FileSystem): Promise<string> {
  const names = await fs.readdir('/home/user/pkg/sub');
  const name = names.find((n) => n.endsWith('.txt'));
  return (await fs.readFile(`/home/user/pkg/sub/${name}`, 'utf8')) as string;
}

async function sha256(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function expectFixture(name: string, out: Uint8Array): Promise<void> {
  expect(out.length).toBe(FIXTURES[name][2]);
  expect(await sha256(out)).toBe(FIXTURES[name][1]);
}

/** Deterministic pseudo-random bytes */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const hasHost = (tool: string) => {
  try { return spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
};
const HOST_BZIP2 = hasHost('bzip2');
// Generous: these compress a few hundred kB, and the full suite runs files in parallel
const SLOW = 120_000;

async function bytesOf(fs: FileSystem, path: string): Promise<Uint8Array> {
  const d = await fs.readFile(path);
  return d instanceof Uint8Array ? d : enc(d);
}

describe('bzip2 format', { timeout: SLOW }, () => {
  it('decodes files made by bzip2 (single block, 3 blocks at -1, runs, all byte values)', async () => {
    for (const name of ['bz_text', 'bz_multiblock', 'bz_a', 'bz_bin']) {
      await expectFixture(name, bzip2Decompress(fixture(name)));
    }
  });

  it('decodes the busybox testsuite streams (bit-aligned end of stream, empty stream)', () => {
    const hello = new Uint8Array([0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x5b, 0xb8, 0xe8, 0xa3, 0x00, 0x00,
      0x01, 0x44, 0x00, 0x00, 0x10, 0x02, 0x44, 0xa0, 0x00, 0x30, 0xcd, 0x00, 0xc3, 0x46, 0x29, 0x97,
      0x17, 0x72, 0x45, 0x38, 0x50, 0x90, 0x5b, 0xb8, 0xe8, 0xa3]);
    expect(dec(bzip2Decompress(hello))).toBe('HELLO\n');
    const a = new Uint8Array([0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x63, 0x3e, 0xd6, 0xe2, 0x00, 0x00,
      0x00, 0xc1, 0x00, 0x00, 0x10, 0x20, 0x00, 0x20, 0x00, 0x21, 0x00, 0x82, 0xb1, 0x77, 0x24, 0x53,
      0x85, 0x09, 0x06, 0x33, 0xed, 0x6e, 0x20]);
    expect(dec(bzip2Decompress(a))).toBe('a\n');
    const empty = new Uint8Array([0x42, 0x5a, 0x68, 0x39, 0x17, 0x72, 0x45, 0x38, 0x50, 0x90, 0, 0, 0, 0]);
    expect(bzip2Decompress(empty).length).toBe(0);
  });

  it('decodes randomised blocks (bzip2 0.9.0 style)', () => {
    // Made with bzip2Compress(..., { randomise: true }); the reference bzip2 1.0.8 decodes it to the same text
    const data = b64('QlpoMTFBWSZTWToy2maAAWJRgoAQQAB+L5xACAAACCAAkRBDIaaDTApVIaaEbxRpoTgT0JkTcTIn8JkTQngTQmBMCcCYKxtTQmBMlfdqfBMCexMic1vyCRdyRThQkDoy2mY=');
    expect(dec(bzip2Decompress(data))).toBe('randomised block test\n'.repeat(40) + 'x'.repeat(2000));
    const text = enc('abcabcabc'.repeat(500) + 'tail');
    expect(bzip2Decompress(bzip2Compress(text, 1, { randomise: true }))).toEqual(text);
  });

  it('decodes concatenated streams and reports trailing garbage', async () => {
    const a = fixture('bz_a'), t = fixture('bz_text');
    const both = new Uint8Array([...a, ...t]);
    const out = bzip2Decompress(both);
    expect(out.length).toBe(100000 + 8000);
    expect(out.subarray(0, 100000).every((c) => c === 0x61)).toBe(true);
    await expectFixture('bz_text', out.subarray(100000));
    const garbage = bzip2DecompressDetailed(new Uint8Array([...a, ...enc('junk\n')]));
    expect(garbage.trailingGarbage).toBe(true);
    expect(garbage.data.length).toBe(100000);
    // A partial next header is a truncated file, as with bzip2
    expect(() => bzip2Decompress(new Uint8Array([...a, 0x42]))).toThrow(Bzip2Error);
  });

  it('reports corrupt input with the kind of error and never crashes', () => {
    const good = fixture('bz_text');
    const kindOf = (b: Uint8Array) => { try { bzip2Decompress(b); return 'ok'; } catch (e) { expect(e).toBeInstanceOf(Bzip2Error); return (e as Bzip2Error).kind; } };
    expect(kindOf(enc('not bzip2 at all'))).toBe('magic');
    expect(kindOf(new Uint8Array(0))).toBe('eof');
    expect(kindOf(good.subarray(0, good.length - 7))).toBe('eof');
    const flipped = good.slice(); flipped[400] ^= 0x10;
    expect(['crc', 'data']).toContain(kindOf(flipped));
    const badCrc = good.slice(); badCrc[10] ^= 1; // the stored block CRC
    expect(kindOf(badCrc)).toBe('crc');
    for (let i = 0; i < 300; i++) {
      const m = good.slice();
      const p = 4 + ((i * 7919) % (m.length - 4));
      m[p] ^= 1 << (i % 8);
      const k = kindOf(m);
      expect(['ok', 'crc', 'data', 'eof']).toContain(k);
    }
  });

  it('round-trips edge cases at several block sizes', () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0), enc('x'), enc('ab'), new Uint8Array(4).fill(7), new Uint8Array(5).fill(7),
      new Uint8Array(255).fill(1), new Uint8Array(256).fill(1), new Uint8Array(259).fill(1),
      noise(5000, 1), enc('abab'.repeat(3000)), new Uint8Array(70000).fill(0),
    ];
    for (const level of [1, 5, 9]) {
      for (const c of cases) {
        const z = bzip2Compress(c, level);
        expect(dec(z.subarray(0, 4))).toBe(`BZh${level}`);
        expect(bzip2Decompress(z)).toEqual(c);
      }
    }
  });

  it('splits input into blocks of the requested size', () => {
    // 250 kB is three blocks at -1 and one at -9
    const data = new Uint8Array(250000);
    data.set(noise(4000, 3));
    for (let i = 4000; i < data.length; i++) data[i] = data[i - 4000] ^ (i % 7 === 0 ? 1 : 0);
    const count = (z: Uint8Array) => {
      // block magic is bit-aligned; count it at every bit offset
      let n = 0;
      const bits = (i: number) => (z[i >> 3] >> (7 - (i & 7))) & 1;
      const magic = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
      outer: for (let i = 32; i + 48 <= z.length * 8; i++) {
        for (let k = 0; k < 48; k++) if (bits(i + k) !== ((magic[k >> 3] >> (7 - (k & 7))) & 1)) continue outer;
        n++;
      }
      return n;
    };
    const z1 = bzip2Compress(data, 1), z9 = bzip2Compress(data, 9);
    expect(count(z1)).toBe(3);
    expect(count(z9)).toBe(1);
    expect(bzip2Decompress(z1)).toEqual(data);
    expect(bzip2Decompress(z9)).toEqual(data);
  }, SLOW);

  it('sorts rotations like bzip2, periodic blocks included', () => {
    const naive = (s: Uint8Array) => Array.from(s.keys()).sort((a, b) => {
      for (let k = 0; k < s.length; k++) {
        const x = s[(a + k) % s.length], y = s[(b + k) % s.length];
        if (x !== y) return x - y;
      }
      return 0;
    });
    for (let i = 0; i < 400; i++) {
      const n = 1 + (i % 37);
      const s = noise(n, i).map((c) => c % (1 + (i % 3)));
      if (i % 4 === 0) for (let k = 1 + (i % 5); k < n; k++) s[k] = s[k - 1 - (i % 5)];
      const rows = naive(s);
      const [last, origPtr] = bwtForTest(s);
      expect(Array.from(last)).toEqual(rows.map((p) => s[(p + n - 1) % n]));
      // the origPtr row is a rotation equal to the block itself
      expect(Array.from(s.keys(), (k) => s[(rows[origPtr] + k) % n])).toEqual(Array.from(s));
    }
  });

  it('suffix-sorts repetitive input without going quadratic', () => {
    const naive = (s: Uint8Array) => Array.from(s.keys()).sort((a, b) => {
      for (;;) {
        if (a === s.length) return -1;
        if (b === s.length) return 1;
        if (s[a] !== s[b]) return s[a] - s[b];
        a++; b++;
      }
    });
    for (let i = 0; i < 200; i++) {
      const s = noise(1 + (i % 50), i).map((c) => c % (1 + (i % 3)));
      expect(Array.from(suffixArray(s))).toEqual(naive(s));
    }
    for (const rep of [enc('abcdefgh'.repeat(110000)), enc('ab'.repeat(300000) + 'b')]) {
      expect(bzip2Decompress(bzip2Compress(rep))).toEqual(rep);
    }
  }, SLOW);

  it.runIf(HOST_BZIP2)('the host bzip2 decodes our output', () => {
    for (const [data, level] of [[noise(120000, 9), 1], [enc('hello world\n'.repeat(20000)), 9], [new Uint8Array(0), 9], [enc('z'), 1]] as [Uint8Array, number][]) {
      const r = spawnSync('bzip2', ['-dc'], { input: Buffer.from(bzip2Compress(data, level)), maxBuffer: 1 << 26 });
      expect(r.status).toBe(0);
      expect(new Uint8Array(r.stdout)).toEqual(data);
    }
  }, SLOW);
});

describe('bzip2 commands', { timeout: SLOW }, () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
  });

  it('bunzip2 decompresses a real .bz2 and removes it; -k keeps it', async () => {
    await fs.writeFile('/home/user/t.bz2', fixture('bz_text'));
    await fs.writeFile('/home/user/k.bz2', fixture('bz_text'));
    expect((await run(shell, 'bunzip2 t.bz2')).exitCode).toBe(0);
    await expectFixture('bz_text', await bytesOf(fs, '/home/user/t'));
    expect(await fs.exists('/home/user/t.bz2')).toBe(false);
    expect((await run(shell, 'bzip2 -dk k.bz2')).exitCode).toBe(0);
    expect(await fs.exists('/home/user/k.bz2')).toBe(true);
    await expectFixture('bz_text', await bytesOf(fs, '/home/user/k'));
  });

  it('compresses files at the requested level and pipes through bunzip2', async () => {
    await fs.writeFile('/home/user/f.txt', 'some text\n'.repeat(100));
    expect((await run(shell, 'bzip2 -1 f.txt')).exitCode).toBe(0);
    const z = await bytesOf(fs, '/home/user/f.txt.bz2');
    expect(dec(z.subarray(0, 4))).toBe('BZh1');
    expect(dec(bzip2Decompress(z))).toBe('some text\n'.repeat(100));
    expect(lf((await run(shell, 'echo hello | bzip2 | bunzip2')).output)).toBe('hello\n');
    expect(lf((await run(shell, 'echo hello | bzip2 -c > h.bz2; bzip2 -dc h.bz2')).output)).toBe('hello\n');
  });

  it('reports errors like bzip2', async () => {
    await fs.writeFile('/home/user/notbz.bz2', 'plain text');
    let r = await run(shell, 'bunzip2 notbz.bz2');
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('notbz.bz2 is not a bzip2 file.');
    r = await run(shell, 'bunzip2 missing.bz2');
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Can't open input file missing.bz2");
    const bad = fixture('bz_text'); bad[10] ^= 1;
    await fs.writeFile('/home/user/bad.bz2', bad);
    r = await run(shell, 'bzip2 -t bad.bz2');
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('data integrity (CRC) error');
    r = await run(shell, 'bunzip2 -c bad.bz2');
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('Data integrity error when decompressing');
    await fs.writeFile('/home/user/ok.bz2', fixture('bz_a'));
    expect((await run(shell, 'bzip2 -t ok.bz2')).exitCode).toBe(0);
  });

  it('bzcat writes every file to stdout and keeps them', async () => {
    await fs.writeFile('/home/user/a.bz2', bzip2Compress(enc('one\n')));
    await fs.writeFile('/home/user/b.bz2', bzip2Compress(enc('two\n')));
    const ctx = { args: ['a.bz2', 'b.bz2'], fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell };
    expect(await bzcatCmd.exec(ctx)).toBe(0);
    expect(ctx.stdout).toBe('one\ntwo\n');
    expect(await fs.exists('/home/user/a.bz2')).toBe(true);
  });

  it('tar -xjf extracts a tarball made by GNU tar + bzip2; tar -cjf makes a real .tar.bz2', async () => {
    await fs.writeFile('/home/user/p.tar.bz2', fixture('tar_bz2'));
    expect((await run(shell, 'tar -xjf p.tar.bz2')).exitCode).toBe(0);
    expect(await fs.readFile('/home/user/pkg/readme.txt', 'utf8')).toBe('hello from a real tarball\n');
    expect(await readCafe(fs)).toBe('naïve café\n');
    const bin = await bytesOf(fs, '/home/user/pkg/sub/data.bin');
    expect(Array.from(bin)).toEqual(Array.from({ length: 256 }, (_, i) => i));

    expect((await run(shell, 'tar -cjf again.tar.bz2 pkg')).exitCode).toBe(0);
    const z = await bytesOf(fs, '/home/user/again.tar.bz2');
    const tarBytes = bzip2Decompress(z);
    expect(dec(tarBytes.subarray(257, 262))).toBe('ustar');
    if (HOST_BZIP2) {
      const r = spawnSync('bzip2', ['-t'], { input: Buffer.from(z) });
      expect(r.status).toBe(0);
    }
    expect((await run(shell, 'tar -tjf again.tar.bz2')).output).toContain('pkg/sub/data.bin');
  });
});

describe('xz and lzma', { timeout: SLOW }, () => {
  it('decodes files made by xz: CRC64, SHA-256, CRC32/none, multi-block, concatenated with padding', async () => {
    for (const name of ['xz_text', 'xz_sha256', 'xz_crc32_none', 'xz_multiblock']) {
      await expectFixture(name, xzDecompress(fixture(name)));
    }
  });

  it('decodes the delta and x86 BCJ filters, and .lzma files', async () => {
    await expectFixture('xz_delta_x86', xzDecompress(fixture('xz_delta_x86')));
    await expectFixture('lzma_alone', xzDecompress(fixture('lzma_alone')));
  });

  it('rejects corrupt or foreign data instead of returning garbage', () => {
    const good = fixture('xz_text');
    const kindOf = (b: Uint8Array) => { try { xzDecompress(b); return 'ok'; } catch (e) { expect(e).toBeInstanceOf(XzError); return (e as XzError).kind; } };
    expect(kindOf(enc('hello, not xz'))).toBe('format');
    expect(kindOf(good.subarray(0, good.length - 20))).toBe('eof');
    for (let i = 0; i < 200; i++) {
      const m = good.slice();
      m[12 + ((i * 104729) % (m.length - 12))] ^= 1 << (i % 8);
      expect(kindOf(m)).not.toBe('ok');
    }
  });

  it('unxz, xz -dc and xzcat on real files; tar -xJf', async () => {
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/home/user/tx.xz', fixture('xz_text'));
    expect((await run(shell, 'xz -dk tx.xz')).exitCode).toBe(0);
    await expectFixture('xz_text', await bytesOf(fs, '/home/user/tx'));
    expect((await run(shell, 'unxz -c tx.xz | head -c 11')).output).toBe(dec((await bytesOf(fs, '/home/user/tx')).subarray(0, 11)));
    const ctx = { args: ['tx.xz'], fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell };
    expect(await xzcatCmd.exec(ctx)).toBe(0);
    expect(ctx.stdout.length).toBe(8000);
    const bad = fixture('xz_text'); bad[100] ^= 4;
    await fs.writeFile('/home/user/bad.xz', bad);
    const r = await run(shell, 'unxz bad.xz');
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('bad.xz: Compressed data is corrupt');
    expect(await fs.exists('/home/user/bad')).toBe(false);

    await fs.writeFile('/home/user/p.tar.xz', fixture('tar_xz'));
    expect((await run(shell, 'tar -xJf p.tar.xz')).exitCode).toBe(0);
    expect(await readCafe(fs)).toBe('naïve café\n');
  });
});

describe('zstd', { timeout: SLOW }, () => {
  it('decodes frames made by libzstd (checksums, no content size, many blocks, skippable frames)', async () => {
    for (const name of ['zst_text', 'zst_19', 'zst_frames']) {
      await expectFixture(name, zstdDecompress(fixture(name)));
    }
  });

  it('rejects corrupt data and bad checksums', () => {
    const good = fixture('zst_text');
    const kindOf = (b: Uint8Array) => { try { zstdDecompress(b); return 'ok'; } catch (e) { expect(e).toBeInstanceOf(ZstdError); return (e as ZstdError).kind; } };
    const sum = good.slice(); sum[sum.length - 1] ^= 1;
    expect(kindOf(sum)).toBe('checksum');
    expect(kindOf(good.subarray(0, 100))).toBe('eof');
    for (let i = 0; i < 200; i++) {
      const m = good.slice();
      m[6 + ((i * 7907) % (m.length - 6))] ^= 1 << (i % 8);
      expect(['ok', 'corrupt', 'eof', 'checksum', 'format', 'dictionary']).toContain(kindOf(m));
    }
  });

  it('zstd -d keeps the input like zstd; tar extracts .tar.zst', async () => {
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/home/user/tz.zst', fixture('zst_text'));
    expect((await run(shell, 'zstd -d tz.zst')).exitCode).toBe(0);
    await expectFixture('zst_text', await bytesOf(fs, '/home/user/tz'));
    expect(await fs.exists('/home/user/tz.zst')).toBe(true);
    await fs.writeFile('/home/user/p.tar.zst', fixture('tar_zst'));
    expect((await run(shell, 'tar -xf p.tar.zst')).exitCode).toBe(0);
    expect(await fs.readFile('/home/user/pkg/readme.txt', 'utf8')).toBe('hello from a real tarball\n');
  });
});

describe('gzip', { timeout: SLOW }, () => {
  it('decodes gzip output: -9, stored and fixed-Huffman blocks, several members', async () => {
    for (const name of ['gz_text', 'gz_stored', 'gz_fixed', 'gz_multi']) {
      await expectFixture(name, gunzipDetailed(fixture(name)).data);
    }
  });

  it('ignores trailing zeros, warns about trailing garbage, and catches bad CRCs', async () => {
    const good = fixture('gz_text');
    expect(gunzipDetailed(new Uint8Array([...good, 0, 0, 0, 0])).trailingGarbage).toBe(false);
    expect(gunzipDetailed(new Uint8Array([...good, 0x41])).trailingGarbage).toBe(true);
    const bad = good.slice(); bad[bad.length - 6] ^= 1;
    expect(() => gunzipDetailed(bad)).toThrow(GzipError);
    expect(() => gunzipDetailed(good.subarray(0, 50))).toThrow(/unexpected end of file/);
  });

  it('gunzip and zcat handle multi-member files; tar -xzf a GNU tarball', async () => {
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/home/user/m.gz', fixture('gz_multi'));
    let r = await run(shell, 'gzip -t m.gz');
    expect(r.exitCode).toBe(0);
    const ctx = { args: ['m.gz'], fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell };
    expect(await zcatCmd.exec(ctx)).toBe(0);
    expect(ctx.stdout.length).toBe(8000);
    expect((await run(shell, 'gunzip m.gz')).exitCode).toBe(0);
    await expectFixture('gz_multi', await bytesOf(fs, '/home/user/m'));
    await fs.writeFile('/home/user/g.gz', new Uint8Array([...fixture('gz_text'), 0x41, 0x42]));
    r = await run(shell, 'gunzip -c g.gz > /dev/null');
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('trailing garbage ignored');
    expect(lf((await run(shell, 'echo hi | gzip | gunzip')).output)).toBe('hi\n');
    await fs.writeFile('/home/user/p.tgz', fixture('tar_gz'));
    expect((await run(shell, 'tar -xzf p.tgz')).exitCode).toBe(0);
    expect(await fs.readFile('/home/user/pkg/readme.txt', 'utf8')).toBe('hello from a real tarball\n');
  });
});

/** [base64 of the compressed file, sha256 of its decompressed content, decompressed size] */
const FIXTURES: Record<string, [string, string, number]> = {
  bz_text: ['QlpoOTFBWSZTWTGMKPUAC4ZRgAAQQAA+795QYAt2qq6MlAKdxBRfF70cYa7gAA0UhBp6CqowAANPTSqoYEwASnkpVQyMmBoJNElUGoYBCjRkDRpkaCT1SpNTKeKZPKeo9fLFL1J9EpRPa3G1mtmIwpxrI4om8ITq87boz7RYXZdkoUMUSYTsSkptbq1a3QlO2TbHZfEdlcjswlhbdBlonGpJbVbtRKBJiS1eSEJrQidM3rosO04QUUzq52sOhV22ERodcqSOrreIEpEWpBprVuj4kJX2uyrpSqRTLF0e28950Y7Y1sK81OS2zsUFjexzwsfOPe3eYXwxqdUUiKYz2Oxk2Jc3Q4RfMnnhonlBeK9ieUGmzl4raKuhcaRew9XqcSBW9hCBAASUxFvdZnTaEiJCtebZDFkxB0desU2wQJSCUd57zepbxkS27OI7KYRuFAnp7JsSy2XrG9HtcuSTescGGEcSyBNc9ZkqHYmJROSVq1eQumHnRG92cEIJ49s9UZ2824JkxXDQzdYhVUfbDi7xFVWNIaNpyLJIZwPe9HkL1IQ+Z89PQhnIeejW9Ss3ujPQkw25gnspmD2PD17wKZ9paaUQybWs4ShQjb3sgivvQ6OVqNtuTOzGTYl4nIr63qfMm0pnpeNZ7CooxAsWUQo9WnDeXKFsoiSB1cla16jPk0x2VzkayWtQj549t68vKL5NETJJPZPMh5IQZz+PL79Tm389WhHMAEveSKl46UZmeTeoZ0eYs1s1LWZB6nO72G3N9Q5DUodrbXXK5mvsZ13PVhWZnIp6lqvvUXLxTi+1S+2ILLWoYZ1RgyzlbwscoKlFQ1rLAEnX0zVTkTrTdtVz6IUdiZN0cYux2skQTaqFGKRxHMI2KKlJG6FaogUgyaZTOu9jhGumOcaYlW1RbMFzCGjjSomUQKkmidbSjfXmcxRVX3qUztG0OKUOc8VmVmGhUhoIsbgsA7zBDjSskg6w5ArpcZKFu1xJIgWFm4LureCPBn0R2QkCTJBO13VzmPipmHPna5x6+pZba0Zm6wqRE9uvm2+WxiiKxfWtV7a1vq2q8623trVea36GKirBtslM0UWGRY2vfWq/mtV2t4ai2izoQD4ISWEyQURkBYHwnpbb+LS1j1GjZatKwiKhTak2ZXFRRsm2dIKk40Hn2bVql82ISysHXZqOW1I1qK504ZZYSlOzi3OuiSstxjSldZrCW0CXQ5oNYpthmhJhmsubYgSu+9ar0t5bbJjV7Vqv7tW97VX3XJmUSKSEmZZIUQJGMZJkFNBok0b/e7u7/S746Z+MWlxna0Caq6rl3ViIk0tTEMSMOi5Mo2hdXaHZLkZi6tslz1SsMYKKLCJs25SXV1jajVzJaqjUIFAAgROVEokAESKraQjtGUw5VdDPVGktrQ22M0q7UxRFEx9oQDoEkPrA+EkDURJJbGsmqGbEaaRGxbRUCWjFsb31rb7tW+bW3165owhaKSlJkTKZGFjJCDZIwopeNar8taprW/W3qqI2KxBtjReLW2mrlk2DRaNG18bbZquY0WKiowFi0lRUGCivxuRFb82/bYyYoKKBIgsYoyTQjJTIClMEmhIZQ0QJKJGYt8Vav3bVdat6Wry2jFixsbUW0akCq/q2qa3NiIoijFiio2+fbNIJmowTCUYkxSLMhtEpMljO1bwtFiNs/mtV66tXiteGxYjY1GNHa1t6bXw29pG3Ndd2phmSqYeJueU6TkQkElK5SEcrnOmixdNwTGuXC5zu6pI1HMWLG4Hd1zcCObJYuQFyAuWakuruKLpOkleUKYKIIbuuzhTnXEK6aL01vLUbGLJaNG2KKxaIKLFfLvhP/olRVmLpmKhpJSh5Ll4qikEkYWkgkVpoUgRi5kSK5YuhFpkEUaeuqeEamVVi63AeThRRVFWNGxVGootFGixqNqNpKqX/i7kinChIGMYUeoA=', '9a78b3f2437c95184bebfba72c2750815ad2051b82bc4ccf77b3a7509799a0d7', 8000],
  bz_multiblock: ['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', '8f440941014750e23bc229ed53776b4eb2a17803efcea80d85a9a3b80f617828', 250000],
  bz_a: ['QlpoOTFBWSZTWUNR2fUAAMYRAIQAIAAACCAAMMwFKacYQtgQvF3JFOFCQQ1HZ9Q=', '6d1cf22d7cc09b085dfc25ee1a1f3ae0265804c607bc2074ad253bcc82fd81ee', 100000],
  bz_bin: ['QlpoOTFBWSZTWbq+0ZsAAAP/////////////////////////////////////////////wAK8AAAJMABMAATAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABJgAJgACYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJMABMAATAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqqgJgJgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH9EBECEDEEEFH/CDCDiECEiFCFiGD/xDRDhDxEBEREhExFBFRFhFxGBGRGhGxHBHRHhHxIBIRIhIxJBJRJhJxKBKRKhKxLBLRLhLxMBMRMhMxNBNRNhNxOBOROhOxPBPRPhPxQBQRQhQxRBRRRhRxSBSRShSxTBTRThTxUBURUhUxVBVRVhVxWBWRWhWxXBXRXhXxYBYRYhYxZBZRZhZxaBaRahaxbBbRbhbxcBcRchcxdBdRdhdxeBeRehexfBfRfhfxgBgRghgxhBhRhhhxiBiRihixjBjRjhjxkBkRkhkxlBlRlhlxmBmRmhmxnBnRnhnxoBoRohoxpBpRphpxqBqRqhqxrBrRrhrxsBsRshsxtBtRthtxuBuRuhuxvBvRvhvxwBwRwhwxxBxRxhxxyByRyhyxzBzRzhzx0B0R0h0x1B1R1h1x2B2R2h2x3B3R3h3x4B4R4h4x5B5R5h5x6B6R6h6x7B7R7h7x8B8R8h8x9B9R9h9x+B+R+h+x/B/R/hdyRThQkLq+0Zs=', '10fc3c51a152e90e5b90319b601d92ccf37290ef53c35ff92507687d8a911a08', 2048],
  xz_text: ['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', '9a78b3f2437c95184bebfba72c2750815ad2051b82bc4ccf77b3a7509799a0d7', 8000],
  xz_sha256: ['/Td6WFoAAArh+wyhAgAhARYAAAB0L+Wj4Au3A1JdADebSWDFbS5fMTE4koluG1TJcbvPCEB0nsDcuwWumRo5i7Yc23b1pOaDStv4wVkfE6PIQBR7r5HEYUUdigUICHTmLFt0opUKCRfpCpdhWAUgx2aZnZP0RrYXElwKY+JSC7kqZIxORKNiiRQIpNcC78o/7GUz6cY+gHij9RhFwHF9zg4izbGUQQvwzNAs7Lsz+KgpDljPjM9Swnh3lb1OXBBrooL2beDOiHXJFuO+GZXR32KywqPWwj0yBY6s93xZKETmk1b3BrCmBpwoggc2kMFkE9h78SSnTrtIK0hPuASjdhi2winzcLAiM+rd7BprPLSRLx7wJNqVLWf+KVsGzOoyMQlirTABPYTEFhQ6IukDX36Te7tyovkmuyTNAI2o2M4vZc2FvhI2/0nZs/r0IaV4Bt1jflbar4bkWMaFvfKQk/erW7GkAiYsbx5N2bqhbwgyBl8zAyK/A3UvuosEHWNgHcvzoUUjH7BDI5HoYQX6LdPLEMcQC1AQlUhT6gkXQT0VL4iI2WNlmUzT+LE8TMbd2sB4VhYw2hktZvPJiTN2GsXJIZu2G58U8KBYpm7IKLWU0fbc5w5+5kiOsPJdMfBYSQIHKkkw2C1Kh+SYxq+Zft5fVMt0RES1syDM58ELxEoK/S0GP7/Ox/lfGA9LD5lbTdBiCvCW84P9UMhbok5RaWwsmtX06pqfysB49MPd+HbGyxltMG2Nw43miGuyD8SWG34aT88Ia8YXj2OpHEIIcfw1xFPuePPUDNEF75jbm+Y6ljML1RVdDg++di7TH6pydaF+BXfVjuhv0bIascu6E54uRHsDNaf6xF/K74KZUcXZqqSRUY3M9DpL+u9cJHFiIEKMvHeJ8abLZ36VAkoncCAZYREL1mHafmo+Nkv/fGWHPeu4VyfWB5wef26Vyek07jxZiriHvyVNnFB3n1K0g0k3Z+lc6tYmHNoMbMiY1HVebILQV9rg3xZEfb5lVg7IlhlUiXgyGW25/asZGt82xKPXSe18chW9zje7xCWaSdDJvHh1eLm457JYb0fsioXGCYnKth+pbv4DNCDdVGWsBc865oBtT5+9VGmjqiY5bx/eHGKjARf/E/BlOH4mzGLkmSo8lC4mYlDp3gcSsfcqBQAAAADiHeGlLBvtL5Rjij0QpYg0mWAgZFFUp5y7CBguKKZIaQABhge4FwAAiCwzeLbp3xwCAAAAAApZWg==', 'e21de1a52c1bed2f94638a3d10a58834996020645154a79cbb08182e28a64869', 3000],
  xz_crc32_none: ['/Td6WFoAAAFpIt42AgAhARYAAAB0L+Wj4APnAWRdADebSWDFbS5fMTE4koluG1TJcbvPCEB0nsDcuwWumRo5i7Yc23b1pOaDStv4wVkfE6PIQBR7r5HEYUUdigUICHTmLFt0opUKCRfpCpdhWAUgx2aZnZP0RrYXElwKY+JSC7kqZIxORKNiiRQIpNcC78o/7GUz6cY+gHij9RhFwHF9zg4izbGUQQvwzNAs7Lsz+KgpDljPjM9Swnh3lb1OXBBrooL2beDOiHXJFuO+GZXR32KywqPWwj0yBY6s93xZKETmk1b3BrCmBpwoggc2kMFkE9h78SSnTrtIK0hPuASjdhi2winzcLAiM+rd7BprPLSRLx7wJNqVLWf+KVsGzOoyMQlirTABPYTEFhQ6IukDX36Te7tyovkmuyTNAI2o2M4vZc2FvhI2/0nZs/r0IaV4Bt1jflbar4bkWMaFvfKQk/erW7GkAiYsbx5N2bqhbwgyBl8zAyK/A3U5uILrr5/NctJZAJgV13IAAfwC6AcAAI0hQc0+MA2LAgAAAAABWVoAAAAAAAAAAP03elhaAAAA/xLZQQIAIQEWAAAAdC/lo+AD5wFvXQAQHAkiA4uwlA5ZpBHKpRamrhtjTknhS+jU7JKLAyGAyJfoGRhODoa7N6O288EwPrjYPWhAhCoOAR+9JKFl2DtrLtYiFtf92YDgjpAuSFKKS1v46oTSu8pDr/kX42DNGBjyOuJyEWUPE35V3HMZzST1F7OGyMygCsTbX/lo0F+7OFNds1GfYW3pViuBnfVAZtYzIGc7GDIH9zdo7Fnq6fCQPBWb3kTnpZIzx/OXBHlU80heIigqJOcm9EoxbEOiujNyOS27qtczbd1eL/vvPXM4XaorD9aB/fvlUUs2QKPQNm3p0YzX6IGcJQoSw0fkmcMLPu4/fXEYMZvlUdHKf2HOGskly7tSFRrXEUQzjqgfqo3f0PR3So6T82aB3omTRmm+VfOgO6U/+sALEV87O6EuEE+0lv0/CPNvWhoBWULbTsoY8/JPDyMYUF7dF9NtNuOuclwTDNX70jd17jxQVXXpMgxeBcVFK6fw8XbIAGevAAAAAYMD6AcAACm3VQqoAAr8AgAAAAAAWVo=', 'e5e7adc3e9103e7591454070ac2f7552f6f1608862fc59bcf6fead88fe269df9', 2000],
  xz_delta_x86: ['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', 'a98e0c563918ad6080cf5581938f6022392768869970d5db9023003b65cd7b27', 7000],
  xz_multiblock: ['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', '9a78b3f2437c95184bebfba72c2750815ad2051b82bc4ccf77b3a7509799a0d7', 8000],
  lzma_alone: ['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', '9a78b3f2437c95184bebfba72c2750815ad2051b82bc4ccf77b3a7509799a0d7', 8000],
  zst_text: ['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', '9a78b3f2437c95184bebfba72c2750815ad2051b82bc4ccf77b3a7509799a0d7', 8000],
  zst_19: ['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', '9a78b3f2437c95184bebfba72c2750815ad2051b82bc4ccf77b3a7509799a0d7', 8000],
  zst_frames: ['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', 8005],
  gz_text: ['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', '9a78b3f2437c95184bebfba72c2750815ad2051b82bc4ccf77b3a7509799a0d7', 8000],
  gz_multi: ['H4sIAAAAAAAEA12Ya24bQQyD/88p9mpuEiSLxrHRxkDR05fkJ82MC8T7mJEoktKu3d6u58uv29dx/30ePy/3++V46PJTK32+Po7vy2O8vn1+X46vx/Gm05/zuF3f3nOvpd/n+/UyWAHk3miOvlWNz8v1x6tvlTkUoT9v6xSAo/bPmxc/zsHq++V61b34iYn+KkoUUmpcPu8fiXfO8aKPAL8/9sJaHMoESWJKaQq9ldyS6TpOBQAGP9YCyzmOcFc4zkDjrxdzKJrCG8aktrzqAl034H/OoOGgIbIK5K+P2+wFhbfNlIqOXGG+qlTzhlyiMiQTiRy5wJqba9dcFgJkBJBLc25ESD01rFpu5xTp2Snxoj5qUwXA6mFwSVBcGGH/6c+UMZ77aHw9xpLdFT1OQoy2nlxHdX2Ro3c7f1ZgETNqhjFG5dlyB3RjxoHUtaaFIC/aHn+AK4Hp+tOERadsD0cBtKO5f4rEhzmx2QvvUqMdQlYq955thIijaScgBxkU1xwSFd7WolmZPH1q6zyoZz1aSQuGY6sToUBv3OVQjA9tg7vhBRtEzkhF3eIcjeB6U+MHf9WoK2JTRMJC+czQkshRnIlb819maKGAnCrqJqeTsNLh9KoimFJtdjUYrrgeYGaj54/eY2K8og122zXj4YR2eZsB6DMg5WhVXmKzgqA6wa/e6h2gCG89EtYeKqp7ai6K6HI1EBr52cb48qzbVK1nlGXobE4bupBDZXQ5mW7l7j+2YBjHNTOaknpsXSG6nXJ9ZFzo7OaJgyZEv2/yZTJneD4E9UCKmdCqvc8ngI3pdphutLYl3lC2Af2RovCzHbuYVuyY9B7WmiGtTH+Vnc32jsbFbWj4S0BPjN+fWW3YbXa2KcZsUzZ1W6YCGO2bevSGOTnAQ69V7TD3cqTx+zxnqPPbBjcLZKMWWrQwDbl0UCfs5myG9PZ6Stb7TKz058qYJ7K2OdrXQSG5oUBFzl8KMgBTdWHdwoiRBuohaw59VnuL4f5FMxBGX4RW1pX9SSjXxnQ9q+SlKlSEb2e6sYWQAGzIdIYueyM49MLdbaKqY3eempWH0kH7Dt5sNqnplu++dbavcY9CHJ1THQkJ5EOziNeJXFX1D4zWtkArSt2qKz8Ha4IwCYxO9mThmL53Yo/h5m5/hzQgIg3bA16V7AabMmy6iKkyIbY4hS0ixdN6Z5PgAd/ZRUh3z/JzTXnrBQIU98QGU/5Ms/KCASH+hoyEz+eGyJliT7pgW5HCZZTGAYg8NcwvNNwZFNpFMGqGWd54Ttkup9qAy71po9F0b2sds02knSQss9ONhQp3Kjs16DqmoFN3U2oP5lKWmO35p0x8y0GpGZMoyRT45Vb5a5i01pryLQ8p8/ZHHezKoRLi1mrbCPWjZeVrpmEWEt6sDVeXovIpuf2dg1xcADTMuVRCUcgPmhooCRC3Hv/U0j2VXZQws/RH3AHjqKV62rQhTspMwW4cVkq//1HEPJSIVb1LW5Yj26ZFNy8dElQmBUCZsaGN+MI3WXzAAShkiFnOJU20fvn+9Gu/FexDXNB2RR/eHYC5mgcWV1hrXfbIe3jhZK5kV6jpnJE2RkhpAbGgiR0XBVjfGIaURWyBCFdWJKaNRGSgsShu2e7U9918L6hYduVzzslSGYtIdBbWVhNezXKnyygtUpAj9LQYf/J6CeSasMqztCbfoidWbyTVnnWn3MLtt0aYbfgGtfmtu2zsLsn0xbqu6GPsk0H+JYzPHIOdA46nIJl5vrqYOW4t8LLdrCGgi80CPfWbW7/S1Ab9SXvAQbEAxxkk5aEGCSgrYbGTJ7pnwDOkVE4PS6g45b0GhhoIjCs1M+enge5v96A3tQSJVKXP5QSQlOxOEdB3u7MexWDs7EhmSrqyFGVhDu7Si0ulzBIo51dLLSbWgvxidoQ89mUKbf/Yc4id9ug0W9DVmrJo2zKEP+HeRH0TSOJpcH1rKRZuLhDg+r+vevy1v64asImIQi9hkEFw2yPWrZl8sVlK/wH04kbfiBMAAB+LCAAAAAAAAANtVtuO6yAMfOcr8mukW23QljTaFinq1x/b4wGTsw+9hJixZ3yBn3wcefmx72Mr9smPY8tLeb5zOl5l+bo/3nm56Ut52pv9HAWb0l2eHs/d3gPmLtbPev/Oyzu35TvXmnVLwprCmomirPrHvtT0Vb5rTgB51nL7FVhdP8vyyHX9ystHTZt7tDBTbRbze+tQ5gEcaGquEzGFAl84rqz4P9vsb5Ov0Rg+7vNWpaFBwgWCNyI0+N2eFiFkJBa4dnGUI3b5A6zdl8OuUBYkLFBbkeDVh2qT1BFw7L0Gph/shyZimzRZIR0gFggpnuwzO+yauTOI0wrhKEn+qK1+DJEG/EUAe0ufCAP6tgFlcYGvLRl8f/GZg1ACkn+B9dgDBQg4VCJmFB6kDBSitSkwOhJ+Skx07iuvEZPV8oZaNrt1NIC596Boj8AEs7aLECLiVLAj+mT/2HOhSWGHHBw9qeQKV8bv8LgQTALdwJyVdJReOdb8ALS3lXU0d6jWk4fxKqOrUWK9TFjJ8Abh8V9rrdcNEiyEV8o6qsN1xF5XUcbK3jgkuvjWkxuh/qhtfzwtqWcxpkLv08sB8KDlU80JMC7g75g+vRb8lwOEAkQxNFiWhGPRHJgn0+ydFDOq1tIVilFbTB219y5MsTxIJrYin0YLek+oPNiAb4nGp5TyfHPEWQf4hJFI5uTZQVLwfOta+SqODUS2t/8mhQ++uYK8bMZJZP7o97Ckph7vSKOSEauVC5a9adpRjZHoMBoS27G2oIuhxcmd2mVu8bmfbPphZ6TJPzwPhcNIWhmwCxcL7eMNqbx1/eRAUC/z9Lr8emXApmdIoOB5HJ46n/4kNPWDa+JjJdb7mJ6TvLvNa7i/zDA8AlDlFmWnw0SJcpgdo6F0CAAbFIDt+pKcJsBmRc/JKPcWRbXlFBu22nAJUx3OtMvmYyfcQa6XhNHjXY52yY+b1ubxes33Nu/DkBVOxDNIwdN/bvZwhCclPKjM1yQ8jaZMPo7YSuEC5UuJE3VU39nviXCoWuNtzG+8Vex+sHgW67ieTbcgJHHrF09q7YOpNxkUmK9OPrTKuAOFSwLZ0uu4RHHlLF4FRL2hJae+6HVsWcI9Y0w+P5+ma0h/Imy1AxiblE4UffhQSf8BAo2HcLgLAAA=', '9a78b3f2437c95184bebfba72c2750815ad2051b82bc4ccf77b3a7509799a0d7', 8000],
  gz_stored: ['H4sIAAAAAAAEAwG4C0f0b21pY3JvbiBwc2kga2FwcGEgdXBzaWxvbiB1cHNpbG9uIG11IHRhdQpkZWx0YSBudSBldGEgeGkgb21lZ2EgbnUgbnUgc2lnbWEKb21lZ2Ega2FwcGEgcGkga2FwcGEgZXRhIG9taWNyb24gbGFtYmRhIG9tZWdhCnBpIHBpIGV0YSBwaSBzaWdtYSBsYW1iZGEgaW90YSBwaGkKc2lnbWEgZ2FtbWEgcHNpIG11IG11IGxhbWJkYSB4aSBrYXBwYQphbHBoYSBwaGkgcGhpIGNoaSBwaSB0aGV0YSBvbWljcm9uIGNoaQptdSBnYW1tYSB0YXUga2FwcGEgaW90YSBlcHNpbG9uIG11IHRhdQpwc2kgZXRhIHRoZXRhIHNpZ21hIGJldGEgdGhldGEgdGhldGEgdGhldGEKZXRhIHBzaSBkZWx0YSBhbHBoYSB6ZXRhIHpldGEgbGFtYmRhIHBzaQpwc2kgZ2FtbWEgbnUgcHNpIGV0YSBlcHNpbG9uIGJldGEgeGkKZXRhIG9tZWdhIGV0YSBiZXRhIGFscGhhIHJobyB1cHNpbG9uIHRoZXRhCmJldGEgYWxwaGEgemV0YSBpb3RhIHpldGEga2FwcGEgbnUgdXBzaWxvbgp4aSBnYW1tYSBkZWx0YSBpb3RhIGJldGEgdGF1IGRlbHRhIHRhdQpjaGkgZXRhIG9tZWdhIGdhbW1hIHpldGEgZ2FtbWEgcHNpIHVwc2lsb24KYWxwaGEgc2lnbWEgbGFtYmRhIGthcHBhIHBzaSBlcHNpbG9uIGxhbWJkYSByaG8Ka2FwcGEgcGhpIGdhbW1hIG9taWNyb24gY2hpIHNpZ21hIGV0YSB0aGV0YQpvbWVnYSBldGEgYmV0YSB4aSBvbWljcm9uIGxhbWJkYSBpb3RhIG51CnpldGEgaW90YSBlcHNpbG9uIHBpIHBoaSBiZXRhIHVwc2lsb24gemV0YQprYXBwYSBwc2kgdGhldGEgYWxwaGEgc2lnbWEgdGhldGEgc2lnbWEgZGVsdGEKb21lZ2EgZGVsdGEgeGkgc2lnbWEgcmhvIHhpIGNoaSB6ZXRhCnhpIG11IGRlbHRhIGNoaSBwc2kgcHNpIHRoZXRhIG9taWNyb24KcHNpIGlvdGEgZXBzaWxvbiBldGEgdGF1IGJldGEgbXUgdXBzaWxvbgpiZXRhIGlvdGEgZXBzaWxvbiBvbWVnYSBtdSBnYW1tYSBpb3RhIGFscGhhCmthcHBhIG11IG9tZWdhIGJldGEgaW90YSBvbWVnYSB0YXUgZGVsdGEKeGkgcmhvIGJldGEgYmV0YSBwaSB6ZXRhIHRhdSB6ZXRhCnJobyBwaSBldGEgcHNpIGthcHBhIHVwc2lsb24gbnUgcGkKYWxwaGEgemV0YSBiZXRhIGV0YSBsYW1iZGEgbXUgb21pY3JvbiByaG8KaW90YSBwc2kgcGkgdGhldGEgcGhpIHBzaSBjaGkgbGFtYmRhCnJobyBwaGkgZGVsdGEgYWxwaGEgZGVsdGEgb21lZ2EgYmV0YSBwaGkKbGFtYmRhIG11IGxhbWJkYSBhbHBoYSBpb3RhIHhpIGV0YSBwaQpjaGkgb21lZ2Egb21lZ2EgbnUgYWxwaGEgbnUgdXBzaWxvbiBkZWx0YQpudSBsYW1iZGEgZXRhIG11IHBoaSBtdSB4aSBzaWdtYQpwc2kgbGFtYmRhIGdhbW1hIG11IGlvdGEgeGkgZGVsdGEgc2lnbWEKcHNpIG9taWNyb24gc2lnbWEgZXBzaWxvbiB0aGV0YSBrYXBwYSBiZXRhIGRlbHRhCnRhdSBldGEgemV0YSBnYW1tYSBtdSBwaGkgcmhvIHNpZ21hCm9taWNyb24gc2lnbWEgZGVsdGEgemV0YSB0aGV0YSBlcHNpbG9uIHRhdSBzaWdtYQpvbWVnYSBwaSBldGEgZ2FtbWEgYWxwaGEgeGkgc2lnbWEgeGkKbGFtYmRhIHBpIHVwc2lsb24gdGF1IHhpIG9taWNyb24gcGkgemV0YQpvbWljcm9uIHJobyBwaGkgaW90YSB4aSBkZWx0YSBwaGkgYmV0YQpwaGkgbXUgdGhldGEgZXBzaWxvbiBwaSB1cHNpbG9uIHhpIGdhbW1hCnVwc2lsb24gbnUgZXRhIGNoaSBrYXBwYSBzaWdtYSBzaWdtYSByaG8KaW90YSBwaSBwaSBiZXRhIHBoaSB6ZXRhIGNoaSBtdQpyaG8gb21lZ2EgZGVsdGEgemV0YSBwaGkgc2lnbWEgcmhvIGVwc2lsb24KcGkgcHNpIGthcHBhIHRhdSBkZWx0YSB0aGV0YSB4aSBtdQpsYW1iZGEgbGFtYmRhIGxhbWJkYSBkZWx0YSBwaGkgcmhvIGV0YSBiZXRhCm9taWNyb24gcGhpIHhpIHRhdSB0YXUgbnUgemV0YSBldGEKc2lnbWEgc2lnbWEgdXBzaWxvbiB0YXUgYmV0YSBvbWVnYSBtdSB0YXUKb21pY3JvbiBudSBiZXRhIGVwc2lsb24gZ2FtbWEgaW90YSBkZWx0YSB4aQplcHNpbG9uIGlvdGEgdXBzaWxvbiB6ZXRhIGdhbW1hIGxhbWJkYSBldGEgZ2FtbWEKZXRhIHJobyBjaGkgbnUga2FwcGEgY2hpIHBzaSBjaGkKdGF1IHJobyBtdSBwaSBwaGkgbXUgeGkgbXUKdXBzaWxvbiB1cHNpbG9uIGFscGhhIHhpIGNoaSBwc2kgb21pY3JvbiByaG8Ka2FwcGEgcHNpIHJobyBtdSBiZXRhIHRoZXRhIGJldGEgcmhvCm9taWNyb24gc2lnbWEgc2lnbWEgYmV0YSBvbWVnYSBvbWljcm9uIGthcHBhIGJldGEKa2FwcGEgbXUgbXUgbXUgY2hpIG9tZWdhIHBpIGV0YQp6ZXRhIHpldGEgemV0YSBtdSB6ZXRhIHNpZ21hIG9tZWdhIHBoaQpzaWdtYSBudSBnYW1tYSBudSB0YXUgcGkgaW90YSBldGEKcGkgYmV0YSBvbWljcm9uIG9taWNyb24geGkgYmV0YSBvbWljcm9uIGxhbWJkYQp0aGV0YSBkZWx0YSBudSBwaSBwaGkgbGFtYmRhIGJldGEgdXBzaWxvbgpudSBrYXBwYSBiZXRhIHRoZXRhIGlvdGEgZ2FtbWEgeGkgcmhvCmVwc2lsb24gbGFtYmRhIGlvdGEga2FwcGEgeGkgbXUgdGF1IGxhbWJkYQpiZXRhIGFscGhhIGV0YSBvbWljcm9uIG51IGNoaSB1cHNpbG9uIGFscGhhCnBoaSBldGEgY2hpIHVwc2lsb24gc2lnbWEgemV0YSBzaWdtYSBwaGkKcGkgcmhvIHVwc2lsb24gcmhvIG9tZWdhIGFscGhhIGFscGhhIHpldGEKa2FwcGEgYmV0YSBkZWx0YSBrYXBwYSBsYW1iZGEgbGFtYmRhIG9tZWdhIGNoaQp4aSBlcHNpbG9uIHJobyBvbWVnYSBsYW1iZGEgbXUgbGFtYmRhIHRhdQprYXBwYSBwc2kgdGhldGEgb21lZ2EgZXBzaWxvbiBwc2kgZ2FtbWEgcGkKaW90YSByaG8gZXBzaWxvbiBwaSBsYW1iZGEgbGFtYmRhIHNpZ21hIHRhdQp0YXUgcmhvIGxhbWJkYSBldGEgc2lnbWEgbnUgYWxwaGEgZXRhCmJldGEgcGkgemV0YSB0YXUgYWxwaGEgc2lnbWEgbXUgYmV0YQplcHNpbG9uIGdhbW1hIGthcHBhIGdhbW1hIHhpIHRoZXRhIGthcHBhIHhpCmV0YSBtdSBkZWx0YSBwaGkgc2lnbWEgZGVsdGEgdGhldGEgYmV0YQp4aSBvbWVnYSBjaGkgZXRhIGthcHBhIGJldGEgemV0YSBwc2kKb21pY3JvbiBvbWVnYSB4aSBvbWVnYSBwc2kga2FwcGEgeGkgZXBzaWxvbgpldGEgZ2Fts2GBpbgLAAA=', 'e21de1a52c1bed2f94638a3d10a58834996020645154a79cbb08182e28a64869', 3000],
  gz_fixed: ['H4sIAAAAAAAEA8vPzUwuys9TKCjOVMhOLChIVCgFMnOAIjA6t1ShJLGUKyU1pyRRIa9UIRVIVWQq5OempoP5QFScmZ6byAURgRhSADMNpDofakdOYm5SSiJEJxdQBRCBpIEU2ACYfGY+SDAjkwsimp6YCyRB7gO6BIigqiqgNnAl5hRkgNWDcXIG2NySDGSLgYJcQJ0Qk4CegboNbFEqqjdB9oC0QgyAuCAJIYBEcoHdDlQOCRmIM6pAgmAC6kygArCZELuBYQWzAGZvEiQ8uSDuBYUgiAUWhRhZlJEPjwuIxUiSYKvA/gCzIP4C2gLVwFUBsxniSLBKiHeAoQARA/kaFGoIB0B0gA1EBD7MRIi9KBEGjXKQx6DuhEoAnc4FlcyAOQQpTqCmIEIUzf/gVIaSdMDuzyvlQngbZmMBJPrB+mChBVLFhXAcJO6Q3Y8cyeDAgLoAEjAVMAeCYqACkrTARlaAkyJEETi9FWciWQB1MjjWUZwIC3awG3MRcZSE4RmIK+ApFiwHdjfUN0AZiBKEVggfHqsgN4KcnQQPzAKI48FKwL4AScNyIEbmByXUTC6kNAY2Ayldg50AiRtQLEPybDFS3iuABgwogCB6IDZmoGYYCBvJN6CMj7ADyoKoBVtSASs0wIkWohFeFkHUIdI/NDDy4AZBgx7kCiAFi2FwXEFVQIIcKAmzDeJChDqYt6GJFzlnQgMR7A+IzaDQhhcJcKNB1oMCA1ZuIhsIsa4KUdjAbUhELWihcQcxFOJxeIqtgIdhQSai8EgsRc5S0ATBhRSNYIeh+huWqbigQYbqJiTTYSUNF1ISSoVmEEiwQJwGz1LQNANOMrCYh/g7GWwVOLkg58cqmCJEroS6A1yZwNMwUtGWAS1GgKZBwwOVQvgRbBo0ncODBCQB1A0yEITzIDkHpI4L2TPIAZyEKEahNQrMsDyoJCzskPI2rLzhgsmBRZGLMahqpFQMCWwQC+R0UJDlweq1ZETWAydAkAJQqstESvfAEEGv6OFpCKYfOYMjilGoaUiVYhLUFWgpGanyhGVTiDQilyDKMwhCZGlI6uZC1KdV0KxbhSiyoSrhLYW8UkQ1C/J3AawALgE3N5KQmwQwugJNHFpUQTwGb/NAgw4a/MiVDBc81JECBGwrxCmQcpgLrWIEK4Bog1QmIOdCrUaq3ZEdlgcJHZTIAmdKWI6ByUDCAimYQAFUkInSjkBkLYhFiIKeC70IgzoTNd9A9ILSVwWi0kcYilF+g/IBekUMrexhJQm8jQQs2cHBg5S/QeGP6gBo/Q00FpbAkbIGPDXAQ5ELowpEbgZAUzMXas6EuBcei8gFPLS5Bm8EIAol5HInCdpWgAeWAloVUQWte7kQiRKkEq4FUaQhQpkLmvcBs2GBpbgLAAA=', 'e21de1a52c1bed2f94638a3d10a58834996020645154a79cbb08182e28a64869', 3000],
  tar_bz2: ['QlpoOTFBWSZTWdSrvBYAAVV/////////////////////////////////////////////sAGZpFgyQAABMAACYAAAAATTCYjTAAAAAIwAAJgEwATAAAATABpMDQAAmAAAAAQqnkCniaIPQEYjTTEwTIGajCZAAZpDENA2hNHomTDU9AmQwQ0ZNNGBNMQA00wEwRkwmAEaNAaaDTCYg0wRkBkkSM0oaYjTQ09T1AAAaZNqAB6gAAAAGmRhBoAaAAAANNNAAaGgABoaAA0NDRiaANAAAAH6wgOASnh9EAEWIZGahCSP8zBBBcOIBFANBNAQwQ8BwpdCGYIpBCAgCSd1wQ8NFPKCbIJvMnrA7acvU6nb5PG09bz7OKqdnVbPEiCusLOfWltcVRBEILxkQenZ7QqZjRaPSaVhYj2m07GyMrMlLeWdXitqCgHkvoINUBQAEXW53e/QTYECvILAQ5QiuMBZAiLkJVnLlkFIFyLCsydVLqZAoHYrEVpgujuGAzZsBo6EKIGhILGCQLCBBXYbHZbPaNLUfa9rttu2NrduNzum/dpu8Vt6TvlgjfrLggcXIs5rnAdCnBX+EhdSohoELse4YJB4oAu7ujE/qGZlN5Qg0VfT5gDT0cMlwRCD35dWXOIkYgjbTIGzRLccIMG0slLEQTC4CCAtdJH5KJRwBTTp3MiCAQf3wh2dSwRjQhDGMIao2CFuQ33zVusMc1x+QyOSyeUyuWy+Y6GazeczsdHyEjJScp+5WWl5iZmpucnZ6f/lBQ0VHSUtNT1FTVVdYWg66Gr7CxshCzRLS1tre4/tzdXd5e31/gYOFhowNcAWSYgxP9i42PkZOUEy2YADMCmoJm52foaOlp6mrra+xs//a29wc3Xze3+Dh4uPk5ebn6BbpiOrr7O3u7/Dx8hQECABefn6evt7i7kinChIalXeCwA=', '0e30ba046d18eba19cd79e27ee1a2c9d7e3340b29700264cd48bbd2d3e5a14b1', 10240],
  tar_xz: ['/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AcRdADgayRWYrNGyNLfPL52tDilYvn2FQ23KYq0MJ1KPhI8V/dZTHxc/fhpgBEQHhIz/S3FMOoMgDPjlDmYi+b1ShMNXJGGni/QTrs+oUlABFo3+X6E8txoMXsVPVSvJMRgd9jFoIY7aaGrF/VhaxJDff5kCfcwFOt9Pt8V2mLZLT6lwtQbkXZC0wv+Ar2W9j79HvVHGMbVX6vXMXhz2v0RCI9lIQ6+2woPMKyPtaD8yeVKBeQJgZp5w3pjOLrilGrRVD2JyqBAjnuqj5+7A1glQ822OB/LpSnuAIkmrfbyh3EUnCg6usz8gqxZhPmWoYknDoLDtB4PHRRbPrESJd/k1nbIiy6wKHNO5xnivASWRT/hmCnhPZVfWROskoIP3DyZ3oDLNefGy67PbVwtXLLz/CFjMRkA/A9x1715vO6vwqLeGVYo76HHCoUnlOWiSa1zfKuO/br+por5KlacBH4XODYpP44eq6/mbzjNUaR8LH7mq1s9mIFLjvCLk38fW/S0ONGuCca6M77TlDu14C7Lc0P3o0esJ29UjZ5iSy9DBvVa08u10MfD2jRuadII8thdjtzI85Ji7pSM6ylcr9KcjenWd3dYAAM1HaCAQVVWpAAHgA4BQAAAELVQTscRn+wIAAAAABFla', '0e30ba046d18eba19cd79e27ee1a2c9d7e3340b29700264cd48bbd2d3e5a14b1', 10240],
  tar_gz: ['H4sIAAAAAAAAAyvITtdnoDEwAAJzU1MwDQToNJhtaGxmYGRuZmACEjc0MDY2ZlAwpbXDQKC0uCSxSEGBoSg/vwSfOkLyQxQUAOO/KDUxJTdVr6SCRh4ERbCZiQnu+Dc2Qot/I2MjEwYFA9o4BxWM8PjPSM3JyVdIK8rPVUhUACaEHAVgcCQl5uRwDbTLRgE9ACj/F5cm0bQOIL38NzQE5f/R8p/2ABb/yYlph5sPraRJJUCw/Dc0RYt/YzNz49Hynx4gL/Hw+rJUBVD0rxwt8kcegOX/lMSSRL2kzDxa2EEo/5tglP9GpkaGo/mfLoCRiZmFlY2dg5OLm4eXj19AUEhYRFRMXEJSSlpGVk5eQVFJWUVVTV1DU0tbR1dPH9Q2NzE1M7ewtLK2sbWzd3B0cnZxdXP38PTy9vH18w8IDAoOCQ0Lj4iMio6JjYtPSExKTklNS8/IzMrOyc3LLygsKi4pLSuvqKyqrqmtq29obGpuaW1r7+js6u7p7eufMHHS5ClTp02fMXPW7Dlz581fsHDR4iVLly1fsXLV6jVr163fsHHT5i1bt23fsXPX7j179+0/cPDQ4SNHjx0/cfLU6TNnz52/cPHS5StXr12/cfPW7Tt3791/8PDR4ydPnz1/8fLV6zdv373/8PHT5y9fv33/8fPX7z9///0f6OAfBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSigNgAAuPzJgQAoAAA=', '0e30ba046d18eba19cd79e27ee1a2c9d7e3340b29700264cd48bbd2d3e5a14b1', 10240],
  tar_zst: ['KLUv/WQAJ60PAGQYcGtnLwAwMDAwNzU1MDAwADEzNjAyNzYwNDEwMzMzACA1dXN0YXIgIAByb290cGtnL3JlYWRtZS50eDY0NDMyMjMyNAAgMGhlbGxvIGZyb20gYSByZWFsIHRhcmJhbGwKc3ViMTFjYWbDg8KpMTUzNjczbmHDr3ZlIKlkYXRhLmJpbjI1MjEAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7/KiAAg5FAApn5/ZceAOin5hiVrsD9YmEADCgmD3gRcEBuH+oVcDVjVUKHA34BCwRBHBvQgrIVDLAVH5BFK9ADmxnALMisCjzQAUbd0eEBYUOOhfsJELyfhgrBkBekSTGwmjp8aMgCAcdehiejBZzT+bI=', '0e30ba046d18eba19cd79e27ee1a2c9d7e3340b29700264cd48bbd2d3e5a14b1', 10240],
};
