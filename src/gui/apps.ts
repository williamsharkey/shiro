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
import { untar, type TarEntry } from '../pkg-tar';
import { debEntriesOffThread } from './deb';
export { arMembers, debEntries } from './deb';

export interface DebPackage { version: string; filename: string; sha256: string; size: number }
export interface GuiApp {
  description: string; toolkit: string; bin: string;
  /** The Debian package that provides the app (apt's name for it). */
  pkg?: string;
  packages: string[];
  size: number; closureSize: number; dropped: string[];
  /** Its icon, relative to the page (public/gui/icons/). */
  icon?: string;
  /** Paths deleted after unpacking: optional plug-ins whose libraries were left out. */
  remove?: string[];
}
/**
 * A file a postinst would generate, built by gen-apps.py (public/gui/overlay/SHA256), applied when `when` is
 * installed; with `tar`, a tar archive unpacked at `path` (e.g. symlinks).
 */
export interface Overlay { path: string; sha256: string; size: number; when: string; tar?: boolean }
export interface AppsManifest {
  suite: string; arch: string; mirror: string; snapshot: string;
  overlays?: Overlay[];
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
  /** fetch: waiting for downloaded and decoded packages; unpack: writing their files */
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
  if (await debianMode(fs)) {
    const a = (await guiManifest()).apps[app];
    return !!a && (await fs.exists(`/var/lib/dpkg/info/${a.pkg ?? app}.list`)) && (await fs.exists(a.bin));
  }
  const st = await readStatus(fs);
  return st.apps.includes(app);
}

/**
 * Debian mode (`debian install`, docs/DEBIAN.md): the system is a Debian
 * rootfs managed by dpkg, so apps come from its own apt instead of being
 * unpacked from this manifest (whose bookworm libraries would replace the
 * system's).
 */
export async function debianMode(fs: FileSystem): Promise<boolean> {
  try { return !!(await (await import('../debian/rootfs')).installedRootfs(fs)); } catch { return false; }
}

/** Install with the system's apt (Debian mode); `log` gets apt's output lines. */
async function installWithApt(fs: FileSystem, kernel: Kernel, name: string, app: GuiApp, log: (s: string) => void): Promise<InstallResult> {
  const t0 = Date.now();
  const pkg = app.pkg ?? name;
  const { BufferFile } = await import('../kernel/fd');
  // `sudo` is Shiro's builtin (uid 0 for apt); a bare name reaches it through the kernel's builtin loader
  const run = async (cmd: string) => {
    const out = new BufferFile(null);
    const argv = cmd.split(' ');
    const p = kernel.spawn({ path: argv[0], argv, cwd: '/', env: appEnv({ DEBIAN_FRONTEND: 'noninteractive' }), fds: { 0: new BufferFile(''), 1: out, 2: out } });
    const st = await p.wait();
    for (const line of out.text().split('\n').filter(Boolean).slice(-6)) log(line);
    return st;
  };
  // lists may be empty right after `debian install`
  const hasLists = (await fs.readdir('/var/lib/apt/lists').catch(() => [] as string[])).some((f) => f.endsWith('_Packages'));
  if (!hasLists && await run('sudo apt-get update') !== 0) throw new Error('apt-get update failed');
  if (await run(`sudo apt-get install -y --no-install-recommends ${pkg}`) !== 0) throw new Error(`apt-get install ${pkg} failed`);
  const ms = Date.now() - t0;
  return { app: name, packages: 1, skipped: 0, fetched: 0, cached: 0, bytes: 0, ms: { total: ms, fetch: 0, unpack: ms, triggers: 0 } };
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
  return getBlob(p.sha256, p.size, `debian/${p.filename}`, cache, fetchOverride ? () => fetchOverride!(p) : null);
}

/** Bytes by sha256: Cache Storage, else `url` (or `fetcher`), verified and cached. */
async function getBlob(sha256: string, size: number, url: string, cache: Cache | null, fetcher: (() => Promise<Uint8Array>) | null): Promise<{ data: Uint8Array; cached: boolean }> {
  const p = { sha256, size, filename: url };
  const key = new URL(`sha256/${p.sha256}`, baseUrl()).href;
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      const data = new Uint8Array(await hit.arrayBuffer());
      if (data.length === p.size) return { data, cached: true };
    }
  }
  let data: Uint8Array;
  if (fetcher) data = await fetcher();
  else {
    const r = await fetch(new URL(url, baseUrl()).href);
    if (!r.ok) throw new Error(`${p.filename}: HTTP ${r.status}`);
    data = new Uint8Array(await r.arrayBuffer());
  }
  const h = await sha256Hex(data);
  if (h !== p.sha256) throw new Error(`${p.filename}: sha256 mismatch (got ${h})`);
  if (cache) await cache.put(key, new Response(data as BodyInit, { headers: { 'content-type': 'application/vnd.debian.binary-package' } })).catch(() => {});
  return { data, cached: false };
}

// ── unpacking ──

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

/**
 * postinst-like steps: `argv` runs when a package just unpacked put files in
 * `dir`, unless all of them are `covered` (packages whose result ships as an
 * overlay: gen-apps.py).
 */
const TRIGGERS: { dir: string; argv: string[]; covered?: string[] }[] = [
  {
    dir: '/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/',
    argv: ['/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders', '--update-cache'],
    covered: ['libgdk-pixbuf-2.0-0'],
  },
  { dir: '/usr/share/glib-2.0/schemas/', argv: ['/usr/bin/glib-compile-schemas', '/usr/share/glib-2.0/schemas'] },
];

/** The triggers a package's files set off. */
function triggersOf(pkg: string, entries: TarEntry[]): Set<number> {
  const out = new Set<number>();
  TRIGGERS.forEach((t, i) => {
    if (t.covered?.includes(pkg)) return;
    if (entries.some((e) => e.type !== 'dir' && ('/' + e.path.replace(/^\.?\/+/, '')).startsWith(t.dir))) out.add(i);
  });
  return out;
}

async function runTriggers(fs: FileSystem, kernel: Kernel, which: Set<number>, log: (s: string) => void): Promise<void> {
  for (const d of ['/var/cache/fontconfig', '/tmp/.X11-unix', '/tmp/runtime-user', '/home/user/.cache']) await fs.mkdir(d, { recursive: true }).catch(() => {});
  await fs.chmod('/tmp/runtime-user', 0o700).catch(() => {});
  // independent of each other: each is its own Blink worker
  await Promise.all([...which].map(async (i) => {
    const t = TRIGGERS[i];
    if (!(await fs.exists(t.argv[0]).catch(() => false))) return;
    const t0 = Date.now();
    const status = await runQuiet(kernel, t.argv, {});
    log(`trigger ${t.argv[0].split('/').pop()}: status ${status >> 8} in ${Date.now() - t0} ms`);
  }));
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
    // OpenSSL's default CA paths are the openssl package's symlinks (not shipped): use the bundle (an overlay)
    SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
    ...extra,
  };
}

/**
 * Per-toolkit environment. Empty since Blink patch 0029 (SSE compares): GTK 3
 * spun after mapping its window before it, with and without the JIT.
 */
export function toolkitEnv(app: GuiApp): Record<string, string> {
  void app;
  return {};
}

// ── install & launch ──

const installing = new Map<string, Promise<InstallResult>>();
const watchers = new Map<string, Set<(p: InstallProgress) => void>>();

/** Install `name` (or join the install in progress); `onProgress` hears it either way. */
export function installApp(fs: FileSystem, kernel: Kernel, name: string, onProgress?: (p: InstallProgress) => void, log: (s: string) => void = () => {}): Promise<InstallResult> {
  const off = onProgress ? watchInstall(name, onProgress) : () => {};
  let p = installing.get(name);
  if (!p) {
    const notify = (pr: InstallProgress) => { for (const cb of watchers.get(name) ?? []) cb(pr); };
    p = doInstall(fs, kernel, name, notify, log).finally(() => installing.delete(name));
    installing.set(name, p);
  }
  return p.finally(off);
}

/** Progress of `name`'s installs (from any caller); returns unsubscribe. */
export function watchInstall(name: string, cb: (p: InstallProgress) => void): () => void {
  let set = watchers.get(name);
  if (!set) watchers.set(name, set = new Set());
  set.add(cb);
  return () => { set.delete(cb); };
}

/** The install of `name` in progress, if any. */
export function installInProgress(name: string): Promise<InstallResult> | undefined {
  return installing.get(name);
}

/** What installing `name` would download now: packages not yet installed, and their size. */
export async function pendingDownload(fs: FileSystem, name: string): Promise<{ packages: number; bytes: number }> {
  const m = await guiManifest();
  const app = m.apps[name];
  if (!app) return { packages: 0, bytes: 0 };
  const status = await readStatus(fs);
  const want = app.packages.filter((n) => status.packages[n] !== m.packages[n].version);
  return { packages: want.length, bytes: want.reduce((a, n) => a + m.packages[n].size, 0) };
}

async function doInstall(fs: FileSystem, kernel: Kernel, name: string, onProgress: ((p: InstallProgress) => void) | undefined, log: (s: string) => void): Promise<InstallResult> {
  const t0 = Date.now();
  const m = await guiManifest();
  const app = m.apps[name];
  if (!app) throw new Error(`no GUI app named ${name}`);
  if (await debianMode(fs)) return installWithApt(fs, kernel, name, app, log);
  const status = await readStatus(fs);
  // largest first: decoding (xz in JavaScript) is the long pole, so the big ones start at once
  const want = app.packages.filter((n) => status.packages[n] !== m.packages[n].version).sort((a, b) => m.packages[b].size - m.packages[a].size);
  const totalBytes = want.reduce((a, n) => a + m.packages[n].size, 0);
  const res: InstallResult = { app: name, packages: app.packages.length, skipped: app.packages.length - want.length, fetched: 0, cached: 0, bytes: 0, ms: { total: 0, fetch: 0, unpack: 0, triggers: 0 } };
  const cache = await openCache();
  const ownBins = new Set([app.bin]);
  const triggers = new Set<number>();
  let done = 0;
  const report = (phase: InstallProgress['phase'], pkg?: string) => onProgress?.({ phase, pkg, done, total: want.length, bytes: res.bytes, totalBytes });
  // Fetch with a few requests in flight and decode each .deb (workers) as it
  // arrives; write the files in that order
  const ready = new Map<string, Promise<{ entries: TarEntry[]; size: number; cached: boolean }>>();
  let next = 0;
  const startMore = () => {
    while (next < want.length && ready.size < 16) {
      const n = want[next++];
      ready.set(n, getDeb(m.packages[n], cache).then(async ({ data, cached }) => ({ size: data.length, cached, entries: await debEntriesOffThread(data) })));
    }
  };
  startMore();
  const overlays = (m.overlays ?? []).filter((o) => want.includes(o.when)).map((o) => [o, getBlob(o.sha256, o.size, `gui/overlay/${o.sha256}`, cache, fetchOverride ? () => fetchOverride!({ version: '', filename: `gui/overlay/${o.sha256}`, sha256: o.sha256, size: o.size }) : null)] as const);
  for (const [, blob] of overlays) blob.catch(() => {}); // awaited after the packages
  for (const n of want) {
    const tw = Date.now();
    const { entries, size, cached } = await ready.get(n)!;
    res.ms.fetch += Date.now() - tw;
    if (cached) res.cached++; else { res.fetched++; res.bytes += size; }
    ready.delete(n);
    startMore();
    report('fetch', n);
    const tu = Date.now();
    await unpack(fs, entries, ownBins);
    for (const i of triggersOf(n, entries)) triggers.add(i);
    res.ms.unpack += Date.now() - tu;
    status.packages[n] = m.packages[n].version;
    done++;
    report('unpack', n);
  }
  for (const path of app.remove ?? []) await fs.rm(path, { recursive: true }).catch(() => {});
  for (const [o, blob] of overlays) {
    const { data } = await blob;
    if (o.tar) { await unpack(fs, untar(data), ownBins); continue; }
    await fs.mkdir(o.path.slice(0, o.path.lastIndexOf('/')), { recursive: true }).catch(() => {});
    await fs.writeFile(o.path, data);
  }
  const tt = Date.now();
  report('triggers');
  await runTriggers(fs, kernel, triggers, log);
  res.ms.triggers = Date.now() - tt;
  if (!status.apps.includes(name)) status.apps.push(name);
  await writeStatus(fs, status);
  res.ms.total = Date.now() - t0;
  report('done');
  (globalThis as { __guiInstall?: InstallResult }).__guiInstall = res;
  return res;
}

export interface LaunchedApp { pid: number; exited: Promise<number>; output: () => string }

/** Start an installed app as a background kernel process. */
export async function launchApp(kernel: Kernel, name: string, args: string[] = [], env: Record<string, string> = {}): Promise<LaunchedApp> {
  const m = await guiManifest();
  const app = m.apps[name];
  if (!app) throw new Error(`no GUI app named ${name}`);
  const { BufferFile } = await import('../kernel/fd');
  // its windows belong to this app on the desktop, whatever their WM_CLASS
  const instance = app.bin.split('/').pop()!.toLowerCase().replace(/-\d+(\.\d+)*$/, '');
  const ids = await import('../x11/app-ids');
  if (instance !== name) ids.appIdAliases.set(instance, name);
  const out = new BufferFile(null);
  const p = kernel.spawn({
    path: app.bin, argv: [app.bin.split('/').pop()!, ...args], cwd: '/home/user',
    env: appEnv({ ...toolkitEnv(app), ...env }), fds: { 0: new BufferFile(''), 1: out, 2: out },
  });
  ids.pidAppIds.set(p.pid, name);
  const launched = { pid: p.pid, exited: p.wait().finally(() => ids.pidAppIds.delete(p.pid)), output: () => out.text() };
  (globalThis as { __guiLast?: LaunchedApp }).__guiLast = launched;
  return launched;
}
