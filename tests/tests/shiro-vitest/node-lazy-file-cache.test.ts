import { describe, it, expect } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { LazyTextMap } from '@shiro/node-compat/file-cache';
import { preloadDir } from '@shiro/node-compat/preload';

// node in the page: preloaded files are decoded when read, from the
// FileSystem's cache, whose bytes stay pinned while the map is alive.
describe('LazyTextMap (node in the page)', () => {
  const later = () => Date.now() + FileSystem.CONTENT_IDLE_MS + 1;

  async function tree() {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/lz/node_modules/pkg', { recursive: true });
    await fs.writeFile('/tmp/lz/node_modules/pkg/index.js', 'module.exports = 1;\n');
    await fs.writeFile('/tmp/lz/node_modules/pkg/big.js', 'x'.repeat(9 << 20)); // evictable size
    await fs.writeFile('/tmp/lz/node_modules/pkg/bin.dat', new Uint8Array([0xff, 0xfe, 0x00, 0xc3]));
    await fs.writeFile('/tmp/lz/main.js', 'require("pkg")\n');
    await fs.sync();
    return fs;
  }

  it('holds preloaded files undecoded and reads them on demand', async () => {
    const fs = await tree();
    const cache = new LazyTextMap(fs);
    await preloadDir({ fs } as any, cache, new Map(), '/tmp/lz');
    expect(cache.isLazy('/tmp/lz/node_modules/pkg/index.js')).toBe(true);
    expect(cache.has('/tmp/lz/node_modules/pkg/bin.dat')).toBe(false); // binary stays out, as before
    expect(cache.get('/tmp/lz/node_modules/pkg/index.js')).toBe('module.exports = 1;\n');
    expect(cache.isLazy('/tmp/lz/node_modules/pkg/index.js')).toBe(false);
    expect([...cache.keys()].sort()).toEqual(['/tmp/lz/main.js', '/tmp/lz/node_modules/pkg/big.js', '/tmp/lz/node_modules/pkg/index.js']);
    expect(new Map(cache).get('/tmp/lz/main.js')).toBe('require("pkg")\n');
  });

  it('pins the bytes of files not yet read, and lets them go once read', async () => {
    const fs = await tree();
    const cache = new LazyTextMap(fs);
    await preloadDir({ fs } as any, cache, new Map(), '/tmp/lz');
    expect(fs.sweepContent(later())).toBe(0); // big.js is pinned
    expect(cache.get('/tmp/lz/node_modules/pkg/big.js')?.length).toBe(9 << 20);
    expect(fs.sweepContent(later())).toBe(9 << 20);
  });

  it('sees a file changed or deleted since the preload', async () => {
    const fs = await tree();
    const cache = new LazyTextMap(fs);
    await preloadDir({ fs } as any, cache, new Map(), '/tmp/lz');
    await fs.writeFile('/tmp/lz/main.js', 'changed\n');
    expect(cache.get('/tmp/lz/main.js')).toBe('changed\n');
    await fs.unlink('/tmp/lz/node_modules/pkg/index.js');
    expect(cache.has('/tmp/lz/node_modules/pkg/index.js')).toBe(false);
    expect(cache.get('/tmp/lz/node_modules/pkg/index.js')).toBeUndefined();
  });
});
