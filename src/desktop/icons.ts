/**
 * The desktop's icons: original artwork, inline SVG (no requests).
 * App icons are 64x64 tiles; status icons are 16x16 and use currentColor.
 */

// The tile (gradient, shine, hairline border) is CSS on .sd-tile; the SVG holds
// only the glyph, so a dock icon is a handful of DOM nodes instead of a dozen
const tile = (_id: string, from: string, to: string, inner: string) =>
  `<span class="sd-tile" style="--t1:${from};--t2:${to}"><svg viewBox="3 3 58 58" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg></span>`;

const mono = (text: string, size: number, color: string, y = 40) =>
  `<text x="32" y="${y}" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-weight="700" font-size="${size}" fill="${color}">${text}</text>`;

export const ICONS: Record<string, string> = {
  terminal: tile('term', '#3a3f4f', '#12141b',
    `<path d="M17 23l10 9-10 9" fill="none" stroke="#7ef0c1" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M31 42h15" stroke="#e8ecf5" stroke-width="4.5" stroke-linecap="round"/>`),
  files: tile('files', '#6cc4ff', '#2563d9',
    `<path d="M13 22a4 4 0 0 1 4-4h9l4 4h17a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4z" fill="#eaf4ff"/>` +
    `<path d="M13 28h38v16a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4z" fill="#fff"/>` +
    `<path d="M21 36h22" stroke="#9cc4f5" stroke-width="2.5" stroke-linecap="round"/>`),
  settings: tile('set', '#a7afbf', '#596274',
    `<circle cx="32" cy="32" r="14" fill="none" stroke="#eef1f6" stroke-width="8" stroke-dasharray="5.5 5.5"/>` +
    `<circle cx="32" cy="32" r="11" fill="#eef1f6"/><circle cx="32" cy="32" r="5" fill="#6c7586"/>`),
  activity: tile('act', '#28313f', '#0d1117',
    `<path d="M10 36h10l5-12 7 22 6-16 4 6h12" fill="none" stroke="#59f0a8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`),
  about: tile('about', '#8a7dff', '#4b3bd6',
    `<path d="M11 45h6V25a5 5 0 0 1 5-5h20a5 5 0 0 1 5 5v20h6" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M25 30l5 4-5 4" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="33" y="36" width="7" height="3" rx="1.5" fill="#fff"/>`),
  vim: tile('vim', '#2fb46a', '#0d6436', mono('vi', 24, '#ffffff', 41)),
  htop: tile('htop', '#2a2f3b', '#0f1218',
    `<rect x="13" y="19" width="30" height="5" rx="2.5" fill="#5be08e"/>` +
    `<rect x="13" y="29" width="38" height="5" rx="2.5" fill="#ffd25e"/>` +
    `<rect x="13" y="39" width="20" height="5" rx="2.5" fill="#ff7a7a"/>`),
  python3: tile('py', '#3d7ccf', '#21497f', mono('py', 22, '#ffe27a', 40)),
  emacs: tile('emacs', '#8d5fd3', '#4c2b8a', mono('e', 30, '#fff', 42)),
  neovim: tile('nvim', '#5fae54', '#2a6b3e', mono('nv', 22, '#e9fff0', 40)),
  nano: tile('nano', '#4d5566', '#232833', mono('na', 22, '#e6eaf2', 40)),
  lua: tile('lua', '#3448a8', '#1b2563', mono('lua', 18, '#fff', 39)),
  sqlite: tile('sqlite', '#4a8fd0', '#1f4d80', mono('sql', 17, '#fff', 39)),
  tmux: tile('tmux', '#3c4250', '#15181f',
    `<rect x="14" y="17" width="36" height="30" rx="4" fill="none" stroke="#7ef0c1" stroke-width="3"/>` +
    `<path d="M32 17v30M32 32h18" stroke="#7ef0c1" stroke-width="3"/>`),
  package: tile('pkg', '#f2b45c', '#c26a1c',
    `<path d="M32 14l16 8v20l-16 8-16-8V22z" fill="#fff4e0"/><path d="M16 22l16 8 16-8M32 30v20" fill="none" stroke="#d9893a" stroke-width="2.5"/>`),
  // A browser tab with a prompt in it: tabcomputer
  logo: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1.5 19.5h3V8a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v11.5h3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 10.5l2.6 2.2L9 14.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="13" y="14" width="3.4" height="1.9" rx=".9" fill="currentColor"/></svg>`,
};

/** 16px status glyphs (currentColor) */
export const GLYPHS = {
  /** The network: a globe (the status dot is CSS, .sd-net-dot) */
  net: `<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.2"/><ellipse cx="8" cy="8" rx="2.6" ry="6.2"/><path d="M2 8h12M3 4.8h10M3 11.2h10" stroke-width="1.1"/></g></svg>`,
  keyboard: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.2" y="3.6" width="13.6" height="8.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 6.6h.01M6.7 6.6h.01M9.3 6.6h.01M12 6.6h.01M4 9.4h.01M12 9.4h.01" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M6 9.4h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  sun: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></g></svg>`,
  moon: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6 10.4A6 6 0 0 1 5.6 2.4a6 6 0 1 0 8 8z" fill="currentColor"/></svg>`,
  plus: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  x: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  folder: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4a1.2 1.2 0 0 1 1.2-1.2h3.2l1.4 1.4h6a1.2 1.2 0 0 1 1.2 1.2v7a1.2 1.2 0 0 1-1.2 1.2H2.7A1.2 1.2 0 0 1 1.5 12.4z" fill="currentColor"/></svg>`,
  file: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  link: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  search: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.4 10.4l3.6 3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  clock: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  terminalSmall: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6.5l2 1.6-2 1.6M8 10.5h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  back: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  up: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  key: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 8h6.5M12 8v2.5M14.5 8v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
};

/** An app icon by id, falling back to the package tile. */
export function appIcon(id: string): string {
  return ICONS[id] ?? ICONS.package;
}
