/**
 * dyncall.ts — WASIX dynamic calls: reflect_signature, call_dynamic and
 * closures (closure_allocate / closure_prepare / closure_free), which libffi
 * and CPython's WASIX build use to call function pointers whose types they
 * only know at run time.
 *
 * JS can't ask a funcref for its type, but a module's own functions show up
 * in its table as exported-function objects whose `name` is the function
 * index, so the types come from the module's type, import and function
 * sections (`readFuncSigs`, done once by the host). Closures are small
 * generated modules that re-export a JS function with the requested type,
 * which makes it a wasm function the table accepts.
 */

/** Value types as WASIX numbers them (__wasi_wasm_value_type_t). */
const WASIX_TYPES: Record<number, string> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128' };
const WASIX_CODE: Record<string, number> = { i32: 0, i64: 1, f32: 2, f64: 3, v128: 4 };
const BINARY_CODE: Record<string, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
const SIZE: Record<string, number> = { i32: 4, i64: 8, f32: 4, f64: 8, v128: 16 };

export interface FuncSig { params: string[]; results: string[] }

/** Function signatures of a module: `types` by type index, `funcTypes[funcIndex]` = type index. */
export interface FuncSigs { types: FuncSig[]; funcTypes: Uint32Array }

/** Parse the type, import and function sections of a module binary. */
export function readFuncSigs(bytes: Uint8Array): FuncSigs | null {
  let p = 8;
  const leb = () => {
    let r = 0, shift = 0, x: number;
    do { x = bytes[p++]; r += (x & 0x7f) * 2 ** shift; shift += 7; } while (x & 0x80);
    return r;
  };
  const skipName = () => { const n = leb(); p += n; };
  const types: FuncSig[] = [];
  const funcs: number[] = [];
  const valtype = (t: number) => WASIX_TYPES[t] ?? `ref${t}`;
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = leb();
    const end = p + size;
    if (id === 1) {
      for (let n = leb(); n > 0; n--) {
        const form = bytes[p++];
        if (form !== 0x60) return null; // GC/rec types: not a module we can describe
        const params: string[] = [], results: string[] = [];
        for (let k = leb(); k > 0; k--) params.push(valtype(bytes[p++]));
        for (let k = leb(); k > 0; k--) results.push(valtype(bytes[p++]));
        types.push({ params, results });
      }
    } else if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        skipName(); skipName();
        const kind = bytes[p++];
        if (kind === 0) funcs.push(leb());
        else if (kind === 1) { p++; const fl = leb(); leb(); if (fl & 1) leb(); }          // table: reftype, limits
        else if (kind === 2) { const fl = leb(); leb(); if (fl & 1) leb(); }               // memory: limits
        else if (kind === 3) { p += 2; }                                                    // global: valtype, mut
        else if (kind === 4) { p++; leb(); }                                                // tag: attribute, type
        else return null;
      }
    } else if (id === 3) {
      for (let n = leb(); n > 0; n--) funcs.push(leb());
    } else if (id > 3 && id !== 0) {
      if (id >= 10) break; // code and later: nothing more we need
    }
    p = end;
  }
  return { types, funcTypes: Uint32Array.from(funcs) };
}

/** Runs WASIX dynamic calls against one instance's table and memory. */
export class DynCalls {
  private closures = new Map<number, FuncSig>();
  private closureModules = new Map<string, WebAssembly.Module>();

  constructor(
    private sigs: FuncSigs,
    private table: () => WebAssembly.Table | undefined,
    private memory: () => WebAssembly.Memory,
    /** Move the guest's shadow stack pointer (closures marshal their arguments there). */
    private stackPointer: () => WebAssembly.Global | undefined,
  ) {}

  sigOf(fid: number): FuncSig | null {
    const closure = this.closures.get(fid);
    if (closure) return closure;
    const f = this.table()?.get(fid) as ((...a: unknown[]) => unknown) | null;
    if (!f) return null;
    const idx = Number(f.name);
    if (!Number.isInteger(idx) || idx >= this.sigs.funcTypes.length) return null;
    return this.sigs.types[this.sigs.funcTypes[idx]] ?? null;
  }

  /** reflect_signature: returns a WASI errno. */
  reflect(fid: number, argPtr: number, argLen: number, resPtr: number, resLen: number, retPtr: number): number {
    const sig = this.sigOf(fid);
    if (!sig || ![...sig.params, ...sig.results].every(t => t in WASIX_CODE)) return 28; // EINVAL
    const v = new DataView(this.memory().buffer);
    v.setUint8(retPtr, this.closures.has(fid) ? 0 : 1);
    v.setUint16(retPtr + 2, sig.params.length, true);
    v.setUint16(retPtr + 4, sig.results.length, true);
    if ((argLen && argLen < sig.params.length) || (resLen && resLen < sig.results.length)) return 61; // EOVERFLOW
    if (argLen) sig.params.forEach((t, i) => v.setUint8(argPtr + i, WASIX_CODE[t]));
    if (resLen) sig.results.forEach((t, i) => v.setUint8(resPtr + i, WASIX_CODE[t]));
    return 0;
  }

  /** call_dynamic: returns a WASI errno. Exceptions from the callee (wasm EH, exits) propagate. */
  call(fid: number, valuesPtr: number, valuesLen: number, resultsPtr: number, resultsLen: number, strict: boolean): number {
    const sig = this.sigOf(fid);
    const f = this.table()?.get(fid) as ((...a: unknown[]) => unknown) | null;
    if (!sig || !f) return 28;
    if (sig.params.some(t => !(t in BINARY_CODE)) || sig.results.some(t => !(t in BINARY_CODE))) return 58; // ENOTSUP
    const need = sig.params.reduce((s, t) => s + SIZE[t], 0);
    const give = sig.results.reduce((s, t) => s + SIZE[t], 0);
    if (strict && (valuesLen !== need || resultsLen !== give)) return 28;
    const args = this.load(sig.params, valuesPtr, valuesLen);
    const out = f(...args);
    this.store(sig.results, sig.results.length === 1 ? [out] : (out as unknown[]) ?? [], resultsPtr, resultsLen);
    return 0;
  }

  closureAllocate(retPtr: number): number {
    const table = this.table();
    if (!table) return 52; // ENOSYS: no table to put it in
    const idx = table.grow(1);
    new DataView(this.memory().buffer).setUint32(retPtr, idx, true);
    return 0;
  }

  /**
   * closure_prepare: slot `closureId` becomes a function of the given type
   * that calls backing(values, results, userData) with its arguments packed
   * as for call_dynamic.
   */
  closurePrepare(backingId: number, closureId: number, argPtr: number, argLen: number, resPtr: number, resLen: number, userData: number): number {
    const table = this.table();
    if (!table) return 52;
    const m = new Uint8Array(this.memory().buffer);
    const decode = (ptr: number, n: number) => Array.from(m.subarray(ptr, ptr + n), c => Object.keys(WASIX_CODE).find(k => WASIX_CODE[k] === c) ?? '?');
    const sig: FuncSig = { params: decode(argPtr, argLen), results: decode(resPtr, resLen) };
    if ([...sig.params, ...sig.results].some(t => !(t in BINARY_CODE))) return 28;
    const backing = () => table.get(backingId) as ((values: number, results: number, user: number) => void) | null;
    const host = (...args: unknown[]) => {
      const sp = this.stackPointer();
      const inSize = sig.params.reduce((s, t) => s + SIZE[t], 0);
      const outSize = sig.results.reduce((s, t) => s + SIZE[t], 0);
      const saved = sp ? (sp.value as number) : 0;
      const base = sp ? ((saved - inSize - outSize) & ~15) : 0;
      if (!sp) throw new Error('closure call needs __stack_pointer');
      sp.value = base;
      try {
        this.store(sig.params, args, base, inSize);
        const fn = backing();
        if (!fn) throw new Error('closure backing function is gone');
        fn(base, base + inSize, userData);
        const res = this.load(sig.results, base + inSize, outSize);
        return sig.results.length === 0 ? undefined : sig.results.length === 1 ? res[0] : res;
      } finally {
        sp.value = saved;
      }
    };
    table.set(closureId, this.wrap(sig, host));
    this.closures.set(closureId, sig);
    return 0;
  }

  closureFree(closureId: number): number {
    this.closures.delete(closureId);
    try { this.table()?.set(closureId, null); } catch { /* out of range */ }
    return 0;
  }

  private load(types: string[], ptr: number, len: number): unknown[] {
    const v = new DataView(this.memory().buffer);
    const out: unknown[] = [];
    let off = 0;
    for (const t of types) {
      const fits = off + SIZE[t] <= len;
      if (t === 'i32') out.push(fits ? v.getInt32(ptr + off, true) : 0);
      else if (t === 'i64') out.push(fits ? v.getBigInt64(ptr + off, true) : 0n);
      else if (t === 'f32') out.push(fits ? v.getFloat32(ptr + off, true) : 0);
      else out.push(fits ? v.getFloat64(ptr + off, true) : 0);
      off += SIZE[t];
    }
    return out;
  }

  private store(types: string[], values: unknown[], ptr: number, len: number): void {
    const v = new DataView(this.memory().buffer);
    let off = 0;
    types.forEach((t, i) => {
      if (off + SIZE[t] > len) return;
      const x = values[i];
      if (t === 'i32') v.setInt32(ptr + off, Number(x) | 0, true);
      else if (t === 'i64') v.setBigInt64(ptr + off, BigInt.asIntN(64, typeof x === 'bigint' ? x : BigInt(Math.trunc(Number(x) || 0))), true);
      else if (t === 'f32') v.setFloat32(ptr + off, Number(x), true);
      else v.setFloat64(ptr + off, Number(x), true);
      off += SIZE[t];
    });
  }

  /** A wasm function of type `sig` that calls `fn`: a one-import module re-exporting it. */
  private wrap(sig: FuncSig, fn: (...a: unknown[]) => unknown): WebAssembly.ExportValue {
    const key = sig.params.join(',') + '>' + sig.results.join(',');
    let mod = this.closureModules.get(key);
    if (!mod) {
      const vec = (xs: number[]) => [xs.length, ...xs];
      const str = (s: string) => [s.length, ...Array.from(s, c => c.charCodeAt(0))];
      const sec = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
      const type = [0x60, ...vec(sig.params.map(t => BINARY_CODE[t])), ...vec(sig.results.map(t => BINARY_CODE[t]))];
      mod = new WebAssembly.Module(new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...sec(1, [1, ...type]),
        ...sec(2, [1, ...str('e'), ...str('f'), 0x00, 0]),
        ...sec(7, [1, ...str('f'), 0x00, 0]),
      ]));
      this.closureModules.set(key, mod);
    }
    return new WebAssembly.Instance(mod, { e: { f: fn } }).exports.f;
  }
}

function uleb(n: number): number[] {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
