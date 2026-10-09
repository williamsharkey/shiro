/**
 * GUI apps from Debian, streamed on first use (docs/GUI.md).
 *
 * public/gui/apps.json (scripts/gui/gen-apps.py) lists, per app, the Debian
 * bookworm amd64 packages it needs to start: its ELF closure plus data
 * packages; optional dlopen'ed stacks (Mesa/LLVM, CUPS, ...) are left out.
 * Packages are content addressed by the .deb's sha256 (from Debian's signed
 * index): fetched through the server's /debian/ route, verified, kept in the
 * browser's Cache Storage under that hash (shared by every app, survives a
 * filesystem reset), and unpacked into the root filesystem. dpkg-style
 * triggers (gdk-pixbuf loaders, GSettings schemas, MIME database) then run
 * in Blink like their postinst scripts would. Apps launch as kernel
 * processes (x86-64 ELF in Blink) with DISPLAY=:0.
 */
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';
import { untar, gunzip, type TarEntry } from '../pkg-tar';

export interface DebPackage { version: string; filename: string; sha256: string; size: number }
export interface GuiApp {
  description: string; toolkit: string; bin: string; packages: string[];
  size: number; closureSize: number; dropped: string[];
}
export interface AppsManifest {
  suite: string; arch: string; mirror: string; snapshot: string;
  packages: Record<string, DebPackage>;
  apps: Record<string, GuiApp>;
}

export interface InstallProgress {
  phase: 'fetch' | 'unpack' | 'triggers' | 'done';
  pkg?: string;
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
}

export interface InstallResult {
  app: string;
  packages: number;
  /** packages that were already installed */
  skipped: number;
  /** fetched from the network vs from the browser cache */
  fetched: number;
  cached: number;
  bytes: number;
  ms: { total: number; fetch: number; unpack: number; triggers: number };
}

const STATUS = '/var/lib/shiro-gui/status.json';
const CACHE_NAME = 'shiro-debs-v1';
/** Paths not worth unpacking in a browser. */
const SKIP_PATH = /^\/usr\/share\/(doc|man|info|lintian|bug|locale|gtk-doc|help)\//;
const BIN_DIRS = /^\/(usr\/)?s?bin\//;

let manifestOverride: AppsManifest | null = null;
let fetchOverride: ((pkg: DebPackage) => Promise<Uint8Array>) | null = null;

/** Tests: use this manifest / fetcher instead of the network. */
export function configureGuiApps(o: { manifest?: AppsManifest | null; fetchDeb?: ((pkg: DebPackage) => Promise<Uint8Array>) | null }): void {
  if (o.manifest !== undefined) manifestOverride = o.manifest;
  if (o.fetchDeb !== undefined) fetchOverride = o.fetchDeb;
}

let manifestPromise: Promise<AppsManifest> | null = null;

export function guiManifest(): Promise<AppsManifest> {
  if (manifestOverride) return Promise.resolve(manifestOverride);
  manifestPromise ??= fetch(new URL('gui/apps.json', baseUrl()).href).then((r) => {
    if (!r.ok) throw new Error(`gui/apps.json: HTTP ${r.status}`);
    return r.json() as Promise<AppsManifest>;
  });
  manifestPromise.catch(() => { manifestPromise = null; });
  return manifestPromise;
}

function baseUrl(): string {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  return (globalThis as { location?: { href: string } }).location?.href ?? 'http://localhost/';
}

interface Status { packages: Record<string, string>; apps: string[] }

async function readStatus(fs: FileSystem): Promise<Status> {
  try { return JSON.parse(await fs.readFile(STATUS, 'utf8') as string) as Status; } catch { return { packages: {}, apps: [] }; }
}

async function writeStatus(fs: FileSystem, s: Status): Promise<void> {
  await fs.mkdir('/var/lib/shiro-gui', { recursive: true });
  await fs.writeFile(STATUS, JSON.stringify(s, null, 1));
}

export async function isAppInstalled(fs: FileSystem, app: string): Promise<boolean> {
  const st = await readStatus(fs);
  return st.apps.includes(app);
}

// ── fetching ──

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function openCache(): Promise<Cache | null> {
  try { return typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null; } catch { return null; }
}

/** A .deb by content hash: Cache Storage first, else the server's /debian/ route. */
async function getDeb(p: DebPackage, cache: Cache | null): Promise<{ data: Uint8Array; cached: boolean }> {
  const key = new URL(`debian-sha256/${p.sha256}`, baseUrl()).href;
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      const data = new Uint8Array(await hit.arrayBuffer());
      if (data.length === p.size) return { data, cached: true };
    }
  }
  let data: Uint8Array;
  if (fetchOverride) data = await fetchOverride(p);
  else {
    const r = await fetch(new URL(`debian/${p.filename}`, baseUrl()).href);
    if (!r.ok) throw new Error(`${p.filename}: HTTP ${r.status}`);
    data = new Uint8Array(await r.arrayBuffer());
  }
  const h = await sha256Hex(data);
  if (h !== p.sha256) throw new Error(`${p.filename}: sha256 mismatch (got ${h})`);
  if (cache) await cache.put(key, new Response(data as BodyInit, { headers: { 'content-type': 'application/vnd.debian.binary-package' } })).catch(() => {});
  return { data, cached: false };
}

// ── unpacking ──

/** Members of an ar archive (.deb). */
export function arMembers(b: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (new TextDecoder().decode(b.subarray(0, 8)) !== '!<arch>\n') throw new Error('not a .deb (ar) file');
  let off = 8;
  const dec = new TextDecoder();
  while (off + 60 <= b.length) {
    const name = dec.decode(b.subarray(off, off + 16)).trim().replace(/\/$/, '');
    const size = parseInt(dec.decode(b.subarray(off + 48, off + 58)).trim(), 10);
    off += 60;
    out.set(name, b.subarray(off, off + size));
    off += size + (size & 1);
  }
  return out;
}

/** The data.tar entries of a .deb. */
export async function debEntries(deb: Uint8Array): Promise<TarEntry[]> {
  const m = arMembers(deb);
  for (const [name, data] of m) {
    if (!name.startsWith('data.tar')) continue;
    let tar: Uint8Array;
    if (name.endsWith('.xz')) tar = (await import('../commands/compress/xz-codec')).xzDecompressDetailed(data).data;
    else if (name.endsWith('.zst')) tar = (await import('../commands/compress/zstd-codec')).zstdDecodeAll(data);
    else if (name.endsWith('.gz')) tar = await gunzip(data);
    else if (name === 'data.tar') tar = data;
    else throw new Error(`unsupported ${name}`);
    return untar(tar);
  }
  throw new Error('.deb has no data.tar');
}

async function unpack(fs: FileSystem, entries: TarEntry[], ownBins: Set<string>): Promise<number> {
  let files = 0;
  for (const e of entries) {
    let path = '/' + e.path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (path === '/' || SKIP_PATH.test(path + '/')) continue;
    // Never replace Shiro's own commands (and their /usr/bin shims) with a library package's helper
    if (BIN_DIRS.test(path) && !ownBins.has(path) && e.type !== 'dir' && (await fs.exists(path).catch(() => false))) continue;
    if (e.type === 'dir') { await fs.mkdir(path, { recursive: true }).catch(() => {}); continue; }
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    if (e.type === 'symlink') {
      try { await fs.unlink(path); } catch { /* none */ }
      await fs.symlink(e.linkname, path).catch(() => {});
    } else {
      await fs.writeFile(path, e.data, { mode: e.mode & 0o7777 });
    }
    files++;
  }
  return files;
}

// ── triggers ──

/** postinst-like steps, by the file whose presence enables them. */
const TRIGGERS: { when: string; argv: string[] }[] = [
  { when: '/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders', argv: ['/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders', '--update-cache'] },
  { when: '/usr/bin/glib-compile-schemas', argv: ['/usr/bin/glib-compile-schemas', '/usr/share/glib-2.0/schemas'] },
  { when: '/usr/bin/update-mime-database', argv: ['/usr/bin/update-mime-database', '/usr/share/mime'] },
];

async function runTriggers(fs: FileSystem, kernel: Kernel, log: (s: string) => void): Promise<void> {
  for (const d of ['/var/cache/fontconfig', '/tmp/.X11-unix', '/tmp/runtime-user', '/home/user/.cache']) await fs.mkdir(d, { recursive: true }).catch(() => {});
  await fs.chmod('/tmp/runtime-user', 0o700).catch(() => {});
  for (const t of TRIGGERS) {
    if (!(await fs.exists(t.when).catch(() => false))) continue;
    const t0 = Date.now();
    const status = await runQuiet(kernel, t.argv, {});
    log(`trigger ${t.argv[0].split('/').pop()}: status ${status >> 8} in ${Date.now() - t0} ms`);
  }
}

async function runQuiet(kernel: Kernel, argv: string[], env: Record<string, string>): Promise<number> {
  const { BufferFile } = await import('../kernel/fd');
  const out = new BufferFile(null);
  const p = kernel.spawn({ path: argv[0], argv, cwd: '/', env: { ...appEnv(), ...env }, fds: { 0: new BufferFile(''), 1: out, 2: out } });
  return p.wait();
}

/** Environment GUI apps start with. */
export function appEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    DISPLAY: ':0', HOME: '/home/user', USER: 'user', LANG: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin',
    XDG_RUNTIME_DIR: '/tmp/runtime-user', NO_AT_BRIDGE: '1', GTK_A11Y: 'none',
    // no session bus: fail fast instead of GDBus autolaunch
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/no-session-bus',
    ...extra,
  };
}

/**
 * Blink's wasm JIT stalls GTK startup in about 2 of 3 runs under Node
 * (reported to the perf-blink session); the interpreter is reliable there.
 * Qt and plain Xlib apps run fine with the JIT.
 */
export function toolkitEnv(app: GuiApp): Record<string, string> {
  return app.toolkit.startsWith('gtk') ? { BLINK_WJIT: '0' } : {};
}

// ── install & launch ──

const installing = new Map<string, Promise<InstallResult>>();

export function installApp(fs: FileSystem, kernel: Kernel, name: string, onProgress?: (p: InstallProgress) => void, log: (s: string) => void = () => {}): Promise<InstallResult> {
  let p = installing.get(name);
  if (!p) {
    p = doInstall(fs, kernel, name, onProgress, log).finally(() => installing.delete(name));
    installing.set(name, p);
  }
  return p;
}

async function doInstall(fs: FileSystem, kernel: Kernel, name: string, onProgress: ((p: InstallProgress) => void) | undefined, log: (s: string) => void): Promise<InstallResult> {
  const t0 = Date.now();
  const m = await guiManifest();
  const app = m.apps[name];
  if (!app) throw new Error(`no GUI app named ${name}`);
  const status = await readStatus(fs);
  const want = app.packages.filter((n) => status.packages[n] !== m.packages[n].version);
  const totalBytes = want.reduce((a, n) => a + m.packages[n].size, 0);
  const res: InstallResult = { app: name, packages: app.packages.length, skipped: app.packages.length - want.length, fetched: 0, cached: 0, bytes: 0, ms: { total: 0, fetch: 0, unpack: 0, triggers: 0 } };
  const cache = await openCache();
  const ownBins = new Set([app.bin]);
  let done = 0;
  const report = (phase: InstallProgress['phase'], pkg?: string) => onProgress?.({ phase, pkg, done, total: want.length, bytes: res.bytes, totalBytes });
  // Fetch with a few requests in flight; unpack in package order as they arrive
  const fetches = new Map<string, Promise<{ data: Uint8Array; cached: boolean }>>();
  let next = 0;
  const tFetch0 = Date.now();
  const startMore = () => {
    while (next < want.length && fetches.size - done < 6) {
      const n = want[next++];
      fetches.set(n, getDeb(m.packages[n], cache));
    }
  };
  startMore();
  let fetchWait = 0;
  for (const n of want) {
    const tw = Date.now();
    const { data, cached } = await fetches.get(n)!;
    fetchWait += Date.now() - tw;
    if (cached) res.cached++; else { res.fetched++; res.bytes += data.length; }
    report('fetch', n);
    const tu = Date.now();
    const entries = await debEntries(data);
    await unpack(fs, entries, ownBins);
    res.ms.unpack += Date.now() - tu;
    status.packages[n] = m.packages[n].version;
    done++;
    fetches.delete(n);
    startMore();
    report('unpack', n);
  }
  res.ms.fetch = fetchWait;
  void tFetch0;
  const tt = Date.now();
  report('triggers');
  if (want.length) await runTriggers(fs, kernel, log);
  res.ms.triggers = Date.now() - tt;
  if (!status.apps.includes(name)) status.apps.push(name);
  await writeStatus(fs, status);
  res.ms.total = Date.now() - t0;
  report('done');
  return res;
}

export interface LaunchedApp { pid: number; exited: Promise<number>; output: () => string }

/** Start an installed app as a background kernel process. */
export async function launchApp(kernel: Kernel, name: string, args: string[] = [], env: Record<string, string> = {}): Promise<LaunchedApp> {
  const m = await guiManifest();
  const app = m.apps[name];
  if (!app) throw new Error(`no GUI app named ${name}`);
  const { BufferFile } = await import('../kernel/fd');
  const out = new BufferFile(null);
  const p = kernel.spawn({
    path: app.bin, argv: [app.bin.split('/').pop()!, ...args], cwd: '/home/user',
    env: appEnv({ ...toolkitEnv(app), ...env }), fds: { 0: new BufferFile(''), 1: out, 2: out },
  });
  const launched = { pid: p.pid, exited: p.wait(), output: () => out.text() };
  (globalThis as { __guiLast?: LaunchedApp }).__guiLast = launched;
  return launched;
}
