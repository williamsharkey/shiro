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
  /** Download URL for the WASM binary or webc container */
  url: string;
  /** Size in bytes (approximate, for display) */
  size: number;
  /** Category for search/display */
  category: 'utility' | 'language' | 'tool' | 'game' | 'coreutil';
  /** Command aliases (alternative names this package provides) */
  aliases?: string[];
  /** Format of the download: 'wasm' (raw binary) or 'webc' (wasmer container) */
  format?: 'wasm' | 'webc';
}

// ── Package manifest ─────────────────────────────────────────────────
// URLs point to cdn.wasmer.io webc containers. WASM is extracted at download time.
// Verified working as of 2025-06.

const PACKAGE_MANIFEST: WasmPackage[] = [
  // ── Fun / Demo ───────────────────────────────────────────────────
  {
    name: 'cowsay',
    description: 'Generate ASCII pictures of a cow with a message',
    version: '0.3.0',
    url: 'https://cdn.wasmer.io/webcimages/c7e7487ac3a41c18862f0bc76e8af0def0f12c4167d6fce5c1cc1b5d061f6bb7.webc',
    size: 776_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'fortune',
    description: 'Random fortune cookie messages',
    version: '0.2.0',
    url: 'https://cdn.wasmer.io/webcimages/59c02fd68e98da2c445ee8e97098aff1038ef7aa237601b2a099e734a99ef49d.webc',
    size: 2_417_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'lolcat',
    description: 'Rainbows and unicorns in your terminal',
    version: '0.2.0',
    url: 'https://cdn.wasmer.io/webcimages/b867558fee3734d9c77a9bdc38abcfc0793bfbad0e901639a192641d5a34bdb7.webc',
    size: 2_131_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'figlet',
    description: 'Create large ASCII text banners',
    version: '0.0.1',
    url: 'https://cdn.wasmer.io/webcimages/9fc959de4ce58c6c2bc11b8cbaa0a1a471bcde84a0fe341cffc25a42251d91c9.webc',
    size: 769_000,
    category: 'utility',
    format: 'webc',
  },
  // ── Core Utilities ───────────────────────────────────────────────
  {
    name: 'coreutils',
    description: '90+ GNU coreutils: ls, cat, head, tail, wc, sort, base64, hashsum, etc.',
    version: '1.0.16',
    url: 'https://cdn.wasmer.io/webcimages/59b01ca057218b8ab51cab83546d22b729e015d6cf519b2383cc68bce67ef750.webc',
    size: 4_796_000,
    category: 'coreutil',
    aliases: ['gls', 'gcat', 'ghead', 'gtail', 'gwc', 'gsort', 'guniq', 'gbase64', 'ghashsum'],
    format: 'webc',
  },
  {
    name: 'grep',
    description: 'Search files for patterns (GNU grep)',
    version: '3.12.0',
    url: 'https://cdn.wasmer.io/webcimages/42a2dd5452990c94a51036cfb5eb9574899beccb5ce8f83f75995f7ac5e0e1ca.webc',
    size: 365_000,
    category: 'coreutil',
    aliases: ['wasm-grep'],
    format: 'webc',
  },
  {
    name: 'sed',
    description: 'Stream editor for text transformation (GNU sed)',
    version: '4.9.0',
    url: 'https://cdn.wasmer.io/webcimages/3fc12256be87f6b8b7810d68d642359a6220f63b39a2ea6ef7a2bb6d79ec1393.webc',
    size: 263_000,
    category: 'coreutil',
    aliases: ['wasm-sed'],
    format: 'webc',
  },
  // ── Languages ────────────────────────────────────────────────────
  {
    name: 'quickjs',
    description: 'QuickJS JavaScript engine (standalone)',
    version: '0.0.3',
    url: 'https://cdn.wasmer.io/webcimages/430237aeffc912f4cd0981eb03ebad42a71d6b62781bd0c01903cae7d21b5733.webc',
    size: 2_565_000,
    category: 'language',
    aliases: ['qjs'],
    format: 'webc',
  },
  {
    name: 'lua',
    description: 'Lua scripting language interpreter',
    version: '0.1.4',
    url: 'https://cdn.wasmer.io/webcimages/44324fc895e8be1cbe46368f78053c982052d82a9dbbbc1feac8c0a75bec1176.webc',
    size: 522_000,
    category: 'language',
    format: 'webc',
  },
  // ── Tools ────────────────────────────────────────────────────────
  {
    name: 'sqlite',
    description: 'SQLite database command-line shell',
    version: '0.2.2',
    url: 'https://cdn.wasmer.io/webcimages/435044351ae60f7fd07ff97c1cac083f1e46d43bd9bc811b249bb376ee328725.webc',
    size: 3_576_000,
    category: 'tool',
    aliases: ['sqlite3'],
    format: 'webc',
  },
  {
    name: 'viu',
    description: 'View images in the terminal (PNG, JPG, GIF, BMP)',
    version: '0.2.3',
    url: 'https://cdn.wasmer.io/webcimages/b988b51ee1a395853fa402f37d69d1b379c4441b3bfca7372876098e13d4e3e9.webc',
    size: 3_066_000,
    category: 'tool',
    format: 'webc',
  },
  {
    name: 'util-linux',
    description: 'Linux utilities: hexdump, cal, rev, col',
    version: '0.0.1',
    url: 'https://cdn.wasmer.io/webcimages/3af9902aebda64554afa9b05c8726d3d183ba5c1ac57d902637e3894f3187c98.webc',
    size: 543_000,
    category: 'utility',
    aliases: ['hexdump', 'cal', 'rev'],
    format: 'webc',
  },
  // ── Shells ──────────────────────────────────────────────────────────
  {
    name: 'dash',
    description: 'Debian Almquist shell (POSIX-compliant, fast)',
    version: '1.0.19',
    url: 'https://cdn.wasmer.io/webcimages/c81513a53f11a2a23ea305fa008049d15fa1b5f52b696cedbf63554077ea5998.webc',
    size: 335_000,
    category: 'tool',
    format: 'webc',
  },
  {
    name: 'bash',
    description: 'GNU Bourne-Again Shell',
    version: '1.0.25',
    url: 'https://cdn.wasmer.io/webcimages/059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1.webc',
    size: 1_200_000,
    category: 'tool',
    format: 'webc',
  },
  // ── Languages (additional) ──────────────────────────────────────────
  {
    name: 'ruby',
    description: 'Ruby programming language interpreter',
    version: '0.1.2',
    url: 'https://cdn.wasmer.io/webcimages/036c313a707ffc5b70c700a9ac44e07bb76efe2797ef7f69c8f5d38fc6a080fc.webc',
    size: 34_300_000,
    category: 'language',
    aliases: ['irb'],
    format: 'webc',
  },
  {
    name: 'php',
    description: 'PHP 8.3 scripting language interpreter',
    version: '8.3.403',
    url: 'https://cdn.wasmer.io/webcimages/da8d3fcfcf02d2401787532c4af3fdaf5b680b05144a9591ca70b97131ee2f32.webc',
    size: 10_000_000,
    category: 'language',
    format: 'webc',
  },
  // ── Developer Tools ─────────────────────────────────────────────────
  {
    name: 'openssl',
    description: 'Cryptographic toolkit (md5, sha256, base64, encryption)',
    version: '0.2.0',
    url: 'https://cdn.wasmer.io/webcimages/ac3a7fa2a57d384fa9e4b30c935a99fa323193cd1b7421bb899dfc2864ec43cc.webc',
    size: 1_600_000,
    category: 'tool',
    format: 'webc',
  },
  {
    name: 'wabt',
    description: 'WebAssembly Binary Toolkit: wat2wasm, wasm2wat, wasm-validate',
    version: '1.0.37',
    url: 'https://cdn.wasmer.io/webcimages/28b90a71338d161324ec4187d7afeb08df0eb98181e7e51c83f3f3f9a4cd1522.webc',
    size: 3_400_000,
    category: 'tool',
    aliases: ['wat2wasm', 'wasm2wat', 'wasm-validate', 'wasm-strip'],
    format: 'webc',
  },
  {
    name: 'brotli',
    description: 'Brotli compression and decompression',
    version: '0.0.1',
    url: 'https://cdn.wasmer.io/webcimages/824ad12803f95ed9a963f0e68df7ab3f1b875387f84417390ec73df52b3b2fb0.webc',
    size: 707_000,
    category: 'tool',
    format: 'webc',
  },
  {
    name: 'uuid',
    description: 'Generate UUIDs (v1, v4)',
    version: '0.3.0',
    url: 'https://cdn.wasmer.io/webcimages/bcfcf285510b75a47156a46c8103593a44047acf892114c83344138a0dc0effc.webc',
    size: 2_400_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'qr2text',
    description: 'Generate QR codes as ASCII text',
    version: '0.0.1',
    url: 'https://cdn.wasmer.io/webcimages/3741fc7486de905f87bcf8829557260473b0b789c0ec362d9374fd36f4fb62c6.webc',
    size: 499_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'optipng',
    description: 'PNG optimizer — lossless image compression',
    version: '0.1.2',
    url: 'https://cdn.wasmer.io/webcimages/ee84c20006bd67d128c67877c9ccaa8ba669a7cbd94ab225fafa241c5552ba8e.webc',
    size: 231_000,
    category: 'tool',
    format: 'webc',
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

// ── WebC extraction ─────────────────────────────────────────────────

/** WASM magic bytes: \0asm */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/**
 * Extract a WASM binary from a Wasmer WebC container.
 * Scans for the WASM magic bytes (\0asm) and returns the largest
 * contiguous WASM module found. If none found, returns null.
 */
export function extractWasmFromWebc(webc: ArrayBuffer): ArrayBuffer | null {
  const bytes = new Uint8Array(webc);
  const candidates: ArrayBuffer[] = [];

  for (let i = 0; i <= bytes.length - 8; i++) {
    if (
      bytes[i] === WASM_MAGIC[0] &&
      bytes[i + 1] === WASM_MAGIC[1] &&
      bytes[i + 2] === WASM_MAGIC[2] &&
      bytes[i + 3] === WASM_MAGIC[3] &&
      // WASM version 1
      bytes[i + 4] === 0x01 &&
      bytes[i + 5] === 0x00 &&
      bytes[i + 6] === 0x00 &&
      bytes[i + 7] === 0x00
    ) {
      // Walk WASM sections to find exact end of module
      const moduleEnd = findWasmModuleEnd(bytes, i);
      if (moduleEnd > i + 8) {
        candidates.push(webc.slice(i, moduleEnd));
      }
    }
  }

  if (candidates.length === 0) return null;
  // Return the largest WASM module (the main binary, not embedded metadata)
  return candidates.reduce((a, b) => a.byteLength > b.byteLength ? a : b);
}

/**
 * Walk WASM sections from `offset` to find where the module ends.
 * Each section: 1-byte id + LEB128 size + `size` bytes of payload.
 */
function findWasmModuleEnd(bytes: Uint8Array, offset: number): number {
  let pos = offset + 8; // skip magic + version
  while (pos < bytes.length) {
    if (pos >= bytes.length) break;
    const sectionId = bytes[pos++];
    if (sectionId > 12) break; // invalid section ID — we've passed the end
    // Read LEB128 size
    const { value: sectionSize, bytesRead } = readLEB128(bytes, pos);
    if (bytesRead === 0 || sectionSize < 0) break;
    pos += bytesRead;
    pos += sectionSize;
    if (pos > bytes.length) break; // section extends beyond buffer
  }
  return pos;
}

function readLEB128(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < bytes.length) {
    const byte = bytes[offset + bytesRead];
    result |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) return { value: -1, bytesRead: 0 }; // overflow
  }
  return { value: result, bytesRead };
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
  const raw = await resp.arrayBuffer();

  // Extract WASM from WebC container if needed
  let binary: ArrayBuffer;
  if (pkg.format === 'webc') {
    onProgress?.(`Extracting WASM from WebC container...`);
    const extracted = extractWasmFromWebc(raw);
    if (!extracted) {
      throw new Error(`Failed to extract WASM binary from ${pkg.name} WebC container`);
    }
    binary = extracted;
  } else {
    binary = raw;
  }

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

// ── Compiled module cache ─────────────────────────────────────────

const moduleCache: Map<string, WebAssembly.Module> = new Map();

/**
 * Get a compiled WebAssembly.Module for a package (from memory cache or compile).
 * Caches the compiled module in memory for subsequent runs — skips compilation.
 */
export async function getCompiledModule(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<WebAssembly.Module> {
  const cached = moduleCache.get(name);
  if (cached) return cached;

  const binary = await getPackage(name, onProgress);
  const mod = await WebAssembly.compile(binary);
  moduleCache.set(name, mod);
  return mod;
}

/** Clear the compiled module cache (e.g., after package removal) */
export function clearModuleCache(name?: string): void {
  if (name) {
    moduleCache.delete(name);
  } else {
    moduleCache.clear();
  }
}
