import { describe, it, expect } from 'vitest';
import { buildIconCache, lookupIcon, iconNameHash } from '@shiro/gui/icon-cache';

describe('GTK icon-theme.cache (gui/icon-cache.ts)', () => {
  it('hashes names like GTK (signed chars)', () => {
    expect(iconNameHash('')).toBe(0);
    expect(iconNameHash('a')).toBe(97);
    expect(iconNameHash('ab')).toBe(97 * 31 + 98);
    // a byte >= 0x80 counts as negative, as with GTK's signed char
    expect(iconNameHash('é')).toBe((((0xc3 << 24) >> 24) * 31 + ((0xa9 << 24) >> 24)) >>> 0);
  });

  it('finds each icon in its directories with its suffixes', () => {
    const cache = buildIconCache([
      'index.theme',
      '48x48/apps/gimp.png', '48x48/apps/gimp.svg', 'scalable/apps/gimp.svg',
      '16x16/actions/edit-copy.png', '16x16/actions/README',
    ]);
    const dv = new DataView(cache.buffer);
    expect([dv.getUint16(0), dv.getUint16(2)]).toEqual([1, 0]);
    const sorted = (l: { dir: string; flags: number }[]) => l.map((x) => `${x.dir}:${x.flags}`).sort();
    expect(sorted(lookupIcon(cache, 'gimp'))).toEqual(['48x48/apps:6', 'scalable/apps:2']);
    expect(sorted(lookupIcon(cache, 'edit-copy'))).toEqual(['16x16/actions:4']);
    expect(lookupIcon(cache, 'README')).toEqual([]);
    expect(lookupIcon(cache, 'missing')).toEqual([]);
  });

  it('keeps every name findable when buckets chain', () => {
    const files = Array.from({ length: 300 }, (_, i) => `${16 + (i % 3) * 8}x${16 + (i % 3) * 8}/apps/icon-${i}.png`);
    const cache = buildIconCache(files);
    for (let i = 0; i < 300; i++) expect(lookupIcon(cache, `icon-${i}`)).toHaveLength(1);
  });
});
