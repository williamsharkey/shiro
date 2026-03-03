import type { CommandContext } from '../../commands/index';

export function createPathModule(ctx: CommandContext): any {
  const pathMod: any = {
    join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
    resolve: (...parts: string[]) => {
      let p = parts.reduce((a, b) => b.startsWith('/') ? b : a + '/' + b);
      return ctx.fs.resolvePath(p, ctx.cwd);
    },
    dirname: (p: string) => p.substring(0, p.lastIndexOf('/')) || '/',
    basename: (p: string, ext?: string) => {
      const base = p.split('/').pop() || '';
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p: string) => { const m = p.match(/\.[^./]+$/); return m ? m[0] : ''; },
    isAbsolute: (p: string) => p.startsWith('/'),
    normalize: (p: string) => ctx.fs.resolvePath(p, '/'),
    relative: (from: string, to: string) => {
      const f = from.split('/').filter(Boolean);
      const t = to.split('/').filter(Boolean);
      let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
      return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/') || '.';
    },
    sep: '/',
    delimiter: ':',
    parse: (p: string) => ({
      root: p.startsWith('/') ? '/' : '',
      dir: p.substring(0, p.lastIndexOf('/')),
      base: p.split('/').pop() || '',
      ext: (p.match(/\.[^./]+$/) || [''])[0],
      name: (p.split('/').pop() || '').replace(/\.[^.]+$/, ''),
    }),
    format: (obj: any) => (obj.dir ? obj.dir + '/' : '') + (obj.base || obj.name + (obj.ext || '')),
    toNamespacedPath: (p: string) => p,
  };
  pathMod.posix = pathMod;
  pathMod.win32 = pathMod;
  pathMod.default = pathMod;
  return pathMod;
}
