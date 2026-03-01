/**
 * wasi-packages.ts — WASM package registry and cache for Shiro
 *
 * Manages a registry of WASM+WASI binaries that can be downloaded on demand,
 * cached in IndexedDB, and executed through the WASI runtime.
 *
 * Uses the same IndexedDB caching pattern as build.ts (esbuild-wasm).
 */

// ── Package manifest types ───────────────────────────────────────────

export interface WasmPackage {
  /** Package name (used as command name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Version string */
  version: string;
  /** Download URL for the WASM binary */
  url: string;
  /** Size in bytes (approximate, for display) */
  size: number;
  /** Category for search/display */
  category: 'utility' | 'language' | 'tool' | 'game' | 'coreutil';
  /** Command aliases (alternative names this package provides) */
  aliases?: string[];
}

// ── Package manifest ─────────────────────────────────────────────────
// Hardcoded initially. URLs point to pre-compiled WASI binaries.
// These are real packages from the Wasmer/WAPM ecosystem.

const PACKAGE_MANIFEST: WasmPackage[] = [
  {
    name: 'cowsay',
    description: 'Generate ASCII pictures of a cow with a message',
    version: '0.2.0',
    url: 'https://registry-cdn.wapm.io/contents/syrusakbary/cowsay/0.2.0/target/wasm32-wasi/release/cowsay.wasm',
    size: 200_000,
    category: 'utility',
  },
  {
    name: 'fortune',
    description: 'Random fortune cookie messages',
    version: '0.1.0',
    url: 'https://registry-cdn.wapm.io/contents/syrusakbary/fortune/0.1.0/target/wasm32-wasi/release/fortune.wasm',
    size: 300_000,
    category: 'utility',
  },
  {
    name: 'qjs',
    description: 'QuickJS JavaScript engine (standalone)',
    version: '0.1.0',
    url: 'https://registry-cdn.wapm.io/contents/nicolo-ribaudo/qjs/0.0.1/build/qjs.wasm',
    size: 1_200_000,
    category: 'language',
  },
  {
    name: 'lolcat',
    description: 'Rainbows and unicorns in your terminal',
    version: '0.1.0',
    url: 'https://registry-cdn.wapm.io/contents/nicolo-ribaudo/lolcat/0.1.0/lolcat.wasm',
    size: 150_000,
    category: 'utility',
  },
  {
    name: 'figlet',
    description: 'Create large ASCII text banners',
    version: '0.1.0',
    url: 'https://registry-cdn.wapm.io/contents/syrusakbary/figlet/0.1.0/target/wasm32-wasi/release/figlet.wasm',
    size: 400_000,
    category: 'utility',
  },
  {
    name: 'slug',
    description: 'Convert strings to URL-friendly slugs',
    version: '0.1.0',
    url: 'https://registry-cdn.wapm.io/contents/syrusakbary/slug/0.1.0/slug.wasm',
    size: 80_000,
    category: 'utility',
  },
];

// ── IndexedDB cache ──────────────────────────────────────────────────

const PKG_CACHE_DB = 'shiro-pkg-cache';
const PKG_CACHE_STORE = 'packages';
const PKG_META_STORE = 'metadata';
const PKG_DB_VERSION = 1;

function openPkgDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PKG_CACHE_DB, PKG_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PKG_CACHE_STORE)) {
        db.createObjectStore(PKG_CACHE_STORE);
      }
      if (!db.objectStoreNames.contains(PKG_META_STORE)) {
        db.createObjectStore(PKG_META_STORE);
      }
    };
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | null> {
  try {
    const db = await openPkgDB();
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
    const db = await openPkgDB();
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
    const db = await openPkgDB();
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
    const db = await openPkgDB();
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

// ── Public API ───────────────────────────────────────────────────────

/** Get package metadata from manifest by name or alias */
export function findPackage(name: string): WasmPackage | undefined {
  return PACKAGE_MANIFEST.find(
    p => p.name === name || p.aliases?.includes(name)
  );
}

/** Search packages by query string (matches name and description) */
export function searchPackages(query: string): WasmPackage[] {
  const q = query.toLowerCase();
  return PACKAGE_MANIFEST.filter(
    p => p.name.includes(q) || p.description.toLowerCase().includes(q) ||
         p.category.includes(q) || (p.aliases || []).some(a => a.includes(q))
  );
}

/** List all available packages */
export function listAvailable(): WasmPackage[] {
  return [...PACKAGE_MANIFEST];
}

/** Get cached WASM binary. Returns null if not cached. */
export async function getCachedPackage(name: string): Promise<ArrayBuffer | null> {
  return idbGet<ArrayBuffer>(PKG_CACHE_STORE, name);
}

/** Download a package, cache it, and return the binary */
export async function downloadPackage(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<ArrayBuffer> {
  const pkg = findPackage(name);
  if (!pkg) {
    throw new Error(`Package '${name}' not found in registry`);
  }

  // Check cache first
  const cached = await getCachedPackage(pkg.name);
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

  // Validate WASM magic
  const magic = new Uint8Array(binary, 0, 4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new Error(`Downloaded file for ${pkg.name} is not a valid WASM binary`);
  }

  // Cache for next time
  await idbPut(PKG_CACHE_STORE, pkg.name, binary);
  await idbPut(PKG_META_STORE, pkg.name, {
    name: pkg.name,
    version: pkg.version,
    installedAt: Date.now(),
    size: binary.byteLength,
  });

  onProgress?.(`Installed ${pkg.name} v${pkg.version}`);
  return binary;
}

/** Get package binary (from cache or download) */
export async function getPackage(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<ArrayBuffer> {
  return downloadPackage(name, onProgress);
}

/** List installed (cached) packages with metadata */
export async function listInstalled(): Promise<Array<{ name: string; version: string; installedAt: number; size: number }>> {
  const keys = await idbGetAllKeys(PKG_META_STORE);
  const results: Array<{ name: string; version: string; installedAt: number; size: number }> = [];
  for (const key of keys) {
    const meta = await idbGet<{ name: string; version: string; installedAt: number; size: number }>(PKG_META_STORE, key);
    if (meta) results.push(meta);
  }
  return results;
}

/** Remove a package from cache */
export async function removePackage(name: string): Promise<void> {
  await idbDelete(PKG_CACHE_STORE, name);
  await idbDelete(PKG_META_STORE, name);
}

/** Check if a command name matches an available package */
export function isAvailableAsPackage(cmdName: string): WasmPackage | undefined {
  return findPackage(cmdName);
}
