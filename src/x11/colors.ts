/** X color names (rgb.txt) and numeric color specs → 0xRRGGBB. */
import { RGB_TXT } from './colors-data';

let table: Map<string, number> | null = null;

export function lookupColor(spec: string): number | null {
  const s = spec.trim().toLowerCase();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 3 || hex.length > 12) return null;
    const n = hex.length / 3;
    const part = (i: number) => parseInt(hex.slice(i * n, i * n + n), 16) / (16 ** n - 1);
    return (Math.round(part(0) * 255) << 16) | (Math.round(part(1) * 255) << 8) | Math.round(part(2) * 255);
  }
  const m = /^rgbi?:([^/]+)\/([^/]+)\/([^/]+)$/.exec(s);
  if (m) {
    const f = s.startsWith('rgbi:')
      ? (v: string) => Math.round(Math.max(0, Math.min(1, parseFloat(v))) * 255)
      : (v: string) => Math.round(parseInt(v, 16) / (16 ** v.length - 1) * 255);
    const [r, g, b] = [f(m[1]), f(m[2]), f(m[3])];
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return (r << 16) | (g << 8) | b;
  }
  if (!table) {
    table = new Map();
    for (const pair of RGB_TXT.split(' ')) {
      const i = pair.lastIndexOf(':');
      table.set(pair.slice(0, i), parseInt(pair.slice(i + 1), 16));
    }
  }
  return table.get(s.replace(/\s+/g, '')) ?? null;
}
