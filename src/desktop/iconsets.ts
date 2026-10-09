/**
 * Dock icon sets (docs/DESKTOP.md "Icon sets"; design: docs/design/dock-icon-studies.html
 * on design/dock-icons). Every set draws the same glyphs from one geometry, a
 * 24-unit grid with round strokes, so the apps belong together; a set changes
 * only the material. "Classic" keeps the colorful tiles of icons.ts.
 *
 * Static sets are markup + CSS: one glyph tile (`.sd-ic`) per app, styled by
 * the `data-iconset` attribute of the nearest container (the dock, a stack, the
 * launcher, a Settings card). Switching between them is one attribute change.
 * The live sets (Pearl, Holo foil, Liquid glass) draw tile backgrounds with
 * WebGL from their own chunks (iconset-gl.ts, iconset-glass.ts), loaded only
 * while one of them is chosen; until then and in previews they show a still.
 */

import { appIcon } from './icons';

export type IconSetId =
  | 'drafting' | 'classic' | 'pearl' | 'glass' | 'foil' | 'vapor' | 'aurora'
  | 'clay' | 'swiss' | 'brutal' | 'riso' | 'pixel' | 'paper';

export interface IconSet {
  id: IconSetId;
  name: string;
  /** 'live': WebGL, rendered by a lazily loaded engine; previews use a still */
  kind: 'classic' | 'static' | 'live';
  blurb: string;
}

export const ICON_SETS: IconSet[] = [
  { id: 'drafting', name: 'Drafting', kind: 'static', blurb: 'Graphite on vellum, chalk on slate.' },
  { id: 'classic', name: 'Classic', kind: 'classic', blurb: 'The original colorful tiles.' },
  { id: 'pearl', name: 'Pearl', kind: 'live', blurb: 'Nacre with slow streams of color.' },
  { id: 'glass', name: 'Liquid glass', kind: 'live', blurb: 'Glass blocks that refract and lean toward the pointer.' },
  { id: 'foil', name: 'Holo foil', kind: 'live', blurb: 'Brushed silver with thin-film color.' },
  { id: 'vapor', name: 'Vaporwave', kind: 'static', blurb: 'Sunset gradients and a horizon grid.' },
  { id: 'aurora', name: 'Aurora field', kind: 'static', blurb: 'One sky under the whole dock.' },
  { id: 'clay', name: 'Soft clay', kind: 'static', blurb: 'Matte, pillowy tiles from one hue arc.' },
  { id: 'swiss', name: 'Swiss line', kind: 'static', blurb: 'Neutral tiles, one hairline weight.' },
  { id: 'brutal', name: 'Neo-brutalist', kind: 'static', blurb: 'Flat inks, heavy outlines, hard shadows.' },
  { id: 'riso', name: 'Risograph', kind: 'static', blurb: 'Two inks a hair out of register.' },
  { id: 'pixel', name: 'One-bit', kind: 'static', blurb: 'Glyphs on a 16-pixel grid.' },
  { id: 'paper', name: 'E-ink paper', kind: 'static', blurb: 'Ink pressed into warm gray paper.' },
];

export const DEFAULT_ICON_SET: IconSetId = 'drafting';
export const ICON_SET_KEY = 'shiro-desktop-iconset';

export function iconSet(id: string | null | undefined): IconSet {
  return ICON_SETS.find(s => s.id === id) ?? ICON_SETS[0];
}

export function savedIconSet(): IconSetId {
  try { return iconSet(localStorage.getItem(ICON_SET_KEY)).id; } catch { return DEFAULT_ICON_SET; }
}

export function saveIconSet(id: IconSetId): void {
  try { localStorage.setItem(ICON_SET_KEY, id); } catch {}
}

// ── Glyphs: 24-unit grid, round joins, one stroke weight (set by the material) ──

/** A full circle as path data (so every glyph is one `d`, for Path2D too) */
const circ = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
/** A dot: a zero-length segment, round-capped by the stroke */
const dot = (x: number, y: number) => `M${x} ${y}h.01`;

const G = {
  // The ten of the mockup
  terminal: 'M5.5 7.5l4.5 4.5-4.5 4.5M12.5 16.5h6',
  files: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  browser: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18',
  code: 'M8.5 4.5c-2 0-2.8 1-2.8 3v1.6c0 1.5-.8 2.6-2.2 2.9 1.4.3 2.2 1.4 2.2 2.9v1.6c0 2 .8 3 2.8 3M15.5 4.5c2 0 2.8 1 2.8 3v1.6c0 1.5.8 2.6 2.2 2.9-1.4.3-2.2 1.4-2.2 2.9v1.6c0 2-.8 3-2.8 3',
  activity: 'M3 12.5h4l2.5-6 4 11 2.5-5H21',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M5.6 18.4l1.9-1.9M16.5 7.5l1.9-1.9',
  paint: 'M14.5 4.5l5 5-7.5 7.5H7v-5zM4 20l3-3',
  vector: 'M12 3.5l5.5 8.5L12 20.5 6.5 12zM12 3.5v7M12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 1 0 0 2.4',
  agents: 'M12 3.5l1.9 6.1 6.1 2.4-6.1 2.4L12 20.5l-1.9-6.1L4 12l6.1-2.4z',
  music: 'M9 17.5V6l10-2v11.5M9 17.5a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 1 1 4.6 0zM19 15.5a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 1 1 4.6 0z',
  // The rest of the dock, on the same rules
  /** The otter (tabcomputer's mark) on the 24 grid: a rounded tab, eyes, nose, whiskers */
  about: 'M1.5 18h2.8v-6.4a5.6 5.6 0 0 1 5.6-5.6h4.2a5.6 5.6 0 0 1 5.6 5.6V18h2.8' + dot(9.3, 11.8) + dot(14.7, 11.8) + 'M11.3 13.9h1.4M9.4 14.6l-2.6.5M14.6 14.6l2.6.5',
  vim: 'M3.5 5.5h6M14.5 5.5h6M6.5 5.5L12 18.5l5.5-13',
  htop: 'M4 19.5h16M6.5 16v-5M10.5 16V6.5M14.5 16v-6.5M18.5 16V9',
  python3: 'M4.5 8l3.5 4-3.5 4M10 8l3.5 4-3.5 4M15.5 8l3.5 4-3.5 4',
  apps: 'M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z',
  neovim: 'M6 18.5v-13l12 13v-13',
  emacs: 'M6.5 12.5h11a5.5 5.5 0 1 0-1.7 4',
  nano: 'M5 7h14M5 12h14M5 17h9',
  tmux: 'M4 5.5h16v13H4zM12 5.5v13M12 12h8',
  lua: circ(11, 13, 6.5) + circ(18.5, 5.5, 1.7),
  sqlite: 'M5 6.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5-7-1.1-7-2.5zM5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5',
  editor: 'M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12h6M9 15.5h6',
  image: 'M3.5 5.5h17v13h-17zM3.5 15.5l5-4.5 4 3.5 3-2.5 5 4' + circ(15.5, 9, 1.3),
  clock: circ(12, 12, 8.5) + 'M12 7.5V12l3 2',
  calc: 'M6 3.5h12v17H6zM8.5 6.5h7v3h-7z' + dot(9, 13) + dot(12, 13) + dot(15, 13) + dot(9, 16.5) + dot(12, 16.5) + dot(15, 16.5),
  eyes: circ(8.5, 12, 4.5) + circ(15.5, 12, 4.5) + dot(9.5, 12.5) + dot(16.5, 12.5),
};

/** App id → glyph. Debian GUI apps (src/gui/desktop-apps.ts) map onto what they are. */
const APP_GLYPH: Record<string, string> = {
  ...G,
  gimp: G.paint, inkscape: G.vector,
  dillo: G.browser, netsurf: G.browser,
  xterm: G.terminal,
  l3afpad: G.editor, mousepad: G.editor, featherpad: G.editor, xedit: G.editor,
  ristretto: G.image, gpicview: G.image, 'lximage-qt': G.image,
  xclock: G.clock, xcalc: G.calc, xeyes: G.eyes,
};

/** Glyphs apps registered with (AppDescriptor.glyph), ahead of the built-in ones */
const registered = new Map<string, string>();
export function setAppGlyph(appId: string, d: string | undefined): void {
  if (d) registered.set(appId, d); else registered.delete(appId);
}

/** The glyph for an app, or null: it then gets a monogram in the set's style */
export function glyphFor(appId: string): string | null {
  return registered.get(appId) ?? (Object.prototype.hasOwnProperty.call(APP_GLYPH, appId) ? APP_GLYPH[appId] : null);
}

/** One or two letters for an app without a glyph ("Mousepad" → "Mo") */
export function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0];
  return w[0].toUpperCase() + (w[1] ?? '').toLowerCase();
}

function escAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * A glyph tile: the same markup for every non-classic set (the set's CSS gives
 * the material). `i`: position in its row, for sets whose hue or backdrop runs
 * along the dock (the container sets `--n`, the row's length). Construction
 * lines are drawn only by Drafting.
 */
export function glyphTile(appId: string, name: string, i = 0, glyph?: string): string {
  const d = glyph ?? glyphFor(appId);
  const mark = d
    ? `<path class="sd-ic-g" d="${d}"/>`
    : `<text class="sd-ic-m" x="12" y="16.2" text-anchor="middle">${escAttr(monogram(name))}</text>`;
  return `<span class="sd-ic" data-glyph="${escAttr(appId)}" data-k="${i % 3}" style="--i:${i}"><svg viewBox="0 0 24 24" aria-hidden="true">` +
    `<path class="sd-ic-c" d="M1.5 12h21M12 1.5v21${circ(12, 12, 9.6)}"/>${mark}</svg></span>`;
}

/** The classic icon of an app: its registered icon (SVG markup or an image URL) */
export function classicIcon(appId: string, icon: string | undefined): string {
  return icon?.trim().startsWith('<') ? icon : icon ? `<img src="${escAttr(icon)}" alt="">` : appIcon(appId);
}

/** An app's icon in a set */
export function appIconIn(set: IconSetId, appId: string, name: string, icon: string | undefined, i = 0, glyph?: string): string {
  return set === 'classic' ? classicIcon(appId, icon) : glyphTile(appId, name, i, glyph);
}

// ── Shared SVG filters (Drafting's hand wobble, chalk), added once ──

let defsAdded = false;
export function ensureIconDefs(): void {
  if (defsAdded || typeof document === 'undefined') return;
  defsAdded = true;
  const host = document.createElement('div');
  host.innerHTML = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <filter id="sd-draft" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="0.9"/></filter>
    <filter id="sd-chalk" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="2.4" numOctaves="2" seed="7" result="t"/><feDisplacementMap in="SourceGraphic" in2="t" scale="1.1" result="d"/><feComposite in="d" in2="t" operator="in"/></filter>
    <linearGradient id="sd-chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".48" stop-color="#d9e4ff"/><stop offset=".52" stop-color="#7b6fd6"/><stop offset="1" stop-color="#ffd1f0"/></linearGradient>
    <linearGradient id="sd-chrome-dark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6ff"/><stop offset=".5" stop-color="#9ef0ff"/><stop offset=".52" stop-color="#ff6ad5"/><stop offset="1" stop-color="#ffe3a6"/></linearGradient>
  </defs></svg>`;
  document.body.appendChild(host.firstElementChild!);
}

// ── One-bit: glyphs rasterized onto 16×16, shown pixelated (computed only when chosen) ──

const pixelCache = new Map<string, string>();
/** A 16×16 PNG data URL of the app's glyph (or monogram), in `color` */
export function pixelGlyph(appId: string, name: string, color: string): string {
  const key = `${appId}|${name}|${color}`;
  const hit = pixelCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d');
  if (!x) return '';
  const d = glyphFor(appId);
  x.save();
  x.scale(16 / 24, 16 / 24);
  x.lineWidth = 2.3; x.lineCap = 'square'; x.lineJoin = 'miter';
  x.strokeStyle = '#000'; x.fillStyle = '#000';
  if (d) x.stroke(new Path2D(d));
  else { x.font = '700 13px monospace'; x.textAlign = 'center'; x.fillText(monogram(name), 12, 16.5); }
  x.restore();
  const img = x.getImageData(0, 0, 16, 16), p = img.data;
  const rgb = color.match(/[\da-f]{2}/gi)!.map(h => parseInt(h, 16));
  for (let k = 0; k < p.length; k += 4) {
    if (p[k + 3] > 110) { p[k] = rgb[0]; p[k + 1] = rgb[1]; p[k + 2] = rgb[2]; p[k + 3] = 255; } else p[k + 3] = 0;
  }
  x.putImageData(img, 0, 0);
  const url = c.toDataURL();
  pixelCache.set(key, url);
  return url;
}

/** One-bit ink per theme */
export const PIXEL_INK = { light: '#1d1d1d', dark: '#2cff7a' };

/** Give One-bit tiles their bitmaps (call after rendering tiles while One-bit is on) */
export function paintPixelTiles(root: ParentNode, theme: 'light' | 'dark', names: (appId: string) => string): void {
  for (const t of root.querySelectorAll<HTMLElement>('.sd-ic[data-glyph]')) {
    const id = t.dataset.glyph!;
    t.style.setProperty('--px', `url("${pixelGlyph(id, names(id), PIXEL_INK[theme])}")`);
  }
}

/** The engine of a live set: draws behind the dock's glyph tiles until disposed */
export interface LiveIconEngine {
  /** Build and draw the first frame for these apps off screen (before the crossfade) */
  prepare(apps: { id: string; name: string }[]): void;
  /** Draw into these tiles (re-called when the dock re-renders) */
  attach(tiles: HTMLElement[]): void;
  setTheme(theme: 'light' | 'dark'): void;
  /** Hold animation (the crossfade shows the prepared frame), then let it run */
  hold(on: boolean): void;
  /** Stop animating for good, keeping the last frame (before a crossfade away from it) */
  freeze(): void;
  /** Stop every loop and listener, release the GL context, remove its canvases */
  dispose(): void;
}

/** Load a live set's engine (its own chunk; three.js only for Liquid glass), shaders compiled */
export async function loadLiveEngine(id: IconSetId, dock: HTMLElement, theme: 'light' | 'dark'): Promise<LiveIconEngine | null> {
  if (id === 'glass') return (await import('./iconset-glass')).createGlassEngine(dock, theme);
  if (id === 'pearl' || id === 'foil') return (await import('./iconset-gl')).createShaderEngine(id === 'pearl' ? 0 : 1, dock, theme);
  return null;
}
