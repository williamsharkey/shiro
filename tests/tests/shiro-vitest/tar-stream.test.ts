/** extractTarGzFiles: the files a predicate picks from a .tar.gz as it streams in (utils/tar-utils.ts) */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractTarGzFiles, extractTarGz } from '@shiro/utils/tar-utils';

describe('extractTarGzFiles', () => {
  it('keeps the picked files whole (one larger than many chunks), skips the rest, from bytes or a stream', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tar-stream-'));
    try {
      mkdirSync(path.join(dir, 'package/vendor/x64'), { recursive: true });
      const big = new Uint8Array(3_000_001).map((_, i) => (i * 7 + 3) & 255);
      writeFileSync(path.join(dir, 'package/cli.js'), big);
      writeFileSync(path.join(dir, 'package/package.json'), '{"name":"p"}');
      writeFileSync(path.join(dir, 'package/empty.txt'), '');
      writeFileSync(path.join(dir, 'package/vendor/x64/rg'), new Uint8Array(2_000_000).fill(9));
      execFileSync('tar', ['czf', 'p.tgz', 'package'], { cwd: dir });
      const tgz = new Uint8Array(readFileSync(path.join(dir, 'p.tgz')));
      const want = (n: string) => ['cli.js', 'package.json', 'empty.txt'].includes(n);
      for (const source of [tgz, new Response(new Blob([tgz])).body!]) {
        const got = await extractTarGzFiles(source as any, want);
        expect(got.map((e) => e.name).sort()).toEqual(['cli.js', 'empty.txt', 'package.json']);
        const cli = got.find((e) => e.name === 'cli.js')!;
        expect(cli.data!.length).toBe(big.length);
        expect(Buffer.from(cli.data!).equals(Buffer.from(big))).toBe(true);
        expect(new TextDecoder().decode(got.find((e) => e.name === 'package.json')!.data)).toBe('{"name":"p"}');
        expect(got.find((e) => e.name === 'empty.txt')!.data!.length).toBe(0);
      }
      // the same files as the whole-archive extractor
      const all = await extractTarGz(tgz);
      expect(Buffer.from(all.find((e) => e.name === 'cli.js')!.data!).equals(Buffer.from(big))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
