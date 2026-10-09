import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FileSystem } from '@shiro/filesystem';
import { aptStoreProgram } from '@shiro/debian/apt-store';

/** Run the store method over apt's protocol: messages in on fd 0, replies collected from fd 1. */
async function runStore(fs: FileSystem, input: string): Promise<string> {
  let pending = new TextEncoder().encode(input);
  const stdin = {
    tryRead(buf: Uint8Array) {
      const n = Math.min(buf.length, pending.length);
      buf.set(pending.subarray(0, n));
      pending = pending.subarray(n);
      return n;
    },
  };
  const proc: any = { fds: new Map([[0, stdin]]) };
  let out = '';
  const kernel: any = { fs, writeAll: async (_p: unknown, _fd: number, b: Uint8Array) => { out += new TextDecoder().decode(b); } };
  expect(await aptStoreProgram(proc, kernel)).toBe(0);
  return out;
}

const acquire = (src: string, dest: string) => `600 URI Acquire\nURI: store:${src}\nFilename: ${dest}\n\n`;
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

describe('shiro-apt-store (apt store method)', () => {
  const text = 'Package: hello\nVersion: 2.10-5\n\n'.repeat(500);

  it('decompresses .gz and plain indexes and reports the output hashes', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/lists/partial', { recursive: true });
    await fs.writeFile('/tmp/lists/partial/a_Packages.gz', new Uint8Array(gzipSync(text)));
    await fs.writeFile('/tmp/lists/partial/b_Packages', text);
    const out = await runStore(fs, acquire('/tmp/lists/partial/a_Packages.gz', '/tmp/lists/a_Packages')
      + acquire('/tmp/lists/partial/b_Packages', '/tmp/lists/b_Packages'));
    expect(out.startsWith('100 Capabilities\n')).toBe(true);
    expect(await fs.readFile('/tmp/lists/a_Packages', 'utf8')).toBe(text);
    expect(await fs.readFile('/tmp/lists/b_Packages', 'utf8')).toBe(text);
    const done = out.split('\n\n').filter((m) => m.startsWith('201 URI Done'));
    expect(done).toHaveLength(2);
    for (const m of done) {
      expect(m).toContain(`Size: ${text.length}`);
      expect(m).toContain(`SHA256-Hash: ${sha256(text)}`);
    }
  });

  it.skipIf(!(() => { try { execFileSync('xz', ['--version']); return true; } catch { return false; } })())('decompresses .xz (what Debian ships)', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/lists/partial', { recursive: true });
    await fs.writeFile('/tmp/lists/partial/c_Packages.xz', new Uint8Array(execFileSync('xz', ['-c'], { input: text })));
    const out = await runStore(fs, acquire('/tmp/lists/partial/c_Packages.xz', '/tmp/lists/c_Packages'));
    expect(await fs.readFile('/tmp/lists/c_Packages', 'utf8')).toBe(text);
    expect(out).toContain(`SHA256-Hash: ${sha256(text)}`);
  });

  it('keeps a compressed list compressed (GzipIndexes) and fails cleanly on a missing file', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/lists/partial', { recursive: true });
    const gz = new Uint8Array(gzipSync(text));
    await fs.writeFile('/tmp/lists/partial/d_Packages.gz', gz);
    const out = await runStore(fs, acquire('/tmp/lists/partial/d_Packages.gz', '/tmp/lists/d_Packages.gz')
      + acquire('/tmp/lists/partial/missing.xz', '/tmp/lists/missing'));
    expect(new Uint8Array(await fs.readFile('/tmp/lists/d_Packages.gz') as Uint8Array)).toEqual(gz);
    expect(out).toMatch(/400 URI Failure\nURI: store:\/tmp\/lists\/partial\/missing\.xz\nMessage: /);
  });

  it('refuses a destination in a format it cannot write (.lz4) instead of storing plain data under that name', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/lists/partial', { recursive: true });
    await fs.writeFile('/tmp/lists/partial/e_Packages.gz', new Uint8Array(gzipSync(text)));
    const out = await runStore(fs, acquire('/tmp/lists/partial/e_Packages.gz', '/tmp/lists/e_Packages.lz4'));
    expect(out).toMatch(/400 URI Failure\n.*\nMessage: shiro-apt-store: compressing to \/tmp\/lists\/e_Packages\.lz4 is not supported/);
    expect(await fs.exists('/tmp/lists/e_Packages.lz4')).toBe(false);
  });
});
