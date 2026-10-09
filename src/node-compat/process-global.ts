/**
 * A node process's own global object. Scripts run in the page's realm, so
 * `globalThis` was the page itself: a script that set a global set it for the
 * whole tab and every other process (Go's wasm_exec, which esbuild-wasm runs
 * as a child node, replaced globalThis.crypto, performance, TextEncoder, fs and
 * require), and node globals the shim passes as parameters (`process`) were
 * missing from it (create-vite reads globalThis.process.platform).
 *
 * Modules get this object as `globalThis` and `global` (parameters, so
 * ordinary identifier lookups cost nothing extra). Reads fall through to the
 * page; `process` and `Buffer` are the process's. A global the page already
 * had before any script ran (crypto, performance, TextEncoder, fetch) that
 * the process replaces, redefines or deletes stays replaced for the process
 * only. Any other global is written through to the page, as before: code reads those as bare
 * identifiers (mocha's `global.describe = ...`, then `describe(...)` in a
 * spec), and a bare identifier resolves on the page's global object. The page's functions come back bound to the
 * page (`globalThis.setTimeout(...)` would be an illegal invocation on this
 * object), so the same function reads as the same bound copy each time.
 *
 * Not a separate realm: objects keep the page's intrinsics, so instanceof
 * works between scripts and the shims (an iframe realm per process broke
 * `e instanceof Error` and `buf instanceof Uint8Array` for everything the
 * shims hand a script).
 */
/** The page's own globals (its object and prototype chain), before any script ran */
let pageNames: Set<PropertyKey> | null = null;
const pageOwn = (): Set<PropertyKey> => {
  if (!pageNames) {
    pageNames = new Set();
    for (let o: any = globalThis; o; o = Object.getPrototypeOf(o)) for (const k of Reflect.ownKeys(o)) pageNames.add(k);
  }
  return pageNames;
};
if (typeof window !== 'undefined') pageOwn();

export function createProcessGlobal(own: Record<string, unknown>): any {
  const page = globalThis as any;
  const target: Record<PropertyKey, any> = Object.create(null);
  const deleted = new Set<PropertyKey>();
  const bound = new WeakMap<Function, Function>();
  let self: any;

  for (const [k, v] of Object.entries(own)) target[k] = v;
  /** Not one of the page's own globals (nor the process's): written through, as scripts' globals always were */
  const isNew = (k: PropertyKey) => !Object.prototype.hasOwnProperty.call(target, k) && !pageOwn().has(k);
  const through = new Set<PropertyKey>();

  const fromPage = (k: PropertyKey) => {
    const v = page[k as any];
    // Page functions that aren't constructors (setTimeout, fetch, atob) need the page as `this`
    if (typeof v === 'function' && !Object.prototype.hasOwnProperty.call(v, 'prototype')) {
      let b = bound.get(v);
      if (!b) { b = v.bind(page) as Function; bound.set(v, b); }
      return b;
    }
    return v;
  };
  const handler: ProxyHandler<any> = {
    get(t, k) {
      if (k === 'globalThis' || k === 'global') return self;
      if (through.has(k)) return page[k as any];
      if (Object.prototype.hasOwnProperty.call(t, k)) return Reflect.get(t, k, self);
      if (deleted.has(k)) return undefined;
      return fromPage(k);
    },
    set(t, k, v) {
      if (through.has(k) || (isNew(k) && !deleted.has(k))) { through.add(k); page[k as any] = v; return true; }
      deleted.delete(k);
      const d = Object.getOwnPropertyDescriptor(t, k);
      if (d?.set) { d.set.call(self, v); return true; }
      if (d && d.writable === false) return false;
      if (d) { t[k as any] = v; return true; }
      return Reflect.defineProperty(t, k, { value: v, writable: true, enumerable: true, configurable: true });
    },
    has(t, k) {
      return k === 'globalThis' || k === 'global' || Object.prototype.hasOwnProperty.call(t, k) || (!deleted.has(k) && k in page);
    },
    deleteProperty(t, k) {
      if (through.has(k)) { through.delete(k); return Reflect.deleteProperty(page, k); }
      const d = Object.getOwnPropertyDescriptor(t, k);
      if (d && !d.configurable) return false;
      delete t[k as any];
      deleted.add(k);
      return true;
    },
    defineProperty(t, k, desc) {
      if (through.has(k) || (isNew(k) && !deleted.has(k))) { through.add(k); return Reflect.defineProperty(page, k, desc); }
      deleted.delete(k);
      // A partial descriptor (esbuild's {writable, configurable} for crypto) keeps the value it had
      if (!Object.prototype.hasOwnProperty.call(t, k) && !('value' in desc) && !desc.get && !desc.set) {
        const v = page[k as any];
        desc = { value: v, writable: false, enumerable: false, configurable: false, ...desc };
      }
      return Reflect.defineProperty(t, k, desc);
    },
    getOwnPropertyDescriptor(t, k) {
      if (k === 'globalThis' || k === 'global') return { value: self, writable: true, enumerable: false, configurable: true };
      if (through.has(k)) { const pd = Object.getOwnPropertyDescriptor(page, k); return pd ? { ...pd, configurable: true } : undefined; }
      const d = Object.getOwnPropertyDescriptor(t, k);
      if (d) return d;
      if (deleted.has(k)) return undefined;
      const pd = Object.getOwnPropertyDescriptor(page, k);
      // (reported configurable: the proxy's target doesn't have it)
      return pd ? { ...pd, configurable: true } : undefined;
    },
    ownKeys(t) {
      const keys = new Set<PropertyKey>([...Reflect.ownKeys(page).filter((k) => !deleted.has(k)), ...Reflect.ownKeys(t)]);
      for (const k of Reflect.ownKeys(t)) keys.add(k);
      return [...keys] as (string | symbol)[];
    },
    getPrototypeOf() { return Object.getPrototypeOf(page); },
  };
  self = new Proxy(target, handler);
  return self;
}
