/**
 * Dock icon sets (src/desktop/iconsets.ts, docs/DESKTOP.md "Icon sets"): the
 * default, persistence, glyph coverage, the shared tile markup, and that the
 * live sets' code (WebGL, three.js) is reachable only through dynamic imports.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ICON_SET, ICON_SETS, ICON_SET_KEY, appIconIn, glyphFor, glyphTile, iconSet, monogram, savedIconSet, saveIconSet,
} from '@shiro/desktop/iconsets';

if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
  };
}

const src = (p: string) => readFileSync(new URL(`../../../src/${p}`, import.meta.url), 'utf8');

describe('icon sets', () => {
  beforeEach(() => { localStorage.removeItem(ICON_SET_KEY); localStorage.removeItem('shiro-desktop-iconset'); });

  it('defaults to Drafting and lists the 12 studies plus Classic', () => {
    expect(DEFAULT_ICON_SET).toBe('drafting');
    expect(savedIconSet()).toBe('drafting');
    expect(ICON_SETS[0].id).toBe('drafting');
    expect(ICON_SETS.map(s => s.id).sort()).toEqual(
      ['aurora', 'brutal', 'classic', 'clay', 'drafting', 'foil', 'glass', 'paper', 'pearl', 'pixel', 'riso', 'swiss', 'vapor']);
    expect(ICON_SETS.filter(s => s.kind === 'live').map(s => s.id).sort()).toEqual(['foil', 'glass', 'pearl']);
    expect(ICON_SETS.filter(s => s.kind === 'static')).toHaveLength(9);
  });

  it('persists the choice; unknown values fall back to the default', () => {
    saveIconSet('riso');
    expect(savedIconSet()).toBe('riso');
    expect(localStorage.getItem(ICON_SET_KEY)).toBe('riso');
    localStorage.setItem(ICON_SET_KEY, 'nonsense');
    expect(savedIconSet()).toBe('drafting');
    expect(iconSet('glass').kind).toBe('live');
    // a choice saved before the rename still counts
    localStorage.removeItem(ICON_SET_KEY);
    localStorage.setItem('shiro-desktop-iconset', 'paper');
    expect(savedIconSet()).toBe('paper');
    localStorage.removeItem('shiro-desktop-iconset');
  });

  it('every app in the dock and launcher has a glyph', () => {
    const apps = [
      'terminal', 'files', 'settings', 'activity', 'browser', 'about', 'apps',
      'vim', 'htop', 'python3', 'neovim', 'emacs', 'nano', 'tmux', 'lua', 'sqlite',
      // Debian GUI apps (src/gui/desktop-apps.ts)
      'l3afpad', 'mousepad', 'featherpad', 'ristretto', 'gpicview', 'gimp', 'inkscape',
      'dillo', 'netsurf', 'xterm', 'xeyes', 'xclock', 'xcalc', 'xedit', 'lximage-qt',
    ];
    for (const id of apps) expect(glyphFor(id), id).toMatch(/^M[\d.]/);
    // the mockup's ten, kept as drawn
    expect(glyphFor('terminal')).toBe('M5.5 7.5l4.5 4.5-4.5 4.5M12.5 16.5h6');
    expect(glyphFor('gimp')).toBe(glyphFor('paint'));
    expect(glyphFor('no-such-app')).toBeNull();
  });

  it('apps without a glyph get a monogram in the set', () => {
    expect(monogram('Mousepad')).toBe('Mo');
    expect(monogram('Sky Chart')).toBe('SC');
    expect(monogram('x')).toBe('X');
    const t = glyphTile('some-app', 'Some App');
    expect(t).toContain('<text class="sd-ic-m"');
    expect(t).toContain('>SA</text>');
  });

  it('one tile markup for every non-classic set; Classic keeps the app icon', () => {
    const tile = glyphTile('files', 'Files', 3);
    expect(tile).toMatch(/^<span class="sd-ic" data-glyph="files" data-k="0" style="--i:3">/);
    expect(tile).toContain('class="sd-ic-c"'); // construction lines (shown by Drafting)
    for (const s of ICON_SETS.filter(s => s.kind !== 'classic')) expect(appIconIn(s.id, 'files', 'Files', '<svg id="x"/>', 3)).toBe(tile);
    expect(appIconIn('classic', 'files', 'Files', '<svg id="x"/>')).toBe('<svg id="x"/>');
    expect(appIconIn('classic', 'gimp', 'GIMP', 'gui/icons/gimp.png')).toBe('<img src="gui/icons/gimp.png" alt="">');
  });

  it('the live sets are only dynamic imports (nothing loads them with a static set)', () => {
    const staticImport = /^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm;
    for (const f of ['desktop/index.ts', 'desktop/iconsets.ts', 'desktop/apps/settings.ts', 'desktop/spotlight.ts', 'main.ts']) {
      const deps = [...src(f).matchAll(staticImport)].filter(m => !/^\s*import\s+type\b/.test(m[0])).map(m => m[1]);
      expect(deps.filter(d => /iconset-gl|iconset-glass|^three/.test(d)), f).toEqual([]);
    }
    expect(src('desktop/iconsets.ts')).toContain("import('./iconset-glass')");
    expect(src('desktop/iconsets.ts')).toContain("import('./iconset-gl')");
    // three.js stays out of every chunk but its own (vite.config.ts)
    expect(readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')).toMatch(/node_modules\/three\/'\) \? 'three'/);
  });

  it('every set has CSS for both themes, and swaps keep the tile box', () => {
    const css = src('desktop/iconsets.css');
    for (const s of ICON_SETS.filter(s => s.kind !== 'classic')) expect(css, s.id).toContain(`[data-iconset='${s.id}']`);
    // .sd-ic has Classic's .sd-tile box (desktop.css): no set changes layout
    expect(css).toMatch(/\.sd-ic \{[^}]*width: 90\.6%; height: 90\.6%; margin: 4\.7%;/);
    expect(src('desktop/desktop.css')).toMatch(/\.sd-tile \{[^}]*width: 90\.6%; height: 90\.6%; margin: 4\.7%;/);
  });
});

describe('AppDescriptor.glyph', () => {
  it('an app can bring its own glyph (also for One-bit and Liquid glass, which draw from glyphFor)', async () => {
    const { setAppGlyph } = await import('@shiro/desktop/iconsets');
    expect(glyphFor('my-app')).toBeNull();
    setAppGlyph('my-app', 'M4 4h16v16H4z');
    expect(glyphFor('my-app')).toBe('M4 4h16v16H4z');
    expect(glyphTile('my-app', 'My App')).toContain('d="M4 4h16v16H4z"');
    setAppGlyph('my-app', undefined);
    expect(glyphFor('my-app')).toBeNull();
  });
});
