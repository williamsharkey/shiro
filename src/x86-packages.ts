/**
 * x86-packages.ts — ELF binary package registry and cache for Shiro
 *
 * Manages a registry of musl-static x86-64 ELF binaries that can be
 * downloaded on demand, cached in IndexedDB, and executed through the
 * x86-64 emulator.
 *
 * Mirrors wasi-packages.ts pattern — manifest + IndexedDB cache.
 */

// ── Package manifest types ───────────────────────────────────────────

export interface X86Package {
  /** Package name (used as command name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Version string */
  version: string;
  /** Download URL for the ELF binary */
  url: string;
  /** Size in bytes (approximate, for display) */
  size: number;
  /** Category for search/display */
  category: 'shell' | 'utility' | 'language' | 'coreutil';
  /** Command aliases (alternative names this package provides) */
  aliases?: string[];
  /** For busybox-style multi-call binaries: list of applet names */
  applets?: string[];
}

// ── Package manifest ─────────────────────────────────────────────────
// URLs point to musl-static x86-64 ELF binaries hosted on our CDN.
// All binaries are statically linked with musl libc for portability.

const PACKAGE_MANIFEST: X86Package[] = [
  {
    name: 'busybox',
    description: 'Swiss-army knife of embedded Linux — 300+ utilities in one binary',
    version: '1.36.1',
    url: 'https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox',
    size: 1_100_000,
    category: 'coreutil',
    applets: [
      'ash', 'awk', 'basename', 'cat', 'chmod', 'chown', 'cp', 'cut',
      'date', 'df', 'diff', 'dirname', 'du', 'echo', 'egrep', 'env',
      'expr', 'false', 'fgrep', 'find', 'grep', 'gzip', 'gunzip',
      'head', 'hostname', 'id', 'install', 'kill', 'ln', 'ls', 'md5sum',
      'mkdir', 'mktemp', 'more', 'mv', 'od', 'paste', 'patch', 'printf',
      'ps', 'pwd', 'readlink', 'realpath', 'rm', 'rmdir', 'sed', 'seq',
      'sha1sum', 'sha256sum', 'sha512sum', 'sleep', 'sort', 'stat',
      'strings', 'tail', 'tar', 'tee', 'test', 'touch', 'tr', 'true',
      'uname', 'uniq', 'vi', 'wc', 'wget', 'which', 'whoami', 'xargs',
      'yes', 'zcat',
    ],
  },
  {
    name: 'dash',
    description: 'Debian Almquist Shell — POSIX-compliant lightweight shell',
    version: '0.5.12',
    url: 'https://shiro.computer/bins/dash-x86_64-musl',
    size: 120_000,
    category: 'shell',
  },
  {
    name: 'tree',
    description: 'Display directory tree structure',
    version: '2.1.1',
    url: 'https://shiro.computer/bins/tree-x86_64-musl',
    size: 85_000,
    category: 'utility',
  },
  {
    name: 'file',
    description: 'Determine file type using magic numbers',
    version: '5.45',
    url: 'https://shiro.computer/bins/file-x86_64-musl',
    size: 580_000,
    category: 'utility',
  },
  {
    name: 'bc',
    description: 'Arbitrary precision calculator language',
    version: '6.7.5',
    url: 'https://shiro.computer/bins/bc-x86_64-musl',
    size: 210_000,
    category: 'utility',
  },
  {
    name: 'bash',
    description: 'GNU Bourne Again SHell',
    version: '5.2.21',
    url: 'https://shiro.computer/bins/bash-x86_64-musl',
    size: 1_200_000,
    category: 'shell',
  },
  {
    name: 'python3',
    description: 'CPython interpreter (minimal stdlib)',
    version: '3.12.3',
    url: 'https://shiro.computer/bins/python3-x86_64-musl',
    size: 5_800_000,
    category: 'language',
  },
];

// ── IndexedDB cache ──────────────────────────────────────────────────

const X86_CACHE_DB = 'shiro-x86-cache';
const X86_CACHE_STORE = 'elfs';
const X86_META_STORE = 'elf-metadata';
const X86_DB_VERSION = 1;

function openX86DB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(X86_CACHE_DB, X86_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(X86_CACHE_STORE)) {
        db.createObjectStore(X86_CACHE_STORE);
      }
      if (!db.objectStoreNames.contains(X86_META_STORE)) {
        db.createObjectStore(X86_META_STORE);
      }
    };
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | null> {
  try {
    const db = await openX86DB();
    return new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const req = s.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

async function idbPut(store: string, key: string, value: any): Promise<void> {
  try {
    const db = await openX86DB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      const req = s.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    // Non-fatal — cache miss next time
  }
}

async function idbDelete(store: string, key: string): Promise<void> {
  try {
    const db = await openX86DB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      const req = s.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    // Non-fatal
  }
}

async function idbGetAllKeys(store: string): Promise<string[]> {
  try {
    const db = await openX86DB();
    return new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const req = s.getAllKeys();
      req.onsuccess = () => resolve((req.result as string[]) || []);
      req.onerror = () => resolve([]);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return [];
  }
}

// ── ELF validation ──────────────────────────────────────────────────

/** ELF magic bytes: \x7fELF */
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];

function isValidElf(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data, 0, 4);
  return bytes[0] === ELF_MAGIC[0] &&
         bytes[1] === ELF_MAGIC[1] &&
         bytes[2] === ELF_MAGIC[2] &&
         bytes[3] === ELF_MAGIC[3];
}

// ── Public API ───────────────────────────────────────────────────────

/** Get package metadata from manifest by name or alias */
export function findX86Package(name: string): X86Package | undefined {
  return PACKAGE_MANIFEST.find(
    p => p.name === name || p.aliases?.includes(name) || p.applets?.includes(name)
  );
}

/** Search packages by query string (matches name and description) */
export function searchX86Packages(query: string): X86Package[] {
  const q = query.toLowerCase();
  return PACKAGE_MANIFEST.filter(
    p => p.name.includes(q) || p.description.toLowerCase().includes(q) ||
         p.category.includes(q) || (p.aliases || []).some(a => a.includes(q)) ||
         (p.applets || []).some(a => a.includes(q))
  );
}

/** List all available packages */
export function listX86Available(): X86Package[] {
  return [...PACKAGE_MANIFEST];
}

/** Get cached ELF binary. Returns null if not cached. */
export async function getCachedX86Package(name: string): Promise<ArrayBuffer | null> {
  return idbGet<ArrayBuffer>(X86_CACHE_STORE, name);
}

/** Download a package, cache it, and return the binary */
export async function downloadX86Package(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<ArrayBuffer> {
  // Resolve applet names to their parent package
  let pkg = PACKAGE_MANIFEST.find(p => p.name === name);
  if (!pkg) {
    pkg = PACKAGE_MANIFEST.find(p => p.applets?.includes(name));
    if (pkg) {
      // Applet — download the parent binary
      return downloadX86Package(pkg.name, onProgress);
    }
  }
  if (!pkg) {
    throw new Error(`Package '${name}' not found in x86 registry`);
  }

  // Check cache first
  const cached = await getCachedX86Package(pkg.name);
  if (cached) {
    onProgress?.(`${pkg.name} (cached)`);
    return cached;
  }

  // Download
  const sizeStr = pkg.size > 1_000_000
    ? `${(pkg.size / 1_000_000).toFixed(1)}MB`
    : `${(pkg.size / 1_000).toFixed(0)}KB`;
  onProgress?.(`Downloading ${pkg.name} v${pkg.version} (${sizeStr})...`);

  const resp = await fetch(pkg.url);
  if (!resp.ok) {
    throw new Error(`Failed to download ${pkg.name}: ${resp.status} ${resp.statusText}`);
  }
  const binary = await resp.arrayBuffer();

  // Validate ELF magic
  if (!isValidElf(binary)) {
    throw new Error(`Downloaded file for ${pkg.name} is not a valid ELF binary`);
  }

  // Cache for next time
  await idbPut(X86_CACHE_STORE, pkg.name, binary);
  await idbPut(X86_META_STORE, pkg.name, {
    name: pkg.name,
    version: pkg.version,
    installedAt: Date.now(),
    size: binary.byteLength,
  });

  onProgress?.(`Installed ${pkg.name} v${pkg.version}`);
  return binary;
}

/** Get package binary (from cache or download) */
export async function getX86Package(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<ArrayBuffer> {
  return downloadX86Package(name, onProgress);
}

/** List installed (cached) packages with metadata */
export async function listX86Installed(): Promise<Array<{ name: string; version: string; installedAt: number; size: number }>> {
  const keys = await idbGetAllKeys(X86_META_STORE);
  const results: Array<{ name: string; version: string; installedAt: number; size: number }> = [];
  for (const key of keys) {
    const meta = await idbGet<{ name: string; version: string; installedAt: number; size: number }>(X86_META_STORE, key);
    if (meta) results.push(meta);
  }
  return results;
}

/** Remove a package from cache */
export async function removeX86Package(name: string): Promise<void> {
  await idbDelete(X86_CACHE_STORE, name);
  await idbDelete(X86_META_STORE, name);
}

/** Check if a command name matches an available x86 package or applet */
export function isAvailableAsX86Package(cmdName: string): X86Package | undefined {
  return findX86Package(cmdName);
}

// ── Byte array cache (for executeElfFromBytes) ────────────────────

const elfBytesCache: Map<string, Uint8Array> = new Map();

/** Get an ELF binary as Uint8Array, ready for execution */
export async function getX86Binary(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<Uint8Array> {
  const cached = elfBytesCache.get(name);
  if (cached) return cached;

  const binary = await getX86Package(name, onProgress);
  const bytes = new Uint8Array(binary);
  elfBytesCache.set(name, bytes);
  return bytes;
}

/** Clear the ELF binary cache */
export function clearX86Cache(name?: string): void {
  if (name) {
    elfBytesCache.delete(name);
  } else {
    elfBytesCache.clear();
  }
}
