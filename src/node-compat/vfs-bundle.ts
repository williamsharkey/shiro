/**
 * Bundle a module from the virtual filesystem into one browser ES module
 * (esbuild-wasm, the page's), so a package built for browsers can run as
 * real page code: its Web Workers, fetched .wasm and top-level await work as
 * they do on a web page, which node-compat's module loader can't give it.
 *
 * Resolution is node's with browser conditions: package.json "exports"
 * (browser, import, module, default; subpaths and * patterns), "browser" /
 * "module" / "main", node_modules up the directory tree, extensions and
 * index files. An asset referenced as `new URL('./x', import.meta.url)`
 * becomes a blob: URL of the file, or, for a script (a Worker's entry), of
 * that script bundled the same way.
 */
import * as esbuild from 'esbuild-wasm';
import { ensureEsbuildInitialized } from '../commands/build';
import { codeMask } from '../commands/jseval/module-transform';

export interface BundleFs {
  readFile(path: string, enc?: string): Promise<any>;
  resolvePath(path: string, cwd: string): string;
}

export interface BundleOptions {
  /** Module specifiers replaced by source text (a shim for a dependency) */
  replace?: Record<string, string>;
  /** Like replace, for this bundle only (not the scripts it bundles for its Workers) */
  replaceInEntryGraph?: Record<string, string>;
  /** Code put before the bundle */
  banner?: string;
  /** Resolved files bundled as other files (a package's node binding as its browser one) */
  redirect?: Record<string, string>;
  /**
   * Node builtins (node:fs, path) the code imports: modules re-exporting
   * these objects' properties, read at run time through
   * globalThis.__shiroBuiltin(name) (the requiring process's builtins)
   */
  builtins?: (name: string) => any;
  /** Extra export conditions, ahead of browser/import/module/default */
  conditions?: string[];
  /** Each blob: URL made for an asset (to revoke when the bundle is let go) */
  onAssetUrl?: (url: string) => void;
  /** Edits to a file's source as it is bundled (path → [from, to] pairs) */
  patch?: Record<string, [string, string][]>;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const MIME: Record<string, string> = { wasm: 'application/wasm', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json' };

export async function bundleFromVfs(fs: BundleFs, entry: string, opts: BundleOptions = {}): Promise<string> {
  await ensureEsbuildInitialized();
  const conditions = [...(opts.conditions ?? []), 'browser', 'import', 'module', 'default'];
  const exists = async (p: string) => { try { await fs.readFile(p); return true; } catch { return false; } };
  const readJson = async (p: string) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } };

  const target = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) { for (const x of v) { const t = target(x); if (t) return t; } return undefined; }
    if (v && typeof v === 'object') {
      for (const c of conditions) if (c in (v as any)) { const t = target((v as any)[c]); if (t) return t; }
    }
    return undefined;
  };
  const fromExports = (exp: any, sub: string): string | undefined => {
    if (typeof exp === 'string' || Array.isArray(exp)) return sub === '.' ? target(exp) : undefined;
    const keys = Object.keys(exp ?? {});
    if (!keys.some((k) => k.startsWith('.'))) return sub === '.' ? target(exp) : undefined;
    if (exp[sub] !== undefined) return target(exp[sub]);
    for (const k of keys) {
      const star = k.indexOf('*');
      if (star < 0) continue;
      const pre = k.slice(0, star), post = k.slice(star + 1);
      if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
        const t = target(exp[k]);
        if (t) return t.replace('*', sub.slice(pre.length, sub.length - post.length));
      }
    }
    return undefined;
  };
  const asFile = async (p: string): Promise<string | null> => {
    for (const ext of ['', '.js', '.mjs', '.cjs', '.json']) if (await exists(p + ext)) {
      // a directory "exists" only as a file read; directories fail readFile
      return p + ext;
    }
    const pkg = await readJson(p + '/package.json');
    if (pkg) {
      const main = (typeof pkg.browser === 'string' ? pkg.browser : null) ?? pkg.module ?? pkg.main;
      if (main) { const f = await asFile(fs.resolvePath(main, p)); if (f) return f; }
    }
    for (const idx of ['/index.js', '/index.mjs', '/index.cjs']) if (await exists(p + idx)) return p + idx;
    return null;
  };
  const resolveBare = async (spec: string, fromDir: string): Promise<string | null> => {
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = '.' + spec.slice(name.length);
    for (let dir = fromDir; ; dir = dirOf(dir)) {
      const pkgDir = `${dir === '/' ? '' : dir}/node_modules/${name}`;
      const pkg = await readJson(pkgDir + '/package.json');
      if (pkg) {
        if (pkg.exports !== undefined) {
          const t = fromExports(pkg.exports, sub);
          if (t) return fs.resolvePath(t, pkgDir);
        }
        return asFile(sub === '.' ? pkgDir : fs.resolvePath(sub, pkgDir));
      }
      if (dir === '/') return null;
    }
  };

  const replace: Record<string, string> = { ...opts.replace, ...opts.replaceInEntryGraph };
  const assetUrls = new Map<string, string>();
  const assetUrl = async (path: string): Promise<string> => {
    const have = assetUrls.get(path);
    if (have) return have;
    const ext = path.slice(path.lastIndexOf('.') + 1);
    let blob: Blob;
    if (ext === 'js' || ext === 'mjs') blob = new Blob([await bundleFromVfs(fs, path, { ...opts, replaceInEntryGraph: undefined, banner: undefined })], { type: 'text/javascript' });
    else blob = new Blob([await fs.readFile(path)], { type: MIME[ext] ?? 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    assetUrls.set(path, url);
    opts.onAssetUrl?.(url);
    return url;
  };

  const plugin: esbuild.Plugin = {
    name: 'vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (replace[args.path] !== undefined) return { path: args.path, namespace: 'replaced' };
        if (args.kind === 'entry-point') return { path: args.path, namespace: 'vfs' };
        if (/^node:|^(fs|fs\/promises|path|os|crypto|url|util|events|stream|worker_threads|child_process|module|assert|tty|readline|process|perf_hooks|zlib|buffer|v8|vm|http|https|net)$/.test(args.path)) {
          return opts.builtins ? { path: args.path.replace(/^node:/, ''), namespace: 'builtin' } : { path: args.path, external: true };
        }
        const fromDir = dirOf(args.importer);
        const resolved = args.path.startsWith('.') || args.path.startsWith('/')
          ? await asFile(fs.resolvePath(args.path, fromDir))
          : await resolveBare(args.path, fromDir);
        if (!resolved) return { errors: [{ text: `Cannot resolve ${args.path} from ${args.importer}` }] };
        return { path: opts.redirect?.[resolved] ?? resolved, namespace: 'vfs' };
      });
      build.onLoad({ filter: /.*/, namespace: 'replaced' }, (args) => ({ contents: replace[args.path], loader: 'js', resolveDir: '/' }));
      build.onLoad({ filter: /.*/, namespace: 'builtin' }, (args) => {
        let names: string[] = [];
        try { names = Object.keys(opts.builtins!(args.path) ?? {}).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default'); } catch { /* none */ }
        const get = `globalThis.__shiroBuiltin(${JSON.stringify(args.path)})`;
        return {
          contents: `const m = ${get};\nexport default m;\n${names.map((n) => `export const ${n} = m[${JSON.stringify(n)}];`).join('\n')}`,
          loader: 'js', resolveDir: '/',
        };
      });
      build.onLoad({ filter: /.*/, namespace: 'vfs' }, async (args) => {
        let source = await fs.readFile(args.path, 'utf8') as string;
        for (const [from, to] of opts.patch?.[args.path] ?? []) source = source.replace(from, to);
        const dir = dirOf(args.path);
        // In code only (not in strings: rolldown has "import.meta.url" as an object key)
        const mask = source.includes('import.meta.url') ? codeMask(source) : null;
        let contents = '';
        let last = 0;
        if (mask) {
          for (const m of source.matchAll(/new\s+URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)|import\.meta\.url/g)) {
            if (!mask[m.index!]) continue;
            let rep = JSON.stringify(`file://${args.path}`);
            if (m[2]) {
              // new URL('./asset', import.meta.url): a blob of the asset (a script: bundled)
              const url = await assetUrl(fs.resolvePath(m[2], dir)).catch(() => null);
              rep = url ? `new URL(${JSON.stringify(url)})` : `new URL(${JSON.stringify(m[2])}, ${rep})`;
            }
            contents += source.slice(last, m.index!) + rep;
            last = m.index! + m[0].length;
          }
        }
        contents += source.slice(last);
        const loader = args.path.endsWith('.json') ? 'json' : 'js';
        return { contents, loader, resolveDir: dir };
      });
    },
  };

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    banner: opts.banner ? { js: opts.banner } : undefined,
    plugins: [plugin],
  });
  return result.outputFiles![0].text;
}
