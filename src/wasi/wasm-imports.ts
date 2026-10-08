/**
 * wasm-imports.ts — read the imported memory's limits from a WASM binary.
 *
 * Threaded modules (wasi-threads) import a shared memory that the host must
 * create with matching limits before the first instance, and JS reflection
 * (WebAssembly.Module.imports) does not report limits.
 */

export interface MemoryImport {
  module: string;
  name: string;
  initial: number;
  maximum?: number;
  shared: boolean;
}

export function findMemoryImport(bytes: Uint8Array): MemoryImport | null {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
  let p = 8;
  const leb = (): number => {
    let result = 0, shift = 0, b: number;
    do { b = bytes[p++]; result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return result;
  };
  const name = (): string => {
    const len = leb();
    const s = new TextDecoder().decode(bytes.subarray(p, p + len));
    p += len;
    return s;
  };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = leb();
    const end = p + size;
    if (id !== 2) { p = end; continue; }
    const count = leb();
    for (let i = 0; i < count; i++) {
      const mod = name();
      const field = name();
      const kind = bytes[p++];
      if (kind === 0) { leb(); continue; }                 // function: type index
      if (kind === 1) { p++; const f = bytes[p++]; leb(); if (f & 1) leb(); continue; } // table
      if (kind === 3) { p += 2; continue; }               // global: valtype, mut
      if (kind === 4) { p++; leb(); continue; }            // tag
      if (kind === 2) {
        const flags = bytes[p++];
        const initial = leb();
        const maximum = flags & 1 ? leb() : undefined;
        return { module: mod, name: field, initial, maximum, shared: (flags & 2) !== 0 };
      }
      return null;
    }
    return null;
  }
  return null;
}
