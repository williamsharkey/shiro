import { describe, it, expect } from 'vitest';
import { decodeBytes, encodeText, byteLength } from '@shiro/utils/byte-text';
import { createTestShell } from './helpers';
import { Kernel } from '@shiro/kernel/kernel';
import { BufferFile } from '@shiro/kernel/fd';

const every = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
const utf8 = new TextEncoder().encode('héllo wörld — ✓ 𝄞\n');

describe('byte-exact text (surrogateescape)', () => {
  it('round-trips any bytes and decodes valid UTF-8 as usual', () => {
    const random = new Uint8Array(65536);
    crypto.getRandomValues(random);
    const edge = Uint8Array.from([
      0xef, 0xbb, 0xbf, 0x41, // BOM kept
      0xc0, 0xaf, 0xe0, 0x80, 0xaf, // overlongs
      0xed, 0xa0, 0x80, // encoded surrogate
      0xf4, 0x90, 0x80, 0x80, // > U+10FFFF
      0xe2, 0x82, // truncated
      0xf0, 0x9f, 0x98, 0x80, // valid 😀
      0xff, 0x80, 0xc3,
    ]);
    for (const b of [every, random, edge, utf8, new Uint8Array(0)]) {
      const s = decodeBytes(b);
      expect(encodeText(s)).toEqual(b);
      expect(byteLength(s)).toBe(b.length);
    }
    expect(decodeBytes(utf8)).toBe('héllo wörld — ✓ 𝄞\n');
    expect(decodeBytes(edge).startsWith('﻿A')).toBe(true);
    expect(decodeBytes(edge)).toContain('😀');
    // other lone surrogates encode as U+FFFD, as TextEncoder does
    expect(encodeText('a\ud800b')).toEqual(new TextEncoder().encode('a\ud800b'));
  });
});

describe('binary data through string-stdio commands', () => {
  async function setup() {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/bin', every);
    await fs.writeFile('/tmp/u8', utf8);
    const run = async (cmd: string) => {
      let out = '';
      await shell.execute(cmd, (s) => { out += s; }, () => {});
      return out;
    };
    const file = async (p: string) => await fs.readFile(p) as Uint8Array;
    return { fs, shell, run, file };
  }

  it('cat, pipes, tee, redirections and dd keep every byte', async () => {
    const { run, file } = await setup();
    for (const cmd of [
      'cat /tmp/bin > /tmp/o', 'cat /tmp/bin | cat > /tmp/o', 'cat < /tmp/bin > /tmp/o',
      'cat /tmp/bin | tee /tmp/o > /dev/null', 'dd if=/tmp/bin bs=256 2>/dev/null > /tmp/o',
      'cat /tmp/bin | dd of=/tmp/o 2>/dev/null',
    ]) {
      await run('rm -f /tmp/o');
      await run(cmd);
      expect(await file('/tmp/o'), cmd).toEqual(every);
    }
  });

  it('head/tail -c, cut -b and wc -c count bytes', async () => {
    const { run, file } = await setup();
    await run('head -c 300 /tmp/bin > /tmp/o');
    expect(await file('/tmp/o')).toEqual(every.subarray(0, 300));
    await run('tail -c 300 /tmp/bin > /tmp/o');
    expect(await file('/tmp/o')).toEqual(every.subarray(724));
    await run('tail -c +1001 /tmp/bin > /tmp/o');
    expect(await file('/tmp/o')).toEqual(every.subarray(1000));
    await run('head -c -24 /tmp/bin > /tmp/o');
    expect(await file('/tmp/o')).toEqual(every.subarray(0, 1000));
    await run('cat /tmp/bin | head -c 10 > /tmp/o');
    expect(await file('/tmp/o')).toEqual(every.subarray(0, 10));
    // in the middle of a UTF-8 character: the bytes, not a character
    await run('head -c 2 /tmp/u8 > /tmp/o');
    expect(await file('/tmp/o')).toEqual(utf8.subarray(0, 2));
    await run('cut -b 1-3 /tmp/u8 > /tmp/o');
    expect(await file('/tmp/o')).toEqual(Uint8Array.from([...utf8.subarray(0, 3), 0x0a]));
    expect((await run('head -c 1000 /dev/urandom | wc -c')).trim()).toBe('1000');
    await run('head -c 4096 /dev/urandom > /tmp/r');
    expect((await file('/tmp/r')).length).toBe(4096);
    expect((await run('wc -c < /tmp/bin')).trim()).toBe('1024');
    expect((await run('cat /tmp/bin | wc -c')).trim()).toBe('1024');
  });

  it('gzip and tar output written with > is the exact archive', async () => {
    const { run, file } = await setup();
    await run('gzip -c /tmp/bin > /tmp/b.gz');
    const gz = await file('/tmp/b.gz');
    expect([gz[0], gz[1]]).toEqual([0x1f, 0x8b]);
    await run('gunzip -c /tmp/b.gz > /tmp/o');
    expect(await file('/tmp/o')).toEqual(every);
    await run('cat /tmp/b.gz | gunzip > /tmp/o');
    expect(await file('/tmp/o')).toEqual(every);
    await run('cd /tmp && tar cf - bin u8 > /tmp/a.tar && mkdir -p x && cd x && tar xf /tmp/a.tar');
    expect(await file('/tmp/x/bin')).toEqual(every);
    expect((await run('head -c 16 /dev/urandom | od -An -tx1 | wc -w')).trim()).toBe('16');
    expect((await run('head -c 16 /dev/urandom | sum | wc -w')).trim()).toBe('2');
  });

  it('a builtin run as a kernel process writes the bytes it read', async () => {
    const { fs, shell } = await setup();
    const kernel = new Kernel({ shell, fs });
    const out = new BufferFile(null);
    const p = kernel.spawn({ path: 'cat', argv: ['cat'], cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, fds: { 0: new BufferFile(every), 1: out, 2: out } });
    await p.wait();
    expect(out.bytes()).toEqual(every);
  });
});
