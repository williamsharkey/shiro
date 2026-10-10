/**
 * Bytes >= 0x80 through builtins, pipes and redirects: escapes make bytes
 * (printf '\377' is one byte), byte-oriented commands count and copy bytes,
 * and binary data round-trips (src/utils/byte-text.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;
/** Invalid UTF-8 (80 ff fe), ASCII, a valid é (c3 a9) and a newline */
const BIN = new Uint8Array([0x00, 0x80, 0xff, 0xfe, 0x41, 0xc3, 0xa9, 0x0a]);
const BIN_HEX = '00 80 ff fe 41 c3 a9 0a';

beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.writeFile('/tmp/bin', BIN);
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n').trim(), code };
}
const hex = (cmd: string) => sh(`${cmd} | od -An -tx1`);

describe('escapes make bytes', () => {
  it.each([
    ["printf '\\377'", 'ff'],
    ["printf '\\xff\\x80'", 'ff 80'],
    ["printf '\\xc3\\xa9'", 'c3 a9'],
    ["printf '%b' '\\0377'", 'ff'],
    ['echo -ne "\\xff"', 'ff'],
    ['echo -ne "\\0377\\xc3\\xa9"', 'ff c3 a9'],
    ["echo -n $'\\xff'", 'ff'],
    ["echo -n $'\\xc3\\xa9\\u00e9'", 'c3 a9 c3 a9'],
  ])('%s', async (cmd, want) => {
    expect((await hex(cmd)).out).toBe(want);
  });

  it("printf '\\377' | wc -c is 1, and so is the file it writes", async () => {
    expect((await sh("printf '\\377' | wc -c")).out).toBe('1');
    expect((await sh("printf '\\377' > /tmp/p1; wc -c < /tmp/p1")).out).toBe('1');
  });
});

describe('binary data round-trips', () => {
  it.each([
    'cat /tmp/bin',
    'base64 /tmp/bin | base64 -d',
    'base64 < /tmp/bin | base64 -d',
    'xxd -p /tmp/bin | xxd -r -p',
    'xxd /tmp/bin | xxd -r',
    'tee /dev/null < /tmp/bin',
    'head -c 100 /tmp/bin',
  ])('%s', async (cmd) => {
    expect((await hex(cmd)).out).toBe(BIN_HEX);
    expect((await sh(`${cmd} > /tmp/rt; cmp /tmp/bin /tmp/rt && echo same`)).out).toBe('same');
  });

  it('byte counts and slices', async () => {
    expect((await hex('tail -c 3 /tmp/bin')).out).toBe('c3 a9 0a');
    expect((await hex('head -c 3 /tmp/bin')).out).toBe('00 80 ff');
    expect((await sh('wc -c < /tmp/bin')).out).toBe('8');
    expect((await sh('cat /tmp/bin | wc -c')).out).toBe('8');
  });

  it('base64 encodes bytes, not UTF-16: é is w6k=', async () => {
    expect((await sh("printf 'é' | base64")).out).toBe('w6k=');
    expect((await sh('base64 /tmp/bin')).out).toBe('AID//kHDqQo=');
  });

  it('cat -v shows bytes in M- notation', async () => {
    expect((await sh('cat -v /tmp/bin')).out).toBe('^@M-^@M-^?M-~AM-CM-)');
  });

  it('cksum of stdin counts bytes', async () => {
    expect((await sh('cat /tmp/bin | cksum')).out).toBe((await sh('cksum < /tmp/bin')).out);
    expect((await sh('cat /tmp/bin | cksum')).out.split(' ')[1]).toBe('8');
  });

  it('checksums and cmp read stdin as bytes', async () => {
    const file = (await sh('sha256sum /tmp/bin')).out.split(' ')[0];
    expect((await sh('cat /tmp/bin | sha256sum')).out.split(' ')[0]).toBe(file);
    expect((await sh('cat /tmp/bin | cmp - /tmp/bin && echo same')).out).toBe('same');
  });
});
