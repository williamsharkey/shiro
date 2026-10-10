import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FileSystem } from '@shiro/filesystem';
import { aptStoreProgram } from '@shiro/debian/apt-store';
import { aptMethodProgram } from '@shiro/debian/apt-method';

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
  // A list the size of trixie's (tens of MB): decoded and hashed a piece at a time, stored as blocks
  const big = (() => {
    let t = '', i = 0;
    while (t.length < (6 << 20)) t += `Package: synth-${i}\nVersion: 1.${i % 97}-1\nDescription: package number ${i++} of a big list\n\n`;
    return new TextEncoder().encode(t);
  })();
  const hashOf = (alg: string, b: Uint8Array) => createHash(alg).update(b).digest('hex');
  const expectHashes = (msg: string, b: Uint8Array) => {
    expect(msg).toContain(`Size: ${b.length}`);
    expect(msg).toContain(`MD5Sum-Hash: ${hashOf('md5', b)}`);
    expect(msg).toContain(`SHA1-Hash: ${hashOf('sha1', b)}`);
    expect(msg).toContain(`SHA256-Hash: ${hashOf('sha256', b)}`);
    expect(msg).toContain(`SHA512-Hash: ${hashOf('sha512', b)}`);
  };
  const haveXz = (() => { try { execFileSync('xz', ['--version']); return true; } catch { return false; } })();

  it.skipIf(!haveXz)('streams a big .xz, .gz and a filtered .xz into block-stored lists with the right hashes', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/biglists/partial', { recursive: true });
    await fs.writeFile('/tmp/biglists/partial/x_Packages.xz', new Uint8Array(execFileSync('xz', ['-c', '-6'], { input: big, maxBuffer: 1 << 30 })));
    await fs.writeFile('/tmp/biglists/partial/g_Packages.gz', new Uint8Array(gzipSync(Buffer.from(big))));
    await fs.writeFile('/tmp/biglists/partial/f_Packages.xz', new Uint8Array(execFileSync('xz', ['-c', '--x86', '--lzma2=preset=1'], { input: big, maxBuffer: 1 << 30 })));
    const writeFile = fs.writeFile.bind(fs);
    const whole: string[] = [];
    (fs as any).writeFile = (p: string, d: any, o: any) => { if ((d?.length ?? 0) >= FileSystem.BLOB_MIN) whole.push(p); return writeFile(p, d, o); };
    const out = await runStore(fs, acquire('/tmp/biglists/partial/x_Packages.xz', '/tmp/biglists/x_Packages')
      + acquire('/tmp/biglists/partial/g_Packages.gz', '/tmp/biglists/g_Packages')
      + acquire('/tmp/biglists/partial/f_Packages.xz', '/tmp/biglists/f_Packages'));
    const done = out.split('\n\n').filter((m) => m.startsWith('201 URI Done'));
    expect(done).toHaveLength(3);
    for (const m of done) expectHashes(m, big);
    expect(whole).toEqual([]); // never written as one buffer
    for (const n of ['x', 'g', 'f']) {
      expect(fs.blobOf(`/tmp/biglists/${n}_Packages`)).toBeTruthy();
      expect(Buffer.from(await fs.readFile(`/tmp/biglists/${n}_Packages`) as Uint8Array).equals(Buffer.from(big))).toBe(true);
    }
  }, 60_000);

  it('the http method streams a download into the file and hashes it; a 304 hashes the file it has', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/dl/partial', { recursive: true });
    const realFetch = globalThis.fetch;
    let mode: 'ok' | '304' = 'ok';
    (globalThis as any).fetch = async (url: string) => {
      expect(url).toBe('http://mirror.test/debian/mirror/deb.debian.org/debian/dists/trixie/main/binary-amd64/Packages');
      if (mode === '304') return new Response(null, { status: 304 });
      // In pieces, as the network delivers it
      const body = new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 65536) c.enqueue(big.slice(i, i + 65536)); c.close(); } });
      return new Response(body, { status: 200, headers: { 'last-modified': 'Sat, 10 Oct 2026 00:00:00 GMT' } });
    };
    try {
      const run = async () => {
        let pending = new TextEncoder().encode('601 Configuration\nConfig-Item: Acquire::Shiro::Mirror=http%3a//mirror.test/debian/mirror/\n\n'
          + '600 URI Acquire\nURI: http://deb.debian.org/debian/dists/trixie/main/binary-amd64/Packages\nFilename: /tmp/dl/partial/P\n\n');
        const stdin = { tryRead(buf: Uint8Array) { const n = Math.min(buf.length, pending.length); buf.set(pending.subarray(0, n)); pending = pending.subarray(n); return n; } };
        let out = '';
        const kernel: any = { fs, writeAll: async (_p: unknown, _fd: number, b: Uint8Array) => { out += new TextDecoder().decode(b); } };
        expect(await aptMethodProgram({ fds: new Map([[0, stdin]]), env: {} } as any, kernel)).toBe(0);
        return out;
      };
      const out = await run();
      const done = out.split('\n\n').find((m) => m.startsWith('201 URI Done'))!;
      expect(done).toBeTruthy();
      expectHashes(done, big);
      expect(done).toContain('Last-Modified: Sat, 10 Oct 2026 00:00:00 GMT');
      expect(fs.blobOf('/tmp/dl/partial/P')).toBeTruthy();
      expect(Buffer.from(await fs.readFile('/tmp/dl/partial/P') as Uint8Array).equals(Buffer.from(big))).toBe(true);
      await fs.sync();
      fs.sweepContent(Date.now() + FileSystem.CONTENT_IDLE_MS + 1); // the file's bytes leave memory: the 304 reads its blocks
      mode = '304';
      const ims = (await run()).split('\n\n').find((m) => m.startsWith('201 URI Done'))!;
      expect(ims).toContain('IMS-Hit: true');
      expectHashes(ims, big);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 60_000);
});
