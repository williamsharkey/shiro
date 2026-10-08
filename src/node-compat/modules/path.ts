import type { CommandContext } from '../../commands/index';

/** "a/./b/../c" → "a/c"; ".." past the start is kept only for relative paths. */
function normalizeString(p: string, allowAboveRoot: boolean): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (allowAboveRoot) out.push('..');
    } else out.push(seg);
  }
  return out.join('/');
}

/** node:path (posix), following Node's own algorithms: relative paths stay
 *  relative, dirname("a") is ".", join normalises "..", and so on. */
export function createPathModule(ctx: CommandContext): any {
  const normalize = (p: string): string => {
    if (p === '') return '.';
    const isAbs = p.startsWith('/');
    const trailing = p.endsWith('/');
    let r = normalizeString(p, !isAbs);
    if (!r) return isAbs ? '/' : trailing ? './' : '.';
    if (trailing) r += '/';
    return isAbs ? '/' + r : r;
  };
  const resolve = (...parts: string[]): string => {
    let resolved = '';
    let abs = false;
    for (let i = parts.length - 1; i >= -1 && !abs; i--) {
      const p = i >= 0 ? String(parts[i]) : (ctx.cwd || '/');
      if (!p) continue;
      resolved = resolved ? `${p}/${resolved}` : p;
      abs = p.startsWith('/');
    }
    const r = normalizeString(resolved, !abs);
    return abs ? '/' + r : r || '.';
  };
  const dirname = (p: string): string => {
    if (!p) return '.';
    const hasRoot = p.startsWith('/');
    let end = -1;
    let matchedSlash = true;
    for (let i = p.length - 1; i >= 1; i--) {
      if (p[i] === '/') {
        if (!matchedSlash) { end = i; break; }
      } else matchedSlash = false;
    }
    if (end === -1) return hasRoot ? '/' : '.';
    if (hasRoot && end === 1) return '//';
    return p.slice(0, end);
  };
  const basename = (p: string, ext?: string): string => {
    const trimmed = p.replace(/\/+$/, '');
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return ext && base !== ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  };
  const extname = (p: string): string => {
    const base = basename(p);
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || base === '..') return '';
    return base.slice(dot);
  };
  const pathMod: any = {
    sep: '/',
    delimiter: ':',
    normalize,
    resolve,
    dirname,
    basename,
    extname,
    join: (...parts: string[]) => {
      const joined = parts.filter(s => s !== '').join('/');
      return joined ? normalize(joined) : '.';
    },
    isAbsolute: (p: string) => p.startsWith('/'),
    relative: (from: string, to: string) => {
      const f = resolve(from);
      const t = resolve(to);
      if (f === t) return '';
      const fs = f.split('/').filter(Boolean);
      const ts = t.split('/').filter(Boolean);
      let i = 0;
      while (i < fs.length && i < ts.length && fs[i] === ts[i]) i++;
      return [...Array(fs.length - i).fill('..'), ...ts.slice(i)].join('/');
    },
    parse: (p: string) => {
      const root = p.startsWith('/') ? '/' : '';
      const base = basename(p);
      const ext = extname(p);
      const trimmed = p.replace(/\/+$/, '') || root;
      const dir = trimmed.includes('/') ? dirname(trimmed) : root;
      return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format: (obj: any) => {
      const dir = obj.dir || obj.root || '';
      const base = obj.base || `${obj.name || ''}${obj.ext ? (obj.ext.startsWith('.') ? obj.ext : '.' + obj.ext) : ''}`;
      if (!dir) return base;
      return dir === obj.root ? dir + base : `${dir}/${base}`;
    },
    toNamespacedPath: (p: string) => p,
  };
  pathMod.posix = pathMod;
  pathMod.win32 = pathMod;
  pathMod.default = pathMod;
  return pathMod;
}
