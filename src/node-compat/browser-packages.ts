/**
 * Packages a node script uses through their browser builds, run as real page
 * modules (vfs-bundle.ts) instead of through node-compat's loader.
 *
 * rolldown (vite 8's bundler) has a native binding, or a WebAssembly one for
 * node that needs node:wasi and worker_threads threads. npm installs its
 * browser build, @rolldown/browser, under the name rolldown (npm-tree.ts),
 * whose binding runs as browser code: Web Workers for its threads and an
 * async-compiled .wasm. Its subpaths (rolldown, rolldown/experimental, ...)
 * are bundled together, so they share one instance of the binding, and its
 * WASI file system, an in-memory memfs on the web, is the node process's own
 * fs, so rolldown reads the project's files.
 *
 * lightningcss (vite's CSS minifier) the same way, as lightningcss-wasm.
 */
import { bundleFromVfs, type BundleFs } from './vfs-bundle';

interface BrowserPackage {
  /** The specifier node code requires it by */
  name: string;
  /** package.json "name" of the browser build installed under it */
  browserName: string;
  /** Its subpaths that run in a page (others need node: config loading, parallel plugins on worker_threads) */
  subpaths: string[];
  /** A napi-rs WASI binding (@napi-rs/wasm-runtime): its file system is the process's, its node entry the browser one */
  napiWasi?: { nodeBinding: string; browserBinding: string };
  /** Run once loaded, before any script sees it (an async WebAssembly init) */
  init?: (main: any) => Promise<unknown>;
}

const PACKAGES: BrowserPackage[] = [{
  name: 'rolldown', browserName: '@rolldown/browser',
  subpaths: ['.', './experimental', './experimental/runtime', './filter', './parseAst', './plugins', './utils', './getLogFilter'],
  napiWasi: { nodeBinding: 'dist/rolldown-binding.wasi.cjs', browserBinding: 'dist/rolldown-binding.wasi-browser.js' },
}, {
  // vite's CSS minifier. Its node build compiles its 16 MB .wasm synchronously,
  // which a page's main thread may not; the browser build compiles it async in init()
  name: 'lightningcss', browserName: 'lightningcss-wasm',
  subpaths: ['.'],
  init: (main) => main.default(),
}];

/** Loaded packages: package dir → specifier → module namespace */
const loaded = new Map<string, Promise<Map<string, any>>>();

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

/**
 * The module namespaces of browser-build packages reachable from `fromDir`
 * (node_modules up the tree), loaded now; empty when there are none.
 * `processFs` is the requiring process's fs (WASI's file system),
 * `proc` its process.
 */
export async function loadBrowserPackages(fs: BundleFs, fromDir: string, getBuiltinModule: (name: string) => any, proc: any,
  trackAsync?: <T>(p: Promise<T>) => Promise<T>): Promise<Map<string, any>> {
  const processFs = getBuiltinModule('fs');
  const out = new Map<string, any>();
  for (const p of PACKAGES) {
    let pkgDir: string | null = null;
    let pkg: any = null;
    for (let dir = fromDir; ; dir = dirOf(dir)) {
      const candidate = `${dir === '/' ? '' : dir}/node_modules/${p.name}`;
      try { pkg = JSON.parse(await fs.readFile(candidate + '/package.json', 'utf8')); pkgDir = candidate; break; } catch { /* up */ }
      if (dir === '/') break;
    }
    if (!pkgDir || pkg?.name !== p.browserName) continue;
    // The process the bundle sees (its process.cwd(), env) and the fs WASI uses: the latest requirer's
    (globalThis as any).__shiroBrowserProcess = proc;
    (globalThis as any).__shiroWasiFs = processFs;
    (globalThis as any).__shiroBuiltin = getBuiltinModule;
    let ready = loaded.get(pkgDir);
    if (!ready) {
      ready = loadPackage(fs, pkgDir, pkg, p, getBuiltinModule);
      loaded.set(pkgDir, ready);
      ready.catch(() => loaded.delete(pkgDir!));
    }
    // Its async calls count as the process's activity (the script doesn't idle out mid-build)
    (globalThis as any).__shiroBrowserTrack = trackAsync;
    for (const [spec, ns] of await ready) out.set(spec, trackedNamespace(ns));
  }
  return out;
}

async function loadPackage(fs: BundleFs, pkgDir: string, pkg: any, p: BrowserPackage, getBuiltinModule: (name: string) => any): Promise<Map<string, any>> {
  // Every subpath the package exports, as one module of namespaces
  const subpaths: [string, string][] = [];
  const pick = (v: any): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') for (const c of ['browser', 'import', 'default']) { const t = pick(v[c]); if (t) return t; }
    return undefined;
  };
  for (const [key, v] of Object.entries<any>(pkg.exports ?? { '.': pkg.module ?? pkg.main })) {
    const t = pick(v);
    if (!t || !/\.(m?js)$/.test(t) || !p.subpaths.includes(key)) continue;
    subpaths.push([key, fs.resolvePath(t, pkgDir)]);
  }
  const entry = subpaths.map(([, file], i) => `export * as m${i} from ${JSON.stringify(file)};`).join('\n');
  const entryPath = `${pkgDir}/.tabcomputer-entry.mjs`;
  // @napi-rs/wasm-runtime/fs as the package resolves it (nested, or hoisted up the tree)
  let wasmFsModule = '';
  if (p.napiWasi) {
    for (let dir = pkgDir; ; dir = dirOf(dir)) {
      const candidate = `${dir === '/' ? '' : dir}/node_modules/@napi-rs/wasm-runtime/dist/fs.js`;
      try { await fs.readFile(candidate); wasmFsModule = candidate; break; } catch { /* up */ }
      if (dir === '/') throw new Error(`${p.browserName}: @napi-rs/wasm-runtime is not installed`);
    }
  }
  const code = await bundleFromVfs({
    readFile: (path: string, enc?: string) => (path === entryPath ? Promise.resolve(enc ? entry : new TextEncoder().encode(entry)) : fs.readFile(path, enc)),
    resolvePath: (path: string, cwd: string) => fs.resolvePath(path, cwd),
  }, entryPath, {
    banner: PROCESS_BANNER,
    builtins: getBuiltinModule,
    ...(p.napiWasi ? {
      // Its node entry points import the node WASI binding; here they get the browser one
      redirect: { [`${pkgDir}/${p.napiWasi.nodeBinding}`]: `${pkgDir}/${p.napiWasi.browserBinding}` },
      // Its shared memory starts at what the module needs, not 1 GB (it grows; a phone may not commit 1 GB)
      patch: { [`${pkgDir}/${p.napiWasi.browserBinding}`]: [['initial: 16384,', 'initial: 1024,']] },
      // The main thread's WASI file system: the node process's fs (workers proxy theirs to it)
      replaceInEntryGraph: { '@napi-rs/wasm-runtime/fs': wasmFsShim(wasmFsModule) },
    } : {}),
  });
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const ns: any = await import(/* @vite-ignore */ url);
  if (p.init) await p.init(ns.m0);
  const out = new Map<string, any>();
  subpaths.forEach(([key], i) => out.set(key === '.' ? p.name : p.name + key.slice(1), ns[`m${i}`]));
  return out;
}

/** `process` for browser code that reads it (process.cwd(), process.env): the requiring node process */
// (no versions.node or release: emnapi takes that for node and drives its threads as worker_threads)
const PROCESS_BANNER = `var process = new Proxy({}, { get(_, k) { if (k === 'versions') return {}; if (k === 'release') return undefined; const p = globalThis.__shiroBrowserProcess || { env: {}, cwd: () => '/', platform: 'linux', argv: [] }; const v = p[k]; return typeof v === 'function' ? v.bind(p) : v; }, has(_, k) { return k !== 'versions' && k !== 'release' && k in (globalThis.__shiroBrowserProcess || {}); } });`;

/**
 * @napi-rs/wasm-runtime/fs with memfs() giving the node process's fs, in the
 * shapes the WASI layer and its worker proxy expect: memfs's Stats and Dirent
 * (BigInt fields when asked), node errors with their codes.
 */
function wasmFsShim(realModule: string): string {
  return `import * as real from ${JSON.stringify(realModule)};
export * from ${JSON.stringify(realModule)};
const lib = real.memfsExported;
const S_IFMT = 0o170000;
function stats(st, big) {
  if (!st) return st;
  const o = Object.create(lib.Stats.prototype);
  const n = (v) => (big ? BigInt(Math.trunc(Number(v) || 0)) : Number(v) || 0);
  for (const k of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks']) o[k] = n(st[k]);
  for (const k of ['atime', 'mtime', 'ctime', 'birthtime']) {
    const ms = Number(st[k + 'Ms'] ?? (st[k] && st[k].getTime ? st[k].getTime() : 0)) || 0;
    o[k + 'Ms'] = n(ms);
    if (big) o[k + 'Ns'] = BigInt(Math.trunc(ms)) * 1000000n;
    o[k] = new Date(ms);
  }
  return o;
}
function dirent(name, dir, isDir, isLink) {
  const d = Object.create(lib.Dirent.prototype);
  d.name = name; d.path = dir; d.parentPath = dir;
  d.mode = isLink ? 0o120000 : isDir ? 0o040000 : 0o100000;
  return d;
}
function bridge() {
  const f = () => globalThis.__shiroWasiFs;
  const call = (name) => (...a) => f()[name](...a);
  const target = {
    openSync: call('openSync'), closeSync: call('closeSync'),
    readSync: (fd, buf, off, len, pos) => f().readSync(fd, buf, off, len, pos == null ? undefined : Number(pos)),
    writeSync: (fd, buf, off, len, pos) => f().writeSync(fd, typeof buf === 'string' ? buf : buf.subarray(off ?? 0, (off ?? 0) + (len ?? buf.length))),
    fstatSync: (fd, o) => stats(f().fstatSync(fd), o && o.bigint),
    statSync: (p, o) => stats(f().statSync(p, o && o.throwIfNoEntry === false ? { throwIfNoEntry: false } : undefined), o && o.bigint),
    lstatSync: (p, o) => stats(f().lstatSync(p, o && o.throwIfNoEntry === false ? { throwIfNoEntry: false } : undefined), o && o.bigint),
    readdirSync: (p, o) => {
      const names = f().readdirSync(p);
      if (!o || !o.withFileTypes) return names;
      return names.map((name) => {
        const full = (p === '/' ? '' : p) + '/' + name;
        let st = null; try { st = f().lstatSync(full); } catch {}
        return dirent(name, p, !!(st && st.isDirectory()), !!(st && st.isSymbolicLink && st.isSymbolicLink()));
      });
    },
    realpathSync: call('realpathSync'), readlinkSync: call('readlinkSync'), mkdirSync: call('mkdirSync'),
    rmdirSync: call('rmdirSync'), unlinkSync: call('unlinkSync'), renameSync: call('renameSync'),
    symlinkSync: call('symlinkSync'), linkSync: (a, b) => f().copyFileSync(a, b), utimesSync: call('utimesSync'),
    futimesSync: () => {}, fsyncSync: () => {}, fdatasyncSync: () => {},
    ftruncateSync: (fd, len) => { const e = (globalThis.__shiroFds || {})[fd]; if (e) f().truncateSync ? f().truncateSync(e.path, len) : f().writeFileSync(e.path, ''); },
    existsSync: call('existsSync'), readFileSync: call('readFileSync'), writeFileSync: call('writeFileSync'),
  };
  // memfs's classes as the fs's own entries: the worker proxy tags a Stats or Dirent it
  // sends by finding its constructor among them (an untagged one arrives without isDirectory())
  for (const [k, v] of Object.entries(lib)) if (typeof v === 'function' && /^[A-Z]/.test(k) && !(k in target)) target[k] = v;
  // Anything else (rare) goes to the process's fs as it is
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : (f() && typeof f()[k] === 'function' ? f()[k].bind(f()) : lib[k])) });
}
export function memfs(...a) {
  const { vol } = real.memfs(...a);
  return { fs: bridge(), vol };
}
`;
}

/**
 * A package namespace whose calls count as the calling process's activity:
 * functions' promises are tracked, and the classes and objects the API hands
 * out get their prototype methods instrumented the same way, once, in place
 * (a Proxy would break their private fields). The tracker is the latest
 * requiring process's (globalThis.__shiroBrowserTrack).
 */
const instrumented = new WeakSet<object>();
const track = (r: any): any => {
  if (r && typeof r.then === 'function') {
    const t = (globalThis as any).__shiroBrowserTrack;
    const p = r.then((v: any) => { instrumentObject(v); return v; });
    return t ? t(p) : p;
  }
  instrumentObject(r);
  return r;
};
function instrumentProto(proto: any): void {
  for (let pr = proto; pr && pr !== Object.prototype && pr !== Function.prototype && !instrumented.has(pr); pr = Object.getPrototypeOf(pr)) {
    instrumented.add(pr);
    for (const key of Object.getOwnPropertyNames(pr)) {
      if (key === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(pr, key);
      if (!d || typeof d.value !== 'function' || !d.writable && !d.configurable) continue;
      const fn = d.value;
      try {
        Object.defineProperty(pr, key, { ...d, value: { [key](this: any, ...a: any[]) { return track(fn.apply(this, a)); } }[key] });
      } catch { /* frozen */ }
    }
  }
}
function instrumentObject(v: any): void {
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || Array.isArray(v)) return;
  const proto = Object.getPrototypeOf(v);
  if (proto && proto !== Object.prototype) instrumentProto(proto);
}
function trackedNamespace(ns: any): any {
  const out: any = {};
  for (const key of Object.keys(ns)) {
    const v = ns[key];
    if (typeof v !== 'function') { out[key] = v; continue; }
    if (v.prototype && Object.getOwnPropertyNames(v.prototype).length > 1) instrumentProto(v.prototype); // a class
    // (static methods too)
    out[key] = v.prototype && /^class\b/.test(Function.prototype.toString.call(v))
      ? v
      : Object.assign(function (this: any, ...a: any[]) { return track(v.apply(this, a)); }, v);
  }
  return out;
}
