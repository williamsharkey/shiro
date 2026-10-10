import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { xzDecompressDetailed, xzDecompressTo, XzError, XZ_NOT_STREAMABLE } from '@shiro/commands/compress/xz-codec';
import { Md5, Sha1, Sha256, Sha512, AptHashes } from '@shiro/utils/stream-hash';
import { hashFields } from '@shiro/debian/apt-method';

// apt's indexes stream through the page: xz decoded a window at a time, the
// output hashed as it goes (src/debian/apt-store.ts).

let haveXz = true;
try { execFileSync('xz', ['--version']); } catch { haveXz = false; }
const xz = (data: Uint8Array, args: string[]) => new Uint8Array(execFileSync('xz', ['-c', ...args], { input: data, maxBuffer: 1 << 30 }));

/** Text like a Packages file (compresses as such; long enough to slide the window). */
function packages(bytes: number): Uint8Array {
  const words = 'the a library tool for data files support utility package runtime module headers python perl network'.split(' ');
  let s = '', i = 0, seed = 7;
  const r = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  while (s.length < bytes) {
    s += `Package: pkg-${i++}\nVersion: ${r(9)}.${r(50)}\nDepends: ${words[r(words.length)]}-${r(1000)}\nDescription: ${Array.from({ length: 8 }, () => words[r(words.length)]).join(' ')}\nSHA256: ${createHash('sha256').update(String(i)).digest('hex')}\n\n`;
  }
  return new TextEncoder().encode(s.slice(0, bytes));
}

async function streamed(xzData: Uint8Array): Promise<{ out: Uint8Array; pieces: number; largest: number }> {
  const parts: Uint8Array[] = [];
  const r = await xzDecompressTo(xzData, async (b) => { parts.push(b); await new Promise((res) => setTimeout(res, 0)); });
  const out = new Uint8Array(r.size);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  expect(off).toBe(r.size);
  return { out, pieces: parts.length, largest: Math.max(0, ...parts.map((p) => p.length)) };
}

describe.skipIf(!haveXz)('xzDecompressTo (streaming .xz)', () => {
  const text = packages(6 << 20);

  it.each([
    ['-6 (crc64)', ['-6']],
    ['-0 crc32', ['-0', '--check=crc32']],
    ['-9e no check', ['-9e', '--check=none']],
    ['small blocks', ['-1', '--block-size=300000']],
  ])('decodes the same bytes as the whole-buffer decoder: %s', async (_name, args) => {
    const comp = xz(text, args as string[]);
    const s = await streamed(comp);
    expect(s.out.length).toBe(text.length);
    expect(Buffer.from(s.out).equals(Buffer.from(text))).toBe(true);
    expect(Buffer.from(xzDecompressDetailed(comp).data).equals(Buffer.from(s.out))).toBe(true);
    expect(s.pieces).toBeGreaterThan(1); // it streamed
  }, 60_000);

  it('concatenated streams with padding, and an empty file', async () => {
    const a = xz(text.subarray(0, 100000), ['-3']), b = xz(text.subarray(100000, 300000), ['-3']);
    const cat = new Uint8Array(a.length + 4 + b.length);
    cat.set(a); cat.set(b, a.length + 4);
    expect(Buffer.from((await streamed(cat)).out).equals(Buffer.from(text.subarray(0, 300000)))).toBe(true);
    expect((await streamed(xz(new Uint8Array(0), []))).out.length).toBe(0);
  });

  it('a corrupt check is caught; filters and SHA-256 checks say to decode whole', async () => {
    const comp = xz(text.subarray(0, 200000), ['-6']);
    const bad = comp.slice();
    bad[bad.length - 40] ^= 1; // inside the block check or index: an error either way
    await expect(streamed(bad)).rejects.toThrow(XzError);
    const flipped = comp.slice();
    flipped[Math.floor(comp.length / 2)] ^= 0x10; // LZMA data: garbage out, caught by the CRC64
    await expect(streamed(flipped)).rejects.toThrow(XzError);
    for (const args of [['--x86', '--lzma2=preset=6'], ['--check=sha256']]) {
      await expect(streamed(xz(text.subarray(0, 50000), args))).rejects.toThrow(XZ_NOT_STREAMABLE);
    }
  });
});

describe('incremental hashes', () => {
  it('match node:crypto for any split of the input', () => {
    for (const len of [0, 1, 55, 56, 64, 111, 112, 128, 1000, 65537]) {
      const d = new Uint8Array(randomBytes(len));
      for (const [C, n] of [[Md5, 'md5'], [Sha1, 'sha1'], [Sha256, 'sha256'], [Sha512, 'sha512']] as const) {
        const h = new C();
        for (let i = 0; i < len; i += 1 + (i % 97)) h.update(d.subarray(i, i + 1 + (i % 97)));
        expect(Buffer.from(h.digest()).toString('hex'), `${n} of ${len}`).toBe(createHash(n).update(d).digest('hex'));
      }
    }
  });

  it('AptHashes gives the fields hashFields gives', async () => {
    const d = packages(300000);
    const h = new AptHashes();
    for (let i = 0; i < d.length; i += 70000) h.update(d.subarray(i, i + 70000));
    expect(h.fields()).toBe(await hashFields(d));
    expect(h.size).toBe(d.length);
  });
});
