/**
 * pkg-manager.ts — Shiro's package manager (`pkg`, `apt`, `apt-get`)
 *
 * Packages are prebuilt WebAssembly programs described by an index
 * (src/pkg-index.json, plus any lists fetched by `pkg update`). Installing a
 * package downloads its files, checks each download's sha256, unpacks WebC
 * containers, and writes:
 *
 *   /usr/lib/pkg/<name>/...        package files (bin/*.wasm, share/...)
 *   /usr/bin/<cmd> -> ...          symlinks for every binary, so PATH and
 *                                  `which` find them like any other program
 *   /var/lib/pkg/status.json       what is installed (dpkg's status file)
 *
 * The shell runs anything under /usr/lib/pkg/ through `runPackageBinary`,
 * which picks the WASI runtime and the arguments recorded for that binary.
 * Packages that need kernel features the runtime lacks (WASIX, child
 * processes, threads, sockets) are listed but refuse to install or run until
 * a kernel advertises them (globalThis.__tabcomputerKernel.features).
 */

import type { FileSystem } from './filesystem';
import type { CommandContext } from './commands/index';
import { isWebc, parseWebc, type WebcPackage } from './webc';
import type { TarEntry } from './utils/tar';
// utils/tar (~65 KB with its codecs) loads with the first package that needs it
const readTarball = (bytes: Uint8Array) => import('./utils/tar').then(m => m.readTarball(bytes));
import builtinIndexJson from './pkg-index.json';
import { untar, gunzip, type TarEntry as PkgTarEntry } from './pkg-tar';

// ── Index format ─────────────────────────────────────────────────────

/** Kernel features a package can depend on (see docs/UNIX_COMPAT.md). */
export type KernelFeature =
  | 'wasix'           // the WASIX syscall set (wasix_32v1 imports)
  | 'processes'       // fork/exec/spawn, pipes between processes
  | 'threads'         // shared memory + wasi-threads / futex
  | 'sockets'         // TCP through the relay
  | 'blocking-stdin'  // read() that waits for typed input (REPLs, prompts)
  | 'tty'             // termios / raw mode for full-screen programs
  | 'sync-fs'         // on-demand synchronous file access (large trees)
  | 'wasix-stack'     // WASIX stack_checkpoint/stack_restore (setjmp, fork): host-side stack capture
  | 'dynamic-linking' // modules importing env.__indirect_function_table / shared libraries
  | 'mounts'          // package volumes mounted at fixed paths (clang's /sysroot and /lib)
  | 'x86';            // x86-64 Linux ELF in Blink (src/x86-engine): needs SharedArrayBuffer

const KERNEL_FEATURES: KernelFeature[] = [
  'wasix', 'processes', 'threads', 'sockets', 'blocking-stdin', 'tty', 'sync-fs', 'wasix-stack', 'dynamic-linking', 'mounts', 'x86',
];

/** `x86_64-linux`: static x86-64 Linux ELF programs, run in the Blink engine (src/x86-engine) */
export type PkgAbi = 'wasi_snapshot_preview1' | 'wasi_unstable' | 'wasix' | 'x86_64-linux';

export interface PkgFile {
  /** Install path relative to /usr/lib/pkg/<name>/ (a directory for webc volume extracts) */
  path: string;
  /** https URL, or a path ("/pkg/...") served by the Shiro mirror */
  url: string;
  /** sha256 of the downloaded bytes (hex) */
  sha256: string;
  /** Download size in bytes */
  size: number;
  /** When `url` is a WebC container: the atom to take, or a volume subtree to copy */
  webc?: { atom?: string; volume?: string; dir?: string };
  /**
   * The download is compressed: "gzip" is one file (installed at `path`),
   * "tar.gz" a tree unpacked into the directory `path`. sha256/size are the
   * download's.
   */
  unpack?: 'gzip' | 'tar.gz';
  /**
   * When `url` is a tarball (gzipped or not, e.g. an npm package): `member`
   * takes that file out of it; `unpack` extracts the (member's) tar archive
   * into the directory `path`, keeping only entries under `dir` if given.
   */
  tar?: { member?: string; unpack?: boolean; dir?: string };
}

export interface PkgBin {
  /** File (relative to the package root) this command runs */
  file: string;
  /** Arguments inserted after argv[0] (e.g. a data directory) */
  args?: string[];
  /** false: don't take precedence over a Shiro builtin of the same name */
  shadow?: boolean;
  /**
   * Command the program reports as itself (/proc/self/exe; what it runs for
   * an empty program name), when not this one: clang's slim driver re-runs
   * the full clang-16 for -cc1, as Wasmer's "exec-name" does.
   */
  self?: string;
  /**
   * "path": argv[0] is the absolute path the command was found at (not the
   * name typed), as CPython needs to find a venv's pyvenv.cfg.
   */
  argv0?: 'path';
  /** Environment defaults (the user's own values win) */
  env?: Record<string, string>;
}

export interface PkgEntry {
  name: string;
  version: string;
  description: string;
  /** SPDX expression, or "unknown" when upstream metadata doesn't say */
  license: string;
  /** Upstream source (tarball or repository) */
  source: string;
  homepage?: string;
  /** Where the binary comes from: "shiro" (scripts/pkgbuild recipe) or a registry */
  origin: 'shiro' | 'wasmer';
  /** Build recipe in this repo, for origin "shiro" */
  recipe?: string;
  section: string;
  abi: PkgAbi;
  deps?: string[];
  files: PkgFile[];
  bin: Record<string, PkgBin>;
  /** Package directories preloaded for every run (WASI here reads files up front) */
  preload?: string[];
  /**
   * Symlinks outside the package root, made at install and removed with it:
   * absolute link path → path inside the package (e.g. "/usr/share/vim" →
   * "share/vim", where the program looks for its data).
   */
  links?: Record<string, string>;
  /**
   * Package directories the program sees at fixed absolute paths (guest
   * path → path relative to the package root), e.g. clang's sysroot at
   * /sysroot. Applied per process, as WASI preopens named after the guest path.
   */
  mounts?: Record<string, string>;
  /** Kernel features required to work at all (package is blocked without them) */
  needs?: KernelFeature[];
  /** Kernel features some modes need (e.g. an interactive REPL); batch use works */
  wants?: KernelFeature[];
  notes?: string;
}

export interface PkgIndex {
  format: 1;
  packages: PkgEntry[];
}

export interface InstalledPkg {
  name: string;
  version: string;
  installedAt: number;
  /** Bytes written under /usr/lib/pkg/<name> */
  size: number;
  /** Commands linked into /usr/bin */
  bins: string[];
  /** The index entry it was installed from (the runner reads bin args from it) */
  entry: PkgEntry;
}

export const PKG_ROOT = '/usr/lib/pkg';
export const PKG_BIN_DIR = '/usr/bin';
export const PKG_STATE_DIR = '/var/lib/pkg';
export const PKG_STATUS = `${PKG_STATE_DIR}/status.json`;
export const PKG_LISTS_DIR = `${PKG_STATE_DIR}/lists`;
export const PKG_SOURCES = '/etc/pkg/sources.list';
/** Serves the "/pkg/..." URLs when the page isn't on a tabcomputer origin (shiro.computer no longer serves /pkg) */
export const DEFAULT_MIRROR = 'https://tabcomputer.com';

const NAME_RE = /^[a-z0-9][a-z0-9.+_-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Validate an index document; throws an Error naming the first problem. */
export function parseIndex(doc: unknown): PkgIndex {
  const fail = (msg: string): never => { throw new Error(`invalid package index: ${msg}`); };
  if (!doc || typeof doc !== 'object') fail('not an object');
  const d = doc as any;
  if (d.format !== 1) fail(`unsupported format ${JSON.stringify(d.format)}`);
  if (!Array.isArray(d.packages)) fail('packages is not an array');
  const seen = new Set<string>();
  for (const p of d.packages) {
    const where = `package ${JSON.stringify(p?.name)}`;
    if (typeof p?.name !== 'string' || !NAME_RE.test(p.name)) fail(`${where}: bad name`);
    if (seen.has(p.name)) fail(`${where}: duplicate`);
    seen.add(p.name);
    for (const k of ['version', 'description', 'license', 'source', 'section'] as const) {
      if (typeof p[k] !== 'string' || !p[k]) fail(`${where}: missing ${k}`);
    }
    if (!['wasi_snapshot_preview1', 'wasi_unstable', 'wasix', 'x86_64-linux'].includes(p.abi)) fail(`${where}: bad abi ${p.abi}`);
    if (!['shiro', 'wasmer', 'npm'].includes(p.origin)) fail(`${where}: bad origin ${p.origin}`);
    if (!Array.isArray(p.files) || p.files.length === 0) fail(`${where}: no files`);
    const paths = new Set<string>();
    for (const f of p.files) {
      if (typeof f?.path !== 'string' || !safeRelPath(f.path)) fail(`${where}: bad file path ${JSON.stringify(f?.path)}`);
      if (typeof f.url !== 'string' || !(/^https:\/\//.test(f.url) || f.url.startsWith('/'))) fail(`${where}: bad url for ${f.path}`);
      if (typeof f.sha256 !== 'string' || !SHA_RE.test(f.sha256)) fail(`${where}: bad sha256 for ${f.path}`);
      if (typeof f.size !== 'number' || f.size < 0) fail(`${where}: bad size for ${f.path}`);
      if (f.webc && !f.webc.atom && !f.webc.volume) fail(`${where}: webc file ${f.path} names no atom or volume`);
      if (f.unpack !== undefined && f.unpack !== 'gzip' && f.unpack !== 'tar.gz') fail(`${where}: bad unpack for ${f.path}`);
      if (f.tar && !f.tar.member && !f.tar.unpack) fail(`${where}: tar file ${f.path} names no member and doesn't unpack`);
      if (f.tar?.member && !safeRelPath(f.tar.member)) fail(`${where}: bad tar member ${f.tar.member}`);
      paths.add(f.path);
    }
    if (!p.bin || typeof p.bin !== 'object') fail(`${where}: missing bin`);
    for (const [cmd, b] of Object.entries<any>(p.bin)) {
      if (!NAME_RE.test(cmd) && !/^[a-z0-9][a-z0-9._+\[-]*$/.test(cmd)) fail(`${where}: bad command name ${cmd}`);
      // a listed file, or one inside a directory a tarball unpacks into
      const inUnpacked = typeof b?.file === 'string' && p.files.some((f: any) => (f.tar?.unpack || f.unpack === 'tar.gz') && b.file.startsWith(f.path + '/'));
      if (typeof b?.file !== 'string' || !(paths.has(b.file) || inUnpacked)) fail(`${where}: command ${cmd} runs unknown file ${b?.file}`);
      if (b.args !== undefined && (!Array.isArray(b.args) || b.args.some((a: unknown) => typeof a !== 'string'))) fail(`${where}: bad args for ${cmd}`);
      if (b.self !== undefined && (typeof b.self !== 'string' || !p.bin[b.self])) fail(`${where}: ${cmd} names unknown self command ${b.self}`);
    }
    if (p.mounts !== undefined) {
      if (!p.mounts || typeof p.mounts !== 'object') fail(`${where}: bad mounts`);
      for (const [guest, rel] of Object.entries<any>(p.mounts)) {
        if (!/^\/[^\0]*$/.test(guest) || guest.split('/').includes('..') || typeof rel !== 'string' || !safeRelPath(rel)) {
          fail(`${where}: bad mount ${JSON.stringify(guest)}`);
        }
      }
    }
    for (const k of ['needs', 'wants'] as const) {
      if (p[k] === undefined) continue;
      if (!Array.isArray(p[k]) || p[k].some((x: string) => !KERNEL_FEATURES.includes(x as KernelFeature))) fail(`${where}: bad ${k}`);
    }
    if (p.links !== undefined) {
      if (!p.links || typeof p.links !== 'object') fail(`${where}: bad links`);
      for (const [link, target] of Object.entries<any>(p.links)) {
        if (!/^\/(usr|etc|lib|var|opt)\//.test(link) || !safeRelPath(link.slice(1)) || link.startsWith(PKG_BIN_DIR + '/') || link.startsWith(PKG_ROOT + '/')) fail(`${where}: bad link ${link}`);
        if (typeof target !== 'string' || !safeRelPath(target)) fail(`${where}: bad link target for ${link}`);
      }
    }
    if (p.deps !== undefined && (!Array.isArray(p.deps) || p.deps.some((x: unknown) => typeof x !== 'string'))) fail(`${where}: bad deps`);
  }
  for (const p of d.packages) for (const dep of p.deps || []) {
    if (!seen.has(dep)) fail(`package ${JSON.stringify(p.name)}: unknown dependency ${dep}`);
  }
  return d as PkgIndex;
}

function safeRelPath(p: string): boolean {
  return !!p && !p.startsWith('/') && !p.split('/').some(s => s === '' || s === '.' || s === '..');
}

let builtinIndexCache: PkgIndex | null = null;

/** The index compiled into Shiro (src/pkg-index.json). */
export function builtinIndex(): PkgIndex {
  return builtinIndexCache ||= parseIndex(builtinIndexJson);
}

/** Built-in index merged with lists fetched by `pkg update` (later lists win). */
export async function loadIndex(fs: FileSystem): Promise<PkgIndex> {
  await refreshRuntimeMode();
  const byName = new Map(builtinIndex().packages.map(p => [p.name, p]));
  let lists: string[] = [];
  try { lists = (await fs.readdir(PKG_LISTS_DIR)).filter(n => n.endsWith('.json')).sort(); } catch { /* none */ }
  for (const file of lists) {
    try {
      const idx = parseIndex(JSON.parse(await fs.readFile(`${PKG_LISTS_DIR}/${file}`, 'utf8') as string));
      for (const p of idx.packages) byName.set(p.name, p);
    } catch { /* a bad list is reported by `pkg update`, skipped here */ }
  }
  return { format: 1, packages: [...byName.values()] };
}

/** Package by name, or the package providing a command of that name. */
export function findEntry(index: PkgIndex, name: string): PkgEntry | undefined {
  return index.packages.find(p => p.name === name) ||
    index.packages.find(p => Object.prototype.hasOwnProperty.call(p.bin, name));
}

export function searchIndex(index: PkgIndex, query: string): PkgEntry[] {
  const q = query.toLowerCase();
  return index.packages.filter(p =>
    p.name.includes(q) || p.description.toLowerCase().includes(q) || p.section.includes(q) ||
    Object.keys(p.bin).some(b => b.includes(q)));
}

// ── Kernel capability gate ───────────────────────────────────────────

/** What the WASM process runtime (src/wasi/host.ts) can do in this page. */
const MODE_FEATURES: Record<string, KernelFeature[]> = {
  // Worker per process/thread, blocking syscalls over SharedArrayBuffer
  // 'wasix' is the guest's subset (startup, spawn, pipes, futexes, path_open2);
  // packages needing more name it (wasix-stack, sockets, ...)
  // (and the WASIX socket calls, over the kernel sockets of src/kernel/net.ts)
  // and position-independent (dylink.0) main modules, with WASIX dynamic calls
  sab: ['blocking-stdin', 'tty', 'processes', 'threads', 'sync-fs', 'wasix', 'wasix-stack', 'sockets', 'dynamic-linking', 'mounts'],
  // Main thread, imports suspend on the kernel (no shared memory, so no threads)
  jspi: ['blocking-stdin', 'tty', 'processes', 'sync-fs', 'wasix', 'sockets', 'mounts'],
  none: [],
};
let runtimeMode: 'sab' | 'jspi' | 'none' | null = null;
let x86Engine = false;

/** Look up (once per call site) how WASM processes run here; gates use the result. */
export async function refreshRuntimeMode(): Promise<'sab' | 'jspi' | 'none'> {
  try {
    const { wasmProcessMode } = await import('./wasi/host');
    runtimeMode = wasmProcessMode();
  } catch {
    runtimeMode = 'none';
  }
  try {
    const { blinkSupported } = await import('./x86-engine/blink');
    x86Engine = blinkSupported();
  } catch {
    x86Engine = false;
  }
  return runtimeMode;
}

/**
 * Features the kernel provides: those of the WASM process runtime's mode,
 * plus any a kernel component adds to globalThis.__tabcomputerKernel.features.
 */
export function kernelFeatures(): Set<string> {
  const k = (globalThis as any).__tabcomputerKernel;
  const out = new Set<string>(Array.isArray(k?.features) ? k.features : []);
  for (const f of MODE_FEATURES[runtimeMode ?? 'none']) out.add(f);
  if (x86Engine) out.add('x86');
  return out;
}

/**
 * What the x86 engine gives an x86-64 program by itself, whatever the WASM
 * runtime's mode: Blink runs it in a worker over SharedArrayBuffer, with
 * fork/exec, threads, blocking reads and the kernel's ttys and sockets
 * (`pkg install perl` said "needs kernel support" in JSPI mode).
 */
const X86_PROVIDES: KernelFeature[] = ['processes', 'threads', 'blocking-stdin', 'tty', 'sockets', 'sync-fs'];

/** Hard requirements the current kernel doesn't meet. */
export function missingFeatures(entry: PkgEntry, features: KernelFeature[] = entry.needs || []): KernelFeature[] {
  const have = kernelFeatures();
  const byX86 = entry.abi === 'x86_64-linux' && have.has('x86');
  return features.filter(f => !have.has(f) && !(byX86 && X86_PROVIDES.includes(f)));
}

export function packageStatus(entry: PkgEntry): 'ok' | 'partial' | 'blocked' {
  if (missingFeatures(entry).length) return 'blocked';
  if (missingFeatures(entry, entry.wants || []).length) return 'partial';
  return 'ok';
}

// ── Downloads ────────────────────────────────────────────────────────

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve "/pkg/..." against the page origin, or the public mirror elsewhere. */
export function resolveUrl(url: string, env?: Record<string, string>): string {
  if (/^https?:\/\//.test(url)) return url;
  const origin = typeof location !== 'undefined' ? location.origin : undefined;
  const mirror = env?.TABCOMPUTER_PKG_MIRROR || (origin && /^https?:\/\//.test(origin) ? origin : DEFAULT_MIRROR);
  return mirror.replace(/\/$/, '') + url;
}

export interface PkgOptions {
  /** Progress lines (no trailing newline) */
  log?: (line: string) => void;
  /** Install even if the kernel lacks features the package needs */
  force?: boolean;
  /** Reinstall packages that are already installed */
  reinstall?: boolean;
  env?: Record<string, string>;
}

async function download(url: string, sha256: string, opts: PkgOptions): Promise<Uint8Array> {
  const full = resolveUrl(url, opts.env);
  const resp = await fetch(full);
  if (!resp.ok) throw new Error(`download failed: ${full}: ${resp.status} ${resp.statusText || ''}`.trim());
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const got = await sha256Hex(bytes);
  if (got !== sha256) {
    throw new Error(`sha256 mismatch for ${full}\n  expected ${sha256}\n  got      ${got}`);
  }
  return bytes;
}

// ── Installed state ──────────────────────────────────────────────────

export async function readStatus(fs: FileSystem): Promise<Record<string, InstalledPkg>> {
  try {
    return JSON.parse(await fs.readFile(PKG_STATUS, 'utf8') as string);
  } catch {
    return {};
  }
}

async function writeStatus(fs: FileSystem, status: Record<string, InstalledPkg>): Promise<void> {
  await fs.mkdir(PKG_STATE_DIR, { recursive: true });
  await fs.writeFile(PKG_STATUS, JSON.stringify(status, null, 1) + '\n');
  shadowSets.set(fs, shadowsOf(status));
}

/** Install order for `names` and their dependencies (dependencies first). */
export function resolveDeps(index: PkgIndex, names: string[]): PkgEntry[] {
  const order: PkgEntry[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, from?: string) => {
    const entry = findEntry(index, name);
    if (!entry) throw new Error(from ? `${from} depends on unknown package ${name}` : `unable to locate package ${name}`);
    const s = state.get(entry.name);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`dependency cycle through ${entry.name}`);
    state.set(entry.name, 'visiting');
    for (const dep of entry.deps || []) visit(dep, entry.name);
    state.set(entry.name, 'done');
    order.push(entry);
  };
  for (const n of names) visit(n);
  return order;
}

/** Install packages (and dependencies). Returns the names actually installed. */
export async function installPackages(fs: FileSystem, index: PkgIndex, names: string[], opts: PkgOptions = {}): Promise<string[]> {
  const log = opts.log || (() => {});
  const plan = resolveDeps(index, names);
  const status = await readStatus(fs);
  const todo = plan.filter(p => opts.reinstall || status[p.name]?.version !== p.version);
  for (const p of plan) {
    if (!todo.includes(p)) log(`${p.name} is already the newest version (${p.version}).`);
  }
  if (!opts.force) {
    for (const p of todo) {
      const missing = missingFeatures(p);
      if (missing.length) {
        throw new Error(`${p.name} needs kernel support tabcomputer doesn't have yet: ${missing.join(', ')}` +
          (p.notes ? `\n  ${p.notes}` : '') + `\n  (install anyway with --force)`);
      }
    }
  }
  for (const p of todo) {
    if (status[p.name]) await removeFiles(fs, status[p.name]);
    status[p.name] = await installOne(fs, p, opts);
    await writeStatus(fs, status);
  }
  return todo.map(p => p.name);
}

async function installOne(fs: FileSystem, entry: PkgEntry, opts: PkgOptions): Promise<InstalledPkg> {
  const log = opts.log || (() => {});
  const root = `${PKG_ROOT}/${entry.name}`;
  const fetched = new Map<string, Uint8Array>();
  const containers = new Map<string, WebcPackage>();
  const tarballs = new Map<string, Promise<TarEntry[]>>();
  let size = 0;

  log(`Get ${entry.name} ${entry.version} (${formatSize(downloadSize(entry))})`);
  for (const f of entry.files) {
    let bytes = fetched.get(f.sha256);
    if (!bytes) {
      bytes = await download(f.url, f.sha256, opts);
      fetched.set(f.sha256, bytes);
    }
    const dest = `${root}/${f.path}`;
    if (f.unpack === 'gzip') {
      const data = await gunzip(bytes);
      await writeFileP(fs, dest, data, fileMode(entry, f.path));
      size += data.length;
      continue;
    }
    if (f.unpack === 'tar.gz') {
      size += await unpackTree(fs, dest, untar(await gunzip(bytes)));
      continue;
    }
    if (f.tar) {
      size += await installFromTar(fs, f, bytes, dest, tarballs, entry.name);
      continue;
    }
    if (!f.webc) {
      await writeFileP(fs, dest, bytes, fileMode(entry, f.path));
      size += bytes.length;
      continue;
    }
    let pkg = containers.get(f.sha256);
    if (!pkg) {
      if (!isWebc(bytes)) throw new Error(`${f.url} is not a WebC container`);
      pkg = parseWebc(bytes);
      containers.set(f.sha256, pkg);
    }
    if (f.webc.atom) {
      const atom = pkg.atoms.get(f.webc.atom);
      if (!atom) throw new Error(`${entry.name}: no atom ${f.webc.atom} in ${f.url}`);
      await writeFileP(fs, dest, atom);
      size += atom.length;
    } else {
      const vol = pkg.volumes.get(f.webc.volume!);
      if (!vol) throw new Error(`${entry.name}: no volume ${f.webc.volume} in ${f.url}`);
      const prefix = (f.webc.dir || '/').replace(/\/$/, '');
      await fs.mkdir(dest, { recursive: true });
      for (const file of vol.files) {
        if (prefix && !file.path.startsWith(prefix + '/')) continue;
        await writeFileP(fs, dest + file.path.slice(prefix.length), file.data);
        size += file.data.length;
      }
      // Directories that hold no files (python's lib-dynload) and symlinks exist in the volume too
      for (const dir of vol.dirs) {
        if (prefix && !dir.startsWith(prefix + '/')) continue;
        await fs.mkdir(dest + dir.slice(prefix.length), { recursive: true });
      }
      for (const link of vol.symlinks) {
        if (prefix && !link.path.startsWith(prefix + '/')) continue;
        const at = dest + link.path.slice(prefix.length);
        await fs.mkdir(at.slice(0, at.lastIndexOf('/')) || '/', { recursive: true });
        if (!(await lstatSafe(fs, at))) await fs.symlink(link.target, at);
      }
    }
  }

  // Mount points exist on disk, so programs walking the path (realpath) find them
  for (const guest of Object.keys(entry.mounts ?? {})) {
    try { await fs.mkdir(guest, { recursive: true }); } catch { /* a file there: leave it */ }
  }

  await fs.mkdir(PKG_BIN_DIR, { recursive: true });
  const bins: string[] = [];
  for (const [cmd, b] of Object.entries(entry.bin)) {
    const link = `${PKG_BIN_DIR}/${cmd}`;
    const existing = await lstatSafe(fs, link);
    if (existing && existing.type !== 'symlink') {
      log(`warning: not replacing ${link} (a regular file)`);
      continue;
    }
    if (existing && !(await fs.readlink(link)).startsWith(`${PKG_ROOT}/${entry.name}/`)) {
      log(`warning: ${link} belonged to another package; now ${entry.name}`);
    }
    await fs.symlink(`${root}/${b.file}`, link);
    bins.push(cmd);
    // Builtins get a /usr/local/bin wrapper at boot that would win the PATH
    // search; drop it while a package provides the real program.
    if (b.shadow !== false) await removeBuiltinShim(fs, cmd);
  }
  for (const [link, target] of Object.entries(entry.links || {})) {
    const existing = await lstatSafe(fs, link);
    if (existing && existing.type !== 'symlink') {
      log(`warning: not replacing ${link}`);
      continue;
    }
    if (existing) await fs.unlink(link);
    await fs.mkdir(link.substring(0, link.lastIndexOf('/')) || '/', { recursive: true });
    await fs.symlink(`${root}/${target}`, link);
  }
  log(`Setting up ${entry.name} (${entry.version}) ...`);
  return { name: entry.name, version: entry.version, installedAt: Date.now(), size, bins, entry };
}

async function removeBuiltinShim(fs: FileSystem, cmd: string): Promise<void> {
  const shim = `/usr/local/bin/${cmd}`;
  try {
    const text = await fs.readFile(shim, 'utf8') as string;
    if (text === `#!/bin/sh\n${cmd} "$@"\n`) await fs.unlink(shim);
  } catch { /* none */ }
}

async function lstatSafe(fs: FileSystem, path: string) {
  try { return await fs.lstat(path); } catch { return null; }
}

async function writeFileP(fs: FileSystem, path: string, data: Uint8Array, mode?: number): Promise<void> {
  await fs.mkdir(path.substring(0, path.lastIndexOf('/')) || '/', { recursive: true });
  await fs.writeFile(path, data, { mode: mode ?? (path.endsWith('.wasm') ? 0o755 : 0o644) });
}

/** Programs are executable: .wasm files, and an x86 package's bin/, libexec/ and sbin/ files. */
function fileMode(entry: PkgEntry, rel: string): number {
  if (rel.endsWith('.wasm')) return 0o755;
  if (entry.abi === 'x86_64-linux' && /^(bin|sbin|libexec)\//.test(rel)) return 0o755;
  return 0o644;
}

/** Write a tar's entries under `dest`; returns the bytes written. */
async function unpackTree(fs: FileSystem, dest: string, entries: PkgTarEntry[]): Promise<number> {
  let size = 0;
  await fs.mkdir(dest, { recursive: true });
  for (const e of entries) {
    if (!safeRelPath(e.path)) continue;
    const p = `${dest}/${e.path}`;
    if (e.type === 'dir') { await fs.mkdir(p, { recursive: true }); continue; }
    await fs.mkdir(p.substring(0, p.lastIndexOf('/')), { recursive: true });
    if (e.type === 'symlink') {
      if (await lstatSafe(fs, p)) await fs.unlink(p);
      await fs.symlink(e.linkname, p);
      continue;
    }
    await fs.writeFile(p, e.data, { mode: e.mode & 0o777 || 0o644 });
    size += e.data.length;
  }
  return size;
}

/** A file from a tarball (PkgFile.tar). Returns the bytes written. */
async function installFromTar(
  fs: FileSystem, f: PkgFile, download: Uint8Array, dest: string, cache: Map<string, Promise<TarEntry[]>>, pkg: string,
): Promise<number> {
  const t = f.tar!;
  // the download's entries, parsed once however many files come out of it
  const downloadEntries = () => {
    let entries = cache.get(f.sha256);
    if (!entries) { entries = readTarball(download); cache.set(f.sha256, entries); }
    return entries;
  };
  let bytes = download;
  if (t.member) {
    const m = (await downloadEntries()).find(e => e.name === t.member && e.type === '0');
    if (!m) throw new Error(`${pkg}: no ${t.member} in ${f.url}`);
    bytes = m.data;
  }
  if (!t.unpack) {
    await writeFileP(fs, dest, bytes);
    return bytes.length;
  }
  const prefix = (t.dir ?? '').replace(/^\.?\/+|\/+$/g, '');
  let size = 0;
  await fs.mkdir(dest, { recursive: true });
  for (const e of t.member ? await readTarball(bytes) : await downloadEntries()) {
    let rel = e.name.replace(/\/+$/, '');
    if (prefix) {
      if (rel !== prefix && !rel.startsWith(prefix + '/')) continue;
      rel = rel.slice(prefix.length + 1);
    }
    if (!rel || !safeRelPath(rel)) continue;
    const p = `${dest}/${rel}`;
    if (e.type === '5') await fs.mkdir(p, { recursive: true });
    else if (e.type === '2') {
      await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
      try { await fs.unlink(p); } catch { /* none */ }
      await fs.symlink(e.linkname, p);
    } else if (e.type === '0' || e.type === '7') {
      await writeFileP(fs, p, e.data);
      if (e.mode & 0o111) await fs.chmod(p, e.mode & 0o777);
      size += e.data.length;
    }
  }
  return size;
}

async function removeFiles(fs: FileSystem, pkg: InstalledPkg): Promise<void> {
  for (const link of Object.keys(pkg.entry.links || {})) {
    try {
      if ((await fs.readlink(link)).startsWith(`${PKG_ROOT}/${pkg.name}/`)) await fs.unlink(link);
    } catch { /* gone or not ours */ }
  }
  for (const cmd of pkg.bins) {
    const link = `${PKG_BIN_DIR}/${cmd}`;
    try {
      if ((await fs.readlink(link)).startsWith(`${PKG_ROOT}/${pkg.name}/`)) await fs.unlink(link);
    } catch { /* gone or not ours */ }
  }
  try { await fs.rm(`${PKG_ROOT}/${pkg.name}`, { recursive: true }); } catch { /* gone */ }
  moduleCache.forEach((_, k) => { if (k.startsWith(`${PKG_ROOT}/${pkg.name}/`)) moduleCache.delete(k); });
}

/**
 * The profile's preinstalled packages (`preinstall` names that are pkg
 * packages). Installs those that are neither installed nor already provided:
 * every path in a package's `links` existing (Debian's ca-certificates has
 * written /etc/ssl/certs/ca-certificates.crt) counts as provided. Returns the
 * names installed.
 */
export async function preinstallPackages(fs: FileSystem, names: string[], opts: PkgOptions = {}): Promise<string[]> {
  const index = await loadIndex(fs);
  const status = await readStatus(fs);
  const want: string[] = [];
  for (const name of names) {
    const entry = index.packages.find(p => p.name === name);
    if (!entry || status[entry.name]) continue;
    const links = Object.keys(entry.links || {});
    if (links.length && (await Promise.all(links.map(l => lstatSafe(fs, l)))).every(Boolean)) continue;
    want.push(entry.name);
  }
  return want.length ? installPackages(fs, index, want, opts) : [];
}

/** Remove an installed package. Returns false when it wasn't installed. */
export async function removePackage(fs: FileSystem, name: string): Promise<boolean> {
  const status = await readStatus(fs);
  const pkg = status[name] || Object.values(status).find(p => p.bins.includes(name));
  if (!pkg) return false;
  await removeFiles(fs, pkg);
  delete status[pkg.name];
  await writeStatus(fs, status);
  return true;
}

/** Installed packages whose other installed packages depend on `name`. */
export async function reverseDeps(fs: FileSystem, name: string): Promise<string[]> {
  const status = await readStatus(fs);
  return Object.values(status).filter(p => (p.entry.deps || []).includes(name)).map(p => p.name);
}

export function downloadSize(entry: PkgEntry): number {
  const seen = new Set<string>();
  let n = 0;
  for (const f of entry.files) if (!seen.has(f.sha256)) { seen.add(f.sha256); n += f.size; }
  return n;
}

export function formatSize(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} kB`;
  return `${n} B`;
}

// ── Builtin shadowing ────────────────────────────────────────────────

const shadowSets = new WeakMap<FileSystem, Set<string>>();
const shadowLoads = new WeakMap<FileSystem, Promise<Set<string>>>();

function shadowsOf(status: Record<string, InstalledPkg>): Set<string> {
  const out = new Set<string>();
  for (const pkg of Object.values(status)) {
    for (const cmd of pkg.bins) if (pkg.entry.bin[cmd]?.shadow !== false) out.add(cmd);
  }
  return out;
}

/**
 * Commands an installed package provides in place of a Shiro builtin of the
 * same name (`lua`, `sqlite3`, `jq` once the real ones are installed).
 * Multi-call applets mark themselves `shadow: false`. Synchronous so command
 * dispatch doesn't gain an await: empty until `loadPackageShadows` has read
 * the status file (the shell starts that when it's created), then kept
 * current by install and remove.
 */
/**
 * Names whose program file replaces the builtin for other reasons: Debian
 * mode's programs in /usr/bin, /usr/sbin, ... (src/debian/overlay.ts).
 */
export const extraShadows = new WeakMap<FileSystem, Set<string>>();

/** Commands an installed package (or, in Debian mode, a program file) provides in place of a builtin. */
export function packageShadows(fs: FileSystem): Set<string> {
  const own = shadowSets.get(fs);
  const extra = extraShadows.get(fs);
  if (!extra?.size) return own || new Set();
  if (!own?.size) return extra;
  return new Set([...own, ...extra]);
}

/** packageShadows from `pkg install` alone: those programs are /usr/bin/NAME links into /usr/lib/pkg. */
export function pkgOwnShadows(fs: FileSystem): Set<string> {
  return shadowSets.get(fs) || new Set();
}

export function loadPackageShadows(fs: FileSystem): Promise<Set<string>> {
  let p = shadowLoads.get(fs);
  if (!p) {
    p = readStatus(fs).then(status => {
      if (!shadowSets.has(fs)) shadowSets.set(fs, shadowsOf(status));
      return shadowSets.get(fs)!;
    });
    shadowLoads.set(fs, p);
  }
  return p;
}

// ── Running installed binaries ───────────────────────────────────────

const moduleCache = new Map<string, WebAssembly.Module>();

/** Package that owns a path under /usr/lib/pkg, or null. */
export function packageOfPath(path: string): string | null {
  if (!path.startsWith(PKG_ROOT + '/')) return null;
  return path.slice(PKG_ROOT.length + 1).split('/')[0] || null;
}

/**
 * Run an installed package binary. `binPath` is the resolved file under
 * /usr/lib/pkg, `argv0` the name it was invoked as (the /usr/bin link name).
 * Output goes to ctx.stdout/ctx.stderr (or the terminal, for kernel
 * processes writing to it).
 */
export async function runPackageBinary(binPath: string, argv0: string, args: string[], ctx: CommandContext, invokedPath?: string): Promise<number> {
  const name = packageOfPath(binPath);
  const status = name ? (await readStatus(ctx.fs))[name] : undefined;
  const entry = status?.entry;
  const rel = name ? binPath.slice(PKG_ROOT.length + name.length + 2) : '';
  const bin = entry && (entry.bin[argv0]?.file === rel ? entry.bin[argv0] :
    Object.values(entry.bin).find(b => b.file === rel));
  const mode = await refreshRuntimeMode();
  if (name === 'python3' && pythonFrontend(args)) {
    const { runPythonFrontend } = await import('./commands/python-wasi');
    return runPythonFrontend(ctx, args, invokedPath ?? binPath);
  }
  if (bin?.argv0 === 'path' && invokedPath) argv0 = invokedPath;

  if (entry) {
    const missing = missingFeatures(entry);
    if (missing.length && ctx.env?.TABCOMPUTER_PKG_FORCE !== '1') {
      ctx.stderr += `${argv0}: needs kernel support tabcomputer doesn't have yet: ${missing.join(', ')}\n`;
      return 126;
    }
  }

  if (entry?.abi === 'x86_64-linux') {
    const { runElfWithBlink } = await import('./x86-engine/blink');
    return runElfWithBlink(binPath, [...(bin?.args || []), ...args], {
      fs: ctx.fs, cwd: ctx.cwd, env: { ...ctx.env }, stdin: ctx.stdin,
      writeStdout: (t) => { ctx.stdout += t; }, writeStderr: (t) => { ctx.stderr += t; },
    }, argv0);
  }
  const bytes = await ctx.fs.readFile(binPath) as Uint8Array;
  let mod = moduleCache.get(binPath);
  if (!mod) {
    mod = await WebAssembly.compile(bytes as BufferSource);
    moduleCache.set(binPath, mod);
  }
  const argv = [argv0, ...(bin?.args || []), ...args];

  // A kernel process when the page can block: interactive stdin, streamed
  // output, files opened on demand, threads and child processes. Snapshot-0
  // programs keep the in-page runtime, which adapts wasi_unstable.
  if (mode !== 'none' && entry?.abi !== 'wasi_unstable') {
    const { runWasiProgram } = await import('./wasi/run-command');
    return runWasiProgram(ctx, {
      module: mod, image: bytes, argv, cwd: ctx.cwd, env: { ...bin?.env, ...ctx.env },
      preopens: await topLevelDirs(ctx.fs, entry), mounts: entry && name ? entryMounts(entry, name) : undefined,
      exe: bin?.self ? `${PKG_BIN_DIR}/${bin.self}` : undefined,
    });
  }
  return runInPage(mod, entry, argv, args, ctx);
}

/**
 * A pkg-installed binary as a kernel program for a shell job (shell-kernel.ts),
 * or null to leave it to runPackageBinary: the package is gated (it prints
 * why), it is a snapshot-0 program (the kernel guest is preview1 only), or
 * this page can't run WASM processes.
 */
export async function packageKernelProgram(
  fs: FileSystem, binPath: string, argv0: string, args: string[], invokedPath?: string,
): Promise<{ argv: string[]; run: import('./kernel/kernel').Runner; env?: Record<string, string> } | null> {
  const name = packageOfPath(binPath);
  const entry = name ? (await readStatus(fs))[name]?.entry : undefined;
  if (!entry || entry.abi === 'wasi_unstable') return null;
  const mode = await refreshRuntimeMode();
  if ((mode === 'none' && entry.abi !== 'x86_64-linux') || missingFeatures(entry).length) return null;
  // `python -m pip/venv` are Shiro's (runPackageBinary)
  if (name === 'python3' && pythonFrontend(args)) return null;
  const rel = binPath.slice(PKG_ROOT.length + entry.name.length + 2);
  const bin = entry.bin[argv0]?.file === rel ? entry.bin[argv0] : Object.values(entry.bin).find(b => b.file === rel);
  if (bin?.argv0 === 'path' && invokedPath) argv0 = invokedPath;
  if (entry.abi === 'x86_64-linux') {
    const { blinkRunner } = await import('./x86-engine/blink');
    return { argv: [argv0, ...(bin?.args || []), ...args], run: blinkRunner(binPath), env: bin?.env };
  }
  const bytes = await fs.readFile(binPath) as Uint8Array;
  let mod = moduleCache.get(binPath);
  if (!mod) {
    mod = await WebAssembly.compile(bytes as BufferSource);
    moduleCache.set(binPath, mod);
  }
  const { wasmRunner } = await import('./wasi/host');
  return {
    argv: [argv0, ...(bin?.args || []), ...args],
    run: wasmRunner(mod, new Uint8Array(bytes), await topLevelDirs(fs, entry), name ? entryMounts(entry, name) : undefined,
      bin?.self ? `${PKG_BIN_DIR}/${bin.self}` : undefined),
    env: bin?.env,
  };
}

/** A package's mounts as guest path → absolute directory. */
function entryMounts(entry: PkgEntry, name: string): Record<string, string> | undefined {
  if (!entry.mounts) return undefined;
  const out: Record<string, string> = {};
  for (const [guest, rel] of Object.entries(entry.mounts)) out[guest] = `${PKG_ROOT}/${name}/${rel}`;
  return out;
}

/**
 * Mounts for a program started by path (a package's `wasm-ld` spawned by
 * its `clang`): those of the installed package the file belongs to.
 */
export async function packageMountsForPath(fs: FileSystem, path: string): Promise<Record<string, string> | undefined> {
  let real = path;
  try { real = await fs.realpath(path); } catch { /* keep the path */ }
  const name = packageOfPath(real);
  if (!name) return undefined;
  const entry = (await readStatus(fs))[name]?.entry;
  return entry ? entryMounts(entry, name) : undefined;
}

/**
 * The arguments an installed command inserts after argv[0] (`egrep` is
 * `grep -E`, `zcat` is `gzip -dc`), when `path` is its /usr/bin link: what
 * the kernel adds when a program execs the command by path.
 */
export async function packageArgsForPath(fs: FileSystem, path: string): Promise<string[] | undefined> {
  if (!path.startsWith(PKG_BIN_DIR + '/')) return undefined;
  const cmd = path.slice(PKG_BIN_DIR.length + 1);
  if (!packageShadows(fs).has(cmd) && !(await loadPackageShadows(fs)).has(cmd)) return undefined;
  for (const pkg of Object.values(await readStatus(fs))) {
    const args = pkg.entry?.bin[cmd]?.args;
    if (args?.length) return args;
  }
  return undefined;
}

/**
 * `python [opts] -m pip|venv|ensurepip ...`: modules Shiro provides itself,
 * because WASI python has no sockets (pip) or subprocess (venv's ensurepip).
 */
export function pythonFrontend(args: string[]): 'pip' | 'venv' | 'ensurepip' | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m') {
      const m = args[i + 1];
      return m === 'pip' || m === 'venv' || m === 'ensurepip' ? m : null;
    }
    if (!/^-[IEsSuBqObvxdR]+$/.test(a)) return null;
  }
  return null;
}

/**
 * "/usr", "/home", ...: preopened by name for libcs that don't match "/"
 * (see wasmRunner). Not for WASIX programs: their libc matches "/", and the
 * early one in dash strips the wrong prefix when several preopens match.
 */
async function topLevelDirs(fs: FileSystem, entry?: PkgEntry): Promise<string[]> {
  if (entry?.abi === 'wasix') return [];
  const out: string[] = [];
  try {
    for (const name of await fs.readdir('/')) {
      try { if ((await fs.stat(`/${name}`)).type === 'dir') out.push(`/${name}`); } catch { /* skip */ }
    }
  } catch { /* none */ }
  return out;
}

/** The older in-page runtime: files are read before the program starts. */
async function runInPage(mod: WebAssembly.Module, entry: PkgEntry | undefined, argv: string[], args: string[], ctx: CommandContext): Promise<number> {
  const name = entry?.name;
  // Some preview1 wasi-libc builds only match a preopen when a '/' follows
  // its name, so a lone "/" never matches "/usr/...": also preopen the
  // top-level directories this run touches. Snapshot-0 (2019) builds resolve
  // "/" fine but corrupt their heap with more than a couple of preopens.
  const preopens: Record<string, string> = { '/': '/' };
  if (entry?.abi !== 'wasi_unstable') {
    const tops = [PKG_ROOT, ctx.cwd, ctx.env.HOME || '', ...args.filter(a => a.startsWith('/'))]
      .map(p => p.split('/')[1]).filter(Boolean);
    for (const top of [...new Set(tops)].slice(0, 4)) preopens[`/${top}`] = `/${top}`;
  }
  preopens['.'] = ctx.cwd;

  const { WasiRT, WasiExit } = await import('./wasi-runtime');
  const wasi = new WasiRT({
    fs: ctx.fs,
    cwd: ctx.cwd,
    args: argv,
    env: { ...ctx.env },
    stdin: ctx.stdin || '',
    stdinIsTTY: !ctx.stdin,
    stdoutIsTTY: ctx.stdoutIsTTY !== false,
    onStdout: (text) => { ctx.stdout += text; },
    onStderr: (text) => { ctx.stderr += text; },
    preopens,
  });
  // This runtime reads files before the program starts: the working tree,
  // the package's data directories, and anything named on the command line.
  await wasi.preloadTree(ctx.cwd, 3, 100);
  for (const dir of entry?.preload || []) await wasi.preloadTree(`${PKG_ROOT}/${name}/${dir}`, 4, 2000);
  if (ctx.env.HOME) await wasi.preloadDir(ctx.env.HOME);
  for (const a of args) {
    if (a.startsWith('-') && !a.includes('/')) continue;
    const p = ctx.fs.resolvePath(a.replace(/^-[^=]*=/, ''), ctx.cwd);
    try {
      const st = await ctx.fs.stat(p);
      if (st.type === 'dir') await wasi.preloadTree(p, 1, 200);
      else await wasi.preloadFile(p);
      await wasi.preloadDir(p.substring(0, p.lastIndexOf('/')) || '/');
    } catch { /* not a path */ }
  }
  try {
    return await wasi.run(mod);
  } catch (e: any) {
    if (e instanceof WasiExit) return e.code;
    ctx.stderr += `${argv[0]}: ${e?.message || e}\n`;
    return 1;
  }
}
