import { describe, it, expect, afterEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';

// Idle clean file content leaves memory (FileSystem "Content cache").
describe('FileSystem content cache', () => {
  const budget = FileSystem.CONTENT_BUDGET;
  afterEach(() => { FileSystem.CONTENT_BUDGET = budget; });
  const later = () => Date.now() + FileSystem.CONTENT_IDLE_MS + 1;
  const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);

  it('drops a big clean file once idle and reads it back from IndexedDB', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.writeFile('/tmp/big.bin', bytes(9 << 20, 7));
    expect(fs.sweepContent(later())).toBe(0); // not committed yet
    await fs.sync();
    expect(fs.sweepContent(Date.now())).toBe(0); // used just now
    expect(fs.sweepContent(later())).toBe(9 << 20);
    expect(fs.contentCacheBytes).toBe(0);
    expect(fs.readBytesCached('/tmp/big.bin')).toBeUndefined();
    expect((await fs.stat('/tmp/big.bin')).size).toBe(9 << 20);
    const back = (await fs.readFile('/tmp/big.bin')) as Uint8Array;
    expect(back.length).toBe(9 << 20);
    expect(back[12345]).toBe(7);
    expect(fs.readBytesCached('/tmp/big.bin')?.length).toBe(9 << 20);
  });

  it('keeps pinned (open) files, and small ones within the budget', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.writeFile('/tmp/open.bin', bytes(9 << 20, 1));
    await fs.writeFile('/tmp/small.bin', bytes(100 << 10, 2));
    await fs.sync();
    const unpin = fs.addContentPin((p) => p === '/tmp/open.bin');
    expect(fs.sweepContent(later())).toBe(0);
    unpin();
    expect(fs.sweepContent(later())).toBe(9 << 20);
    expect(fs.readBytesCached('/tmp/small.bin')?.length).toBe(100 << 10);
  });

  it('beyond the budget drops the least recently used first', async () => {
    FileSystem.CONTENT_BUDGET = 250 << 10;
    const fs = new FileSystem();
    await fs.init();
    for (const n of ['a', 'b', 'c', 'd']) await fs.writeFile(`/tmp/lru-${n}`, bytes(100 << 10, 3));
    await fs.sync();
    fs.readBytesCached('/tmp/lru-a'); // a is now the most recently used
    expect(fs.sweepContent(later())).toBe(200 << 10); // b and c go, 200 KiB left
    expect(fs.readBytesCached('/tmp/lru-b')).toBeUndefined();
    expect(fs.readBytesCached('/tmp/lru-c')).toBeUndefined();
    expect(fs.readBytesCached('/tmp/lru-d')).toBeDefined();
    expect(fs.readBytesCached('/tmp/lru-a')).toBeDefined();
    expect(((await fs.readFile('/tmp/lru-b')) as Uint8Array).length).toBe(100 << 10);
  });
});
