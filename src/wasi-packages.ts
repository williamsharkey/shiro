/**
 * wasi-packages.ts — WASM package registry and cache for Shiro
 *
 * Manages a registry of WASM+WASI binaries that can be downloaded on demand,
 * cached in IndexedDB, and executed through the WASI runtime.
 *
 * Uses the same IndexedDB caching pattern as build.ts (esbuild-wasm).
 */

import { builtinIndex, findEntry, searchIndex, resolveUrl, sha256Hex, type PkgEntry } from './pkg-manager';
import { isWebc, parseWebc } from './webc';

// ── Package view ─────────────────────────────────────────────────────
// The package list lives in src/pkg-index.json (see pkg-manager.ts). This
// module keeps the older single-binary API used by `wasi exec`, the `lua`
// builtin's WASI fallback, and `#!wasi-pkg` stubs: one command's wasm,
// cached in IndexedDB, without installing anything into the filesystem.

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
  /** Category for search/display (the index section) */
  category: string;
  /** Command aliases (alternative names this package provides) */
  aliases?: string[];
  /** Format of the download: 'wasm' (raw binary) or 'webc' (wasmer container) */
  format?: 'wasm' | 'webc';
}

/** The file a package's main command runs, and the download it comes from. */
function mainFile(entry: PkgEntry, cmd?: string) {
  const bin = (cmd && entry.bin[cmd]) || entry.bin[entry.name] || Object.values(entry.bin)[0];
  return entry.files.find(f => f.path === bin.file)!;
}

/** Packages this single-binary API can fetch: the main command is one file, not part of a tarball. */
const singleFile = (entry: PkgEntry) => { const f = entry.files.find(x => x.path === ((entry.bin[entry.name] || Object.values(entry.bin)[0])?.file)); return !!f && !f.tar; };

function toWasmPackage(entry: PkgEntry): WasmPackage {
  const f = mainFile(entry);
  return {
    name: entry.name,
    description: entry.description,
    version: entry.version,
    url: f.url,
    size: f.size,
    category: entry.section,
    aliases: Object.keys(entry.bin).filter(b => b !== entry.name),
    format: f.webc ? 'webc' : 'wasm',
  };
}

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
 * Extract a WASM binary from a Wasmer WebC container: the entrypoint atom
 * (or the largest one) of a real WebC v2/v3 file. Anything else is scanned
 * for the WASM magic bytes (\0asm), returning the largest module found, or
 * null when there is none.
 */
export function extractWasmFromWebc(webc: ArrayBuffer): ArrayBuffer | null {
  const bytes = new Uint8Array(webc);
  if (isWebc(bytes)) {
    try {
      const pkg = parseWebc(bytes);
      const entry = pkg.manifest?.entrypoint;
      const atom = (typeof entry === 'string' && pkg.atoms.get(entry)) ||
        [...pkg.atoms.values()].reduce<Uint8Array | null>((a, b) => (a && a.length >= b.length ? a : b), null);
      if (atom) return atom.slice().buffer;
    } catch { /* fall back to scanning */ }
  }
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

/** Get package metadata by name or command name */
export function findPackage(name: string): WasmPackage | undefined {
  const entry = findEntry(builtinIndex(), name);
  return entry && singleFile(entry) ? toWasmPackage(entry) : undefined;
}

/** Search packages by query string (matches name, description, section, commands) */
export function searchPackages(query: string): WasmPackage[] {
  return searchIndex(builtinIndex(), query).filter(singleFile).map(toWasmPackage);
}

/** List all available packages */
export function listAvailable(): WasmPackage[] {
  return builtinIndex().packages.filter(singleFile).map(toWasmPackage);
}

/** Get cached WASM binary. Returns null if not cached. */
export async function getCachedPackage(name: string): Promise<ArrayBuffer | null> {
  return idbGet<ArrayBuffer>(PKG_CACHE_STORE, name);
}

/** Download a package's main binary (sha256-verified), cache it, and return it */
export async function downloadPackage(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<ArrayBuffer> {
  const entry = findEntry(builtinIndex(), name);
  if (!entry) {
    throw new Error(`Package '${name}' not found in registry`);
  }

  const cached = await getCachedPackage(entry.name);
  if (cached) {
    onProgress?.(`${entry.name} (cached)`);
    return cached;
  }

  const file = mainFile(entry, name);
  const sizeStr = file.size > 1_000_000
    ? `${(file.size / 1_000_000).toFixed(1)}MB`
    : `${(file.size / 1_000).toFixed(0)}KB`;
  onProgress?.(`Downloading ${entry.name} v${entry.version} (${sizeStr})...`);

  const resp = await fetch(resolveUrl(file.url));
  if (!resp.ok) {
    throw new Error(`Failed to download ${entry.name}: ${resp.status} ${resp.statusText}`);
  }
  const raw = new Uint8Array(await resp.arrayBuffer());
  const got = await sha256Hex(raw);
  if (got !== file.sha256) {
    throw new Error(`sha256 mismatch for ${entry.name}: expected ${file.sha256}, got ${got}`);
  }

  let binary: ArrayBuffer;
  if (file.webc?.atom) {
    const atom = parseWebc(raw).atoms.get(file.webc.atom);
    if (!atom) throw new Error(`No atom ${file.webc.atom} in ${entry.name} WebC container`);
    binary = atom.slice().buffer;
  } else {
    binary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  }

  // Validate WASM magic
  const magic = new Uint8Array(binary, 0, 4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new Error(`Downloaded file for ${entry.name} is not a valid WASM binary`);
  }

  await idbPut(PKG_CACHE_STORE, entry.name, binary);
  await idbPut(PKG_META_STORE, entry.name, {
    name: entry.name,
    version: entry.version,
    installedAt: Date.now(),
    size: binary.byteLength,
  });

  onProgress?.(`Cached ${entry.name} v${entry.version}`);
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
