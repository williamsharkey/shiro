/**
 * Streamed Debian root filesystem (docs/DEBIAN.md).
 *
 * scripts/debian/build-rootfs.sh packs a debootstrap'd Debian into
 * content-addressed gzip chunks plus an index of every path
 * (scripts/debian/pack-rootfs.mjs). Installing it here writes the index as
 * placeholder nodes (FSNode.lazy: type, mode, size, symlink target, no
 * bytes), so the whole tree is visible at once (ls, stat, PATH lookups,
 * dpkg's view) while file contents are fetched the first time something
 * reads them: the chunk holding the file is downloaded, checked against its
 * sha256, kept in the Cache API, and the file's bytes are stored in the
 * FileSystem like any other file. A warm boot needs no network at all.
 */
import type { FileSystem, FSNode, LazyRef } from '../filesystem';

export interface RootfsManifest {
  format: number;
  /** Index id: names this build (lazy refs carry it as `src`). */
  id: string;
  distro: string;
  suite: string;
  version: string;
  snapshot: string;
  arch: string;
  index: string;
  entries: number;
  packages: number;
  files: number;
  bytes: number;
  chunks: number;
  chunkBytes: number;
}

/** What /var/lib/shiro/rootfs.json records about the installed rootfs. */
export interface InstalledRootfs extends RootfsManifest {
  /** Directory URL the chunks are fetched from (absolute, or relative to the page). */
  base: string;
  installedAt: number;
}

type IndexRow = [string, 'd', number, number] | [string, 'l', number, number, string] | [string, 'f', number, number, number, number?, number?];
interface RootfsIndex { format: number; chunks: Array<[string, number, number]>; entries: IndexRow[] }

export const ROOTFS_STATE = '/var/lib/shiro/rootfs.json';
const CACHE_NAME = 'shiro-debian-chunks-v1';

const nodeProcess = (): any => (globalThis as any).process;
const isNode = () => typeof nodeProcess()?.getBuiltinModule === 'function';

/** Where the app serves the rootfs (public/debian → /debian/). */
export function defaultRootfsBase(): string {
  const env = nodeProcess()?.env?.SHIRO_DEBIAN_ROOTFS;
  if (env) return env.endsWith('/') ? env : env + '/';
  if (isNode()) {
    const p = nodeProcess();
    const nodeFs = p.getBuiltinModule('fs');
    const nodePath = p.getBuiltinModule('path');
    const nodeUrl = p.getBuiltinModule('url');
    for (const c of ['public/debian', '../public/debian']) {
      const dir = nodePath.resolve(p.cwd(), c);
      if (nodeFs.existsSync(nodePath.join(dir, 'rootfs.json'))) return nodeUrl.pathToFileURL(dir).href + '/';
    }
  }
  const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : (globalThis as any).location?.href;
  return new URL('debian/', base || 'http://localhost/').href;
}

function absolute(base: string): string {
  if (/^[a-z]+:/i.test(base)) return base;
  const page = typeof document !== 'undefined' && document.baseURI ? document.baseURI : (globalThis as any).location?.href;
  return new URL(base, page || 'http://localhost/').href;
}

/** GET a URL's bytes (file: URLs read from disk under Node, for tests and tools). */
async function getBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('file:') && isNode()) {
    const p = nodeProcess();
    return new Uint8Array(await p.getBuiltinModule('fs').promises.readFile(p.getBuiltinModule('url').fileURLToPath(url)));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Cache API, when this context has it (secure browser contexts). */
async function chunkCache(): Promise<Cache | null> {
  try { return typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null; } catch { return null; }
}

/** Counters for `debian status` and benchmarks. */
export const rootfsStats = { chunksFetched: 0, chunkBytesFetched: 0, chunksFromCache: 0, filesMaterialized: 0, fetchMs: 0 };

/**
 * Fetches and caches chunks for one or more installed rootfs builds. Recently
 * used chunks stay decompressed in memory (a package's files are read
 * together), bounded by `memLimit` bytes.
 */
export class ChunkStore {
  private inflight = new Map<string, Promise<Uint8Array>>();
  private mem = new Map<string, Uint8Array>();
  private memBytes = 0;
  constructor(private base: string, private memLimit = 24 << 20) {}

  get(id: string): Promise<Uint8Array> {
    const hit = this.mem.get(id);
    if (hit) { this.mem.delete(id); this.mem.set(id, hit); return Promise.resolve(hit); }
    let p = this.inflight.get(id);
    if (!p) {
      p = this.load(id).then((data) => {
        this.mem.set(id, data);
        this.memBytes += data.length;
        for (const [k, v] of this.mem) {
          if (this.memBytes <= this.memLimit || k === id) break;
          this.mem.delete(k); this.memBytes -= v.length;
        }
        return data;
      }).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  private async load(id: string): Promise<Uint8Array> {
    const url = absolute(this.base) + `chunks/${id}.gz`;
    const t0 = Date.now();
    const cache = url.startsWith('file:') ? null : await chunkCache();
    let gz: Uint8Array | null = null;
    if (cache) {
      try {
        const res = await cache.match(url);
        if (res) { gz = new Uint8Array(await res.arrayBuffer()); rootfsStats.chunksFromCache++; }
      } catch { /* fall through to the network */ }
    }
    let fromNet = false;
    if (!gz) { gz = await getBytes(url); fromNet = true; }
    const data = await gunzip(gz);
    if (await sha256Hex(data) !== id) {
      if (cache) void cache.delete(url).catch(() => {});
      throw new Error(`rootfs chunk ${id}: sha256 mismatch`);
    }
    if (fromNet) {
      rootfsStats.chunksFetched++;
      rootfsStats.chunkBytesFetched += gz.length;
      if (cache) void cache.put(url, new Response(gz as BodyInit, { headers: { 'content-type': 'application/gzip' } })).catch(() => {});
    }
    rootfsStats.fetchMs += Date.now() - t0;
    return data;
  }
}

const stores = new Map<string, ChunkStore>();

/** The FileSystem's lazy loader for rootfs files: `src` is a build id, mapped to its base URL. */
export function attachRootfsLoader(fs: FileSystem, bases: Record<string, string>): void {
  for (const [src, base] of Object.entries(bases)) if (!stores.has(src)) stores.set(src, new ChunkStore(base));
  fs.setLazyLoader(async (ref: LazyRef, size: number) => {
    const store = stores.get(ref.src);
    if (!store) throw new Error(`no rootfs source ${ref.src}`);
    const chunk = await store.get(ref.chunk);
    rootfsStats.filesMaterialized++;
    return chunk.slice(ref.off, ref.off + size);
  });
}

/** The installed rootfs record, or null when Debian isn't installed. */
export async function installedRootfs(fs: FileSystem): Promise<InstalledRootfs | null> {
  try {
    return JSON.parse(await fs.readFile(ROOTFS_STATE, 'utf8') as string);
  } catch {
    return null;
  }
}

/** Boot hook: when a rootfs is installed, let its lazy files load. Returns the record. */
export async function bootRootfs(fs: FileSystem): Promise<InstalledRootfs | null> {
  const state = await installedRootfs(fs);
  if (state) attachRootfsLoader(fs, { [state.id]: state.base });
  return state;
}

export async function fetchManifest(base = defaultRootfsBase()): Promise<RootfsManifest> {
  const m = JSON.parse(new TextDecoder().decode(await getBytes(absolute(base) + 'rootfs.json')));
  if (m.format !== 1) throw new Error(`unsupported rootfs format ${m.format}`);
  return m;
}

const SHIM_RE = /^#!\/bin\/sh\n[\w.+-]+ "\$@"\n$/;

export interface InstallResult { manifest: RootfsManifest; entries: number; ms: number; moved: string[] }

/**
 * Install the Debian rootfs into `fs`: placeholders for every path, with
 * Debian's files replacing Shiro's where both exist (/etc/passwd, /bin/sh).
 * Shiro's own directories that Debian makes symlinks (/bin → usr/bin) have
 * their contents moved to the link's target, and the PATH shims Shiro writes
 * for its builtins in /usr/local/bin are removed: in Debian mode the overlay
 * (src/debian/overlay.ts) decides which programs are Shiro's.
 */
export async function installRootfs(fs: FileSystem, opts: { base?: string; progress?: (msg: string) => void } = {}): Promise<InstallResult> {
  const t0 = Date.now();
  const base = opts.base ?? defaultRootfsBase();
  const manifest = await fetchManifest(base);
  opts.progress?.(`Debian ${manifest.version} (${manifest.suite}, snapshot ${manifest.snapshot}): ${manifest.packages} packages, ${manifest.entries} paths, ${(manifest.chunkBytes / 1e6).toFixed(1)} MB streamed on demand`);
  const index: RootfsIndex = JSON.parse(new TextDecoder().decode(await gunzip(await getBytes(absolute(base) + manifest.index))));
  attachRootfsLoader(fs, { [manifest.id]: base });

  const moved: string[] = [];
  const nodes: FSNode[] = [];
  for (const row of index.entries) {
    const [path, type, mode, mtimeS] = row;
    const mtime = mtimeS * 1000;
    const existing = await fs.lstat(path).catch(() => null);
    if (type === 'd') {
      if (existing?.isDirectory()) { if (existing.mode !== mode) nodes.push({ path, type: 'dir', content: null, mode, mtime: existing.mtime.getTime(), ctime: existing.ctime.getTime(), size: 0 }); continue; }
      if (existing) await fs.rm(path, { recursive: true });
      nodes.push({ path, type: 'dir', content: null, mode, mtime, ctime: mtime, size: 0 });
    } else if (type === 'l') {
      const target = row[4] as string;
      if (existing?.isDirectory()) moved.push(...await mergeDirInto(fs, path, target));
      else if (existing) await fs.unlink(path);
      nodes.push({ path, type: 'symlink', content: null, mode: 0o777, mtime, ctime: mtime, size: target.length, symlinkTarget: target });
    } else {
      const size = row[4] as number;
      if (existing?.isDirectory()) await fs.rm(path, { recursive: true });
      const node: FSNode = { path, type: 'file', content: size ? null : new Uint8Array(0), mode, mtime, ctime: mtime, size };
      if (size) node.lazy = { src: manifest.id, chunk: index.chunks[row[5] as number][0], off: row[6] as number };
      nodes.push(node);
    }
  }
  // Placeholders go in parent-first order (the index is a depth-first walk)
  fs.putNodes(nodes);

  // Shiro's builtin shims would shadow Debian's /usr/bin (PATH has
  // /usr/local/bin first) and loop through Debian's sh.
  for (const name of await fs.readdir('/usr/local/bin').catch(() => [] as string[])) {
    const p = `/usr/local/bin/${name}`;
    const text = await fs.readFile(p, 'utf8').catch(() => null);
    if (typeof text === 'string' && SHIM_RE.test(text)) await fs.unlink(p);
  }

  await writeEngineWorkarounds(fs);

  const state: InstalledRootfs = { ...manifest, base, installedAt: Date.now() };
  await fs.mkdir('/var/lib/shiro', { recursive: true });
  await fs.writeFile(ROOTFS_STATE, JSON.stringify(state, null, 2) + '\n');
  await fs.sync();
  return { manifest, entries: nodes.length, ms: Date.now() - t0, moved };
}

/** Move what Shiro had in directory `dir` into the directory the symlink at `dir` will point to. */
async function mergeDirInto(fs: FileSystem, dir: string, target: string): Promise<string[]> {
  const dest = fs.resolvePath(target, dir.slice(0, dir.lastIndexOf('/')) || '/');
  const moved: string[] = [];
  await fs.mkdir(dest, { recursive: true });
  for (const name of await fs.readdir(dir)) {
    const from = `${dir}/${name}`;
    // Shiro's stand-ins for /bin/sh and /bin/bash (path-shims.ts) are dropped
    const text = await fs.readFile(from, 'utf8').catch(() => null);
    if (typeof text === 'string' && /^#!\/bin\/(ba)?sh\n$/.test(text)) continue;
    if (await fs.exists(`${dest}/${name}`)) continue;
    await fs.rename(from, `${dest}/${name}`);
    moved.push(from);
  }
  await fs.rm(dir, { recursive: true });
  return moved;
}

/**
 * Fetch the chunks holding `paths` (and nothing else) ahead of use, so a later
 * first run doesn't wait on the network. Returns the number of files filled.
 */
export async function prefetchPaths(fs: FileSystem, paths: string[]): Promise<number> {
  let n = 0;
  await Promise.all(paths.map(async (p) => {
    try { await fs.readFile(p); n++; } catch { /* missing: nothing to fetch */ }
  }));
  return n;
}

/**
 * Environment every Debian program gets in Shiro (the shell exports it in
 * Debian mode). Empty since Blink patch 0028 (brk no longer grows over
 * mmaps; the glibc.malloc.top_pad workaround is gone).
 */
export const DEBIAN_ENV: Record<string, string> = {};

/**
 * Settings that work around engine gaps. apt's needed none now (Dpkg::Use-Pty
 * "false" went when the kernel released a dead session leader's tty): an
 * older install's file is removed, as is the resolv.conf option below.
 */
export async function writeEngineWorkarounds(fs: FileSystem): Promise<void> {
  await fs.unlink('/etc/apt/apt.conf.d/91shiro-engine').catch(() => {});
  // Earlier installs got `options single-request` (Blink failed glibc's
  // parallel A+AAAA sendmmsg until patch 0043): take it out again
  try {
    const conf = await fs.readFile('/etc/resolv.conf', 'utf8') as string;
    if (/^options single-request$/m.test(conf)) {
      await fs.writeFile('/etc/resolv.conf', conf.replace(/^options single-request\n?/m, ''));
    }
  } catch { /* no resolv.conf */ }
  await keepManPages(fs);
}

/**
 * Packages installed from now on keep their English man pages (`man` is no
 * use without them); translations stay out. Images built before this had
 * all of /usr/share/man excluded (scripts/debian/build-rootfs.sh).
 */
export async function keepManPages(fs: FileSystem): Promise<void> {
  const p = '/etc/dpkg/dpkg.cfg.d/90shiro-slim';
  const text = await fs.readFile(p, 'utf8').catch(() => null);
  if (typeof text !== 'string' || text.includes('path-include /usr/share/man/')) return;
  await fs.writeFile(p, text.replace('path-exclude /usr/share/man/*\n', 'path-exclude /usr/share/man/*\npath-include /usr/share/man/man[1-9]*/*\n'));
}
