/**
 * dylink.ts — load position-independent WASM main modules (the wasm-ld
 * `-pie` / emscripten "dylink.0" conventions), as WASIX's dynamically
 * linked builds are (python).
 *
 * Such a module imports what a static one defines itself: the function
 * table (`env.__indirect_function_table`), where its data and elements go
 * (`env.__memory_base`, `env.__table_base`), the stack pointer, and GOT
 * entries (`GOT.mem.*`, `GOT.func.*`) for symbols it may not define. Its
 * `dylink.0` custom section says how much memory and table it needs.
 *
 * Layout (one process): data at MEMORY_BASE, then a STACK_SIZE stack; the
 * heap (sbrk / memory.grow) starts above the initial memory. Every thread
 * instantiates the module against the same shared memory with its own table
 * (tables can't be shared between Workers; the element segments fill each
 * one identically), and only the main thread applies data relocations.
 *
 * Shared libraries (dlopen of side modules) are not loaded: WASIX dlopen
 * fails with ENOSYS, which programs treat as "library not found".
 */

export interface DylinkInfo {
  memSize: number;
  memAlign: number;
  tableSize: number;
  tableAlign: number;
  needed: string[];
}

/** Where a PIE module's pieces go (computed once per process by the host). */
export interface DylinkLayout {
  memoryBase: number;
  tableBase: number;
  tableSize: number;
  stackLow: number;
  stackHigh: number;
  /** Memory pages the layout needs at least. */
  minPages: number;
}

const MEMORY_BASE = 1024;
const STACK_SIZE = 8 << 20;

/** The module's dylink.0 section, or null for an ordinary (static) module. */
export function readDylink(module: WebAssembly.Module): DylinkInfo | null {
  const sec = WebAssembly.Module.customSections(module, 'dylink.0')[0];
  if (!sec) return null;
  const b = new Uint8Array(sec);
  let p = 0;
  const leb = () => {
    let r = 0, shift = 0, x: number;
    do { x = b[p++]; r += (x & 0x7f) * 2 ** shift; shift += 7; } while (x & 0x80);
    return r;
  };
  const str = () => { const n = leb(); const s = new TextDecoder().decode(b.subarray(p, p + n)); p += n; return s; };
  const info: DylinkInfo = { memSize: 0, memAlign: 0, tableSize: 0, tableAlign: 0, needed: [] };
  while (p < b.length) {
    const id = b[p++];
    const len = leb();
    const end = p + len;
    if (id === 1) { // WASM_DYLINK_MEM_INFO
      info.memSize = leb(); info.memAlign = leb(); info.tableSize = leb(); info.tableAlign = leb();
    } else if (id === 2) { // WASM_DYLINK_NEEDED
      for (let n = leb(); n > 0; n--) info.needed.push(str());
    }
    p = end;
  }
  return info;
}

export function dylinkLayout(info: DylinkInfo): DylinkLayout {
  const align = 2 ** Math.max(info.memAlign, 4);
  const memoryBase = Math.ceil(MEMORY_BASE / align) * align;
  const stackLow = Math.ceil((memoryBase + info.memSize) / 16) * 16;
  const stackHigh = stackLow + STACK_SIZE;
  return { memoryBase, tableBase: 1, tableSize: info.tableSize, stackLow, stackHigh, minPages: Math.ceil(stackHigh / 65536) };
}

/** Import kinds a PIE module needs from the loader, and the GOT fixups to run after instantiation. */
export function dylinkImports(module: WebAssembly.Module, layout: DylinkLayout): {
  imports: Record<string, Record<string, any>>;
  /** After instantiation: point GOT entries at the module's own exports. */
  relocate(exports: Record<string, any>): void;
} {
  const i32 = (v: number, mutable = false) => new WebAssembly.Global({ value: 'i32', mutable }, v);
  const table = new WebAssembly.Table({ initial: layout.tableBase + layout.tableSize, element: 'anyfunc' });
  const env: Record<string, any> = {
    __indirect_function_table: table,
    __memory_base: i32(layout.memoryBase),
    __table_base: i32(layout.tableBase),
    __stack_pointer: i32(layout.stackHigh, true),
  };
  const Tag = (WebAssembly as any).Tag;
  const gotMem: Record<string, WebAssembly.Global> = {};
  const gotFunc: Record<string, WebAssembly.Global> = {};
  const known: Record<string, number> = { __stack_low: layout.stackLow, __stack_high: layout.stackHigh, __heap_base: layout.stackHigh };
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module === 'GOT.mem') gotMem[imp.name] = i32(known[imp.name] ?? 0, true);
    else if (imp.module === 'GOT.func') gotFunc[imp.name] = i32(0, true);
    else if (imp.module === 'env' && !(imp.name in env)) {
      if ((imp.kind as string) === 'tag' && Tag) env[imp.name] = new Tag({ parameters: ['i32'] });
      else if (imp.kind === 'global') env[imp.name] = i32(known[imp.name] ?? 0, true);
      else if (imp.kind === 'function') {
        // Weak references the static link left undefined (their GOT.func entry stays null)
        const name = imp.name;
        env[name] = () => { throw new Error(`unresolved symbol ${name}`); };
      }
    }
  }
  return {
    imports: { env, 'GOT.mem': gotMem, 'GOT.func': gotFunc },
    relocate(exports) {
      for (const [name, g] of Object.entries(gotMem)) {
        const e = exports[name];
        if (!(name in known) && e instanceof WebAssembly.Global) g.value = layout.memoryBase + (e.value as number);
      }
      for (const [name, g] of Object.entries(gotFunc)) {
        const f = exports[name];
        if (typeof f !== 'function') continue;
        const idx = table.grow(1);
        table.set(idx, f);
        g.value = idx;
      }
    },
  };
}
