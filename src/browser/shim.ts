// The globals that rewritten scripts call (jsrewrite.ts), for documents
// (client.ts installs them) and workers (/__tc/shim.js, which the broker puts in
// front of a rewritten worker script). Like the rest of the page runtime this
// is compatibility, not a security boundary.
//
//   x.__tcLocation   Object.prototype accessor: x.location, but a real Location
//                    comes back as a stand-in reporting the real URL and origin
//   x.__tcTop        x.top, but for a window inside a Browser tab, the tab's top
//                    document rather than the desktop around it
//   __tcPMO(o)       postMessage's target origin: real origin → browse origin
//   __tcJS(src)      source handed to a direct eval gets the same rewrite
//   self.origin      the real origin
import { LOC, TOP, rewriteJs } from './jsrewrite';
import type { OriginMap } from './origin-map';

/** `app`: the desktop's origin (documents only): windows below it are the tab's. */
export function installShim(g: any, map: OriginMap, app?: string): void {
  const OP = g.Object.prototype;
  if (Object.getOwnPropertyDescriptor(OP, LOC)) return;
  const toString = Object.prototype.toString;
  const isLocation = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    try { const t = toString.call(v); return t === '[object Location]' || t === '[object WorkerLocation]'; } catch { return false; }
  };
  const realOrigin = (o: string): string => map.realOrigin(o) ?? o;
  const realHref = (h: string): string => { try { return map.toReal(h); } catch { return h; } };

  const inner = new WeakMap<object, any>();
  const fakes = new WeakMap<object, object>();
  const L = (t: object) => {
    const l = inner.get(t);
    if (!l) throw new TypeError('Illegal invocation');
    return l;
  };
  const url = (t: object) => new URL(realHref(L(t).href));
  /** Change one part of the real URL and navigate there (the page runtime maps it back to its browse origin). */
  const go = (t: object, f: (u: URL) => void) => { const u = url(t); f(u); L(t).href = u.href; };
  const http = (t: object) => /^https?:$/.test(L(t).protocol);

  class TcLocation {
    get href() { return realHref(L(this).href); }
    set href(v: string) { L(this).href = v; }
    get origin() { return realOrigin(L(this).origin); }
    get protocol() { return http(this) ? url(this).protocol : L(this).protocol; }
    set protocol(v: string) { go(this, (u) => { u.protocol = v; }); }
    get host() { return http(this) ? url(this).host : L(this).host; }
    set host(v: string) { go(this, (u) => { u.host = v; }); }
    get hostname() { return http(this) ? url(this).hostname : L(this).hostname; }
    set hostname(v: string) { go(this, (u) => { u.hostname = v; }); }
    get port() { return http(this) ? url(this).port : L(this).port; }
    set port(v: string) { go(this, (u) => { u.port = v; }); }
    get pathname() { return L(this).pathname; }
    set pathname(v: string) { L(this).pathname = v; }
    get search() { return L(this).search; }
    set search(v: string) { L(this).search = v; }
    get hash() { return L(this).hash; }
    set hash(v: string) { L(this).hash = v; }
    get ancestorOrigins() {
      const a = L(this).ancestorOrigins;
      if (!a) return a;
      // Only browse origins are the page's real ancestors; the app's origin above them is ours
      const list = Array.from(a as ArrayLike<string>).filter((o) => map.isBrowseOrigin(o)).map(realOrigin);
      return Object.freeze(Object.assign(Object.create({
        item(i: number) { return list[i] ?? null; },
        contains(o: string) { return list.includes(o); },
        [Symbol.iterator]() { return list[Symbol.iterator](); },
      }), list, { length: list.length }));
    }
    assign(v: string) { L(this).assign(v); }
    replace(v: string) { L(this).replace(v); }
    reload() { L(this).reload(); }
    toString() { return this.href; }
    get [Symbol.toStringTag]() { return toString.call(L(this)).slice(8, -1); }
  }
  const fakeOf = (l: object): object => {
    let f = fakes.get(l);
    if (!f) { f = new TcLocation(); inner.set(f, l); fakes.set(l, f); }
    return f;
  };

  Object.defineProperty(OP, LOC, {
    configurable: false, enumerable: false,
    get(this: any) { const v = this.location; return isLocation(v) ? fakeOf(v) : v; },
    set(this: any, v: unknown) { this.location = v; },
  });

  const isWindow = (w: any): boolean => { try { return !!w && typeof w === 'object' && w.window === w; } catch { return false; } };
  /**
   * The tab's top document above `w`: the window just below the app in its
   * ancestor chain. `parent` is left alone (code we never rewrite, such as
   * document.write into an ad frame, walks `parent` up to the real `top`), so
   * a rewritten walk stops here only by comparing with top, as such walks do.
   */
  const tabTop = (w: any): any => {
    try {
      const anc = app ? w.location.ancestorOrigins : null;
      const k = anc ? Array.prototype.indexOf.call(anc, app) : -1;
      if (k >= 0) {
        let a = w;
        for (let i = 0; i < k; i++) a = a.parent;
        return a;
      }
    } catch { /* not ours to see */ }
    return w.top;
  };
  Object.defineProperty(OP, TOP, {
    configurable: false, enumerable: false,
    get(this: any) { return isWindow(this) ? tabTop(this) : this.top; },
    set(this: any, v: unknown) { this.top = v; },
  });

  const pmOrigin = (s: string): string => {
    if (s === '*' || s === '/') return s;
    try {
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol) || map.isBrowseOrigin(u.origin)) return s;
      return map.browseOrigin(u.origin) ?? s;
    } catch { return s; }
  };
  const define = (name: string, value: unknown) => {
    try { Object.defineProperty(g, name, { value, configurable: false, enumerable: false, writable: false }); } catch { /* already there */ }
  };
  define('__tcPMO', (o: any) => {
    if (typeof o === 'string') return pmOrigin(o);
    if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.targetOrigin === 'string') return { ...o, targetOrigin: pmOrigin(o.targetOrigin) };
    return o;
  });
  define('__tcJS', (s: unknown) => (typeof s === 'string' ? rewriteJs(s, 'script').code : s));
  try {
    const own = g.location.origin as string;
    Object.defineProperty(g, 'origin', { configurable: true, enumerable: true, get: () => realOrigin(own) });
  } catch { /* not replaceable here */ }
}
