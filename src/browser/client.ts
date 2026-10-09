// /__tc/client.js: the runtime the broker puts at the top of every proxied
// HTML document (docs/BROWSER.md, "The page runtime"). A classic script, so it
// runs before the page's own scripts. It is a compatibility layer, not a
// security boundary: the page can undo any of it, and nothing here grants
// more than the document's own browse origin already has.
//
// - document.cookie reads a snapshot from the broker and writes go back to it
// - navigations to other origins go to their browse origins (Navigation API),
//   new windows become app tabs, iframes get browse-origin src
// - WebSocket tunnels through the broker
// - MessageEvent.origin and document.referrer show real origins, and so do
//   rewritten scripts' `location` (shim.ts) and document.URL/domain/baseURI
// - WebAuthn/passkeys report a fallback ("Open in a real tab")
import { OriginMap, templateFromBrowseOrigin } from './origin-map';
import { installShim } from './shim';
import { rewriteJs } from './jsrewrite';
import type { BrokerToClient, ClientMsg } from './protocol';

(() => {
  const w = window as any;
  if (w.__tcClient) return;
  w.__tcClient = true;
  const script = document.currentScript as HTMLScriptElement | null;
  const APP = script?.dataset.app || '';
  const template = templateFromBrowseOrigin(location.origin);
  if (!template || !APP) return;
  const map = new OriginMap(template);
  const REAL_ORIGIN = map.realOrigin(location.origin)!;
  let cookieSnapshot = script?.dataset.cookie ?? '';

  // The navigation token is ours, not the page's
  if (location.search.includes('__tc_nav=')) {
    const u = new URL(location.href);
    u.searchParams.delete('__tc_nav');
    history.replaceState(history.state, '', u.href);
  }

  // ── port to the broker ──
  const askApp = (role: 'sw' | 'client'): Promise<MessagePort | null> => new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== APP || e.data?.tc !== 'port' || e.data.role !== role || !e.ports[0]) return;
      removeEventListener('message', onMsg, true);
      resolve(e.ports[0]);
    };
    addEventListener('message', onMsg, true);
    window.top!.postMessage({ tc: 'hello', role, url: map.toReal(location.href) }, APP);
    setTimeout(() => resolve(null), 10_000);
  });
  let port: MessagePort | null = null;
  const queue: [ClientMsg, Transferable[]][] = [];
  const send = (m: ClientMsg, t: Transferable[] = []) => { if (port) port.postMessage(m, t); else queue.push([m, t]); };
  const handlers: ((m: BrokerToClient) => void)[] = [];
  void askApp('client').then((p) => {
    if (!p) return;
    port = p;
    p.onmessage = (e) => { for (const h of handlers) h(e.data); };
    for (const [m, t] of queue.splice(0)) p.postMessage(m, t);
  });
  // The service worker lost our port (it restarted): fetch it a new one
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.tc !== 'need-port') return;
    void askApp('sw').then((p) => { if (p) navigator.serviceWorker.controller?.postMessage({ tc: 'port' }, [p]); });
  });

  // The document's own base (baseURI itself is patched below to report the real URL)
  const baseDesc = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI')!;
  const toAbs = (v: string | URL): URL | null => { try { return new URL(String(v), baseDesc.get!.call(document)); } catch { return null; } };
  /** A URL as the browse origin serves it (real origins → browse origins; others unchanged). */
  const proxied = (v: string | URL): string => {
    const u = toAbs(v);
    if (!u || !/^https?:$/.test(u.protocol) || map.isBrowseOrigin(u.origin)) return String(v);
    return map.toBrowse(u) ?? String(v);
  };
  const realOf = (v: string): string => { const u = toAbs(v); return u ? map.toReal(u) : v; };

  // ── cookies ──
  let cookieId = 1;
  handlers.push((m) => { if (m.type === 'cookie') cookieSnapshot = m.value; });
  const refreshCookies = () => send({ type: 'cookie-get', id: cookieId++, url: map.toReal(location.href) });
  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => cookieSnapshot,
      set: (v: string) => {
        const s = String(v);
        const [pair, ...attrs] = s.split(';');
        const eq = pair.indexOf('=');
        const name = eq < 0 ? '' : pair.slice(0, eq).trim();
        const expired = attrs.some((a) => /^\s*max-age\s*=\s*(-\d+|0)\s*$/i.test(a))
          || attrs.some((a) => { const m = /^\s*expires\s*=(.*)$/i.exec(a); return !!m && Date.parse(m[1]) < Date.now(); });
        const parts = cookieSnapshot ? cookieSnapshot.split('; ').filter((c) => !c.startsWith(name + '=')) : [];
        if (!expired && !/;\s*httponly/i.test(s)) parts.push(pair.trim());
        cookieSnapshot = parts.join('; ');
        send({ type: 'cookie-set', url: map.toReal(location.href), cookie: s });
      },
    });
  } catch { /* not configurable in this browser */ }
  setInterval(() => { if (document.visibilityState === 'visible') refreshCookies(); }, 2000);

  // ── navigation ──
  const nav = w.navigation;
  nav?.addEventListener('navigate', (e: any) => {
    const dest = toAbs(e.destination?.url ?? '');
    if (!dest || dest.origin === location.origin || !/^https?:$/.test(dest.protocol) || map.isBrowseOrigin(dest.origin)) return;
    if (!e.cancelable || e.hashChange || e.downloadRequest) return;
    e.preventDefault();
    const target = map.toBrowse(dest);
    if (!target) { send({ type: 'unproxyable', url: dest.href }); return; }
    if (e.formData) {
      // A form POST to another origin: submit the same fields to its browse origin
      const f = document.createElement('form');
      f.method = 'post'; f.action = target; f.enctype = 'multipart/form-data'; f.style.display = 'none';
      for (const [k, v] of e.formData as FormData) {
        const i = document.createElement('input');
        i.name = k;
        if (typeof v === 'string') i.value = v; else { i.type = 'file'; const dt = new DataTransfer(); dt.items.add(v); i.files = dt.files; }
        f.append(i);
      }
      document.body.append(f);
      HTMLFormElement.prototype.submit.call(f);
    } else if (e.navigationType === 'replace') location.replace(target);
    else location.assign(target);
  });

  // New windows and _blank links become app tabs
  addEventListener('click', (e) => {
    const a = (e.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented) return;
    const t = (a.target || '').toLowerCase();
    const newTab = t === '_blank' || e.ctrlKey || e.metaKey || e.button === 1;
    if (!newTab) return;
    const u = toAbs(a.href);
    if (!u || !/^https?:$/.test(u.protocol)) return;
    e.preventDefault();
    send({ type: 'open-tab', url: map.toReal(u) });
  }, true);
  w.open = function (url?: string | URL) {
    if (url !== undefined && url !== '') { const u = toAbs(url); if (u) send({ type: 'open-tab', url: map.toReal(u) }); }
    return null;
  };

  // Frames load from browse origins
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src')!;
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    configurable: true, enumerable: true,
    get() { return realOf(srcDesc.get!.call(this)); },
    set(v: string) { srcDesc.set!.call(this, proxied(v)); },
  });
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (this instanceof HTMLIFrameElement && name.toLowerCase() === 'src') value = proxied(value);
    return setAttr.call(this, name, value);
  };
  new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) {
      const frames = n instanceof HTMLIFrameElement ? [n] : n instanceof Element ? Array.from(n.querySelectorAll('iframe[src]')) : [];
      for (const f of frames as HTMLIFrameElement[]) {
        const s = f.getAttribute('src');
        if (s && proxied(s) !== s) setAttr.call(f, 'src', proxied(s));
      }
    }
  }).observe(document, { childList: true, subtree: true });

  // The address bar follows pushState/replaceState too
  nav?.addEventListener('currententrychange', () => send({ type: 'url', url: map.toReal(location.href) }));

  // Our service worker owns this origin's scope: a site's own one would replace it
  const swc = navigator.serviceWorker as any;
  if (swc) {
    swc.register = () => Promise.reject(new DOMException('Service workers are not available in the Browser app.', 'SecurityError'));
    swc.getRegistrations = () => Promise.resolve([]);
    swc.getRegistration = () => Promise.resolve(undefined);
  }

  // ── real origins where scripts look ──
  const originDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin')!;
  Object.defineProperty(MessageEvent.prototype, 'origin', {
    configurable: true,
    get() { const o = originDesc.get!.call(this); return map.realOrigin(o) ?? o; },
  });
  installShim(window, map, APP);
  const realGetter = (proto: object, name: string, f: (v: string) => string) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d?.get) return;
    Object.defineProperty(proto, name, { ...d, get() { const v = d.get!.call(this); return typeof v === 'string' ? f(v) : v; } });
  };
  for (const name of ['URL', 'documentURI']) realGetter(Document.prototype, name, realOf);
  realGetter(Node.prototype, 'baseURI', realOf);
  realGetter(Document.prototype, 'domain', (d) => { const r = map.realOrigin(`${location.protocol}//${d}${location.port ? ':' + location.port : ''}`); return r ? new URL(r).hostname : d; });
  // Same-origin frames (about:blank, srcdoc) run the parent's rewritten scripts against their own globals
  for (const name of ['contentWindow', 'contentDocument'] as const) {
    const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, name)!;
    Object.defineProperty(HTMLIFrameElement.prototype, name, {
      ...d,
      get() {
        const v = d.get!.call(this);
        try { const win = name === 'contentWindow' ? v : v?.defaultView; if (win && win.Object) installShim(win, map, APP); } catch { /* cross-origin */ }
        return v;
      },
    });
  }
  // Links report real URLs (routers compare them with location.origin to tell internal links)
  for (const proto of [HTMLAnchorElement.prototype, HTMLAreaElement.prototype]) {
    const href = Object.getOwnPropertyDescriptor(proto, 'href')!;
    Object.defineProperty(proto, 'href', { ...href, get() { return realOf(href.get!.call(this)); } });
    for (const part of ['origin', 'protocol', 'host', 'hostname', 'port'] as const) {
      const d = Object.getOwnPropertyDescriptor(proto, part);
      if (!d?.get) continue;
      Object.defineProperty(proto, part, {
        ...d,
        get() { const raw = href.get!.call(this) as string; if (!raw) return d.get!.call(this); try { return new URL(realOf(raw))[part]; } catch { return d.get!.call(this); } },
      });
    }
  }
  // History entries and workers take real URLs from scripts that build them from location
  for (const k of ['pushState', 'replaceState'] as const) {
    const orig = History.prototype[k];
    History.prototype[k] = function (this: History, state: unknown, title: string, url?: string | URL | null) {
      return url == null ? orig.call(this, state, title) : orig.call(this, state, title, proxied(url));
    };
  }
  for (const name of ['Worker', 'SharedWorker'] as const) {
    const W = w[name];
    if (!W) continue;
    w[name] = class extends W { constructor(url: string | URL, opts?: unknown) { super(proxied(url), opts); } };
  }
  // Inline scripts a page creates get the same rewrite as the ones it was served with
  const JS_TYPE = /^\s*(text\/javascript|application\/javascript|module|text\/ecmascript|application\/ecmascript)?\s*$/i;
  const seen = new WeakSet<HTMLScriptElement>();
  const fixScript = (sc: HTMLScriptElement) => {
    if (seen.has(sc) || sc.hasAttribute('src') || !JS_TYPE.test(sc.type)) return;
    seen.add(sc);
    const text = sc.text;
    const r = rewriteJs(text, /module/i.test(sc.type) ? 'module' : 'script');
    if (r.changed) sc.text = r.code;
  };
  const fixNode = (n: unknown) => {
    if (n instanceof HTMLScriptElement) fixScript(n);
    else if (n instanceof Element || n instanceof DocumentFragment) for (const sc of n.querySelectorAll('script')) fixScript(sc);
  };
  const hook = (proto: any, names: string[]) => {
    for (const name of names) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      proto[name] = function (this: unknown, ...args: unknown[]) { for (const a of args) fixNode(a); return orig.apply(this, args); };
    }
  };
  hook(Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']);
  hook(Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'insertAdjacentElement']);
  hook(DocumentFragment.prototype, ['append', 'prepend']);
  const refDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer')!;
  Object.defineProperty(Document.prototype, 'referrer', { configurable: true, get() { const r = refDesc.get!.call(this); return r ? realOf(r) : r; } });

  // Title for the tab strip
  let lastTitle = '';
  const reportTitle = () => { if (document.title !== lastTitle) { lastTitle = document.title; send({ type: 'title', title: lastTitle }); } };
  addEventListener('DOMContentLoaded', reportTitle);
  addEventListener('load', reportTitle);
  setInterval(reportTitle, 1000);

  // ── passkeys can't work on a borrowed origin ──
  const creds = navigator.credentials as any;
  if (creds) {
    for (const k of ['get', 'create'] as const) {
      const orig = creds[k]?.bind(creds);
      if (!orig) continue;
      creds[k] = (opts: any) => {
        if (opts?.publicKey && opts.mediation === 'conditional') {
          // Passkey autofill offers: passive, so no banner; like a browser with no passkeys, never resolves
          return new Promise(() => {});
        }
        if (opts?.publicKey) {
          send({ type: 'fallback', reason: 'webauthn', url: map.toReal(location.href) });
          return Promise.reject(new DOMException('Passkeys need a real browser tab; the Browser app offers to open one.', 'NotAllowedError'));
        }
        return orig(opts);
      };
    }
  }

  // ── sign-in forms: the app offers saved logins (filled only when the user clicks) and to save new ones ──
  let reportedForm = false;
  const visible = (el: Element) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const passwordField = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]')).find(visible) ?? null;
  const usernameFieldFor = (pw: HTMLInputElement | null): HTMLInputElement | null => {
    const scope: ParentNode = pw?.form ?? document;
    const cands = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type=email],input[type=text],input[type=tel],input:not([type])'))
      .filter((i) => visible(i) && (!pw || (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)));
    const named = cands.find((i) => /user|email|login|account|identifier/i.test(i.name + i.id + i.autocomplete));
    return named ?? cands[cands.length - 1] ?? null;
  };
  setInterval(() => {
    if (reportedForm || document.visibilityState !== 'visible') return;
    if (passwordField() || document.querySelector('input[autocomplete~=username]')) { reportedForm = true; send({ type: 'login-form' }); }
  }, 1000);
  const setValue = (el: HTMLInputElement, v: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  handlers.push((m) => {
    if (m.type !== 'fill') return;
    const pw = passwordField();
    const user = usernameFieldFor(pw) ?? (document.querySelector('input[autocomplete~=username]') as HTMLInputElement | null);
    if (user && m.username) setValue(user, m.username);
    if (pw) setValue(pw, m.password);
  });
  addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    const pw = Array.from(form.querySelectorAll<HTMLInputElement>('input[type=password]')).find((i) => i.value);
    if (!pw) return;
    send({ type: 'login-submitted', username: usernameFieldFor(pw)?.value ?? '', password: pw.value });
  }, true);

  // ── WebSocket through the broker ──
  let wsNext = 1;
  const sockets = new Map<number, TcWebSocket>();
  handlers.push((m) => { if (m.type === 'ws-event') sockets.get(m.id)?._event(m); });

  class TcWebSocket extends EventTarget {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    protocol = '';
    extensions = '';
    binaryType: BinaryType = 'blob';
    readonly url: string;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    private id = wsNext++;
    private sendChain: Promise<void> = Promise.resolve();
    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const u = toAbs(url);
      if (!u) throw new DOMException(`Invalid URL ${url}`, 'SyntaxError');
      if (u.protocol === 'http:') u.protocol = 'ws:';
      if (u.protocol === 'https:') u.protocol = 'wss:';
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new DOMException(`Bad scheme ${u.protocol}`, 'SyntaxError');
      // Relative URLs resolve against the browse origin: point them at the real one
      const asHttp = new URL(u.href.replace(/^ws/, 'http'));
      const real = new URL(map.toReal(asHttp));
      real.protocol = real.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = real.href;
      sockets.set(this.id, this);
      send({ type: 'ws-open', id: this.id, url: this.url, protocols: protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols] });
    }
    private fire(ev: Event) {
      this.dispatchEvent(ev);
      const h = (this as any)['on' + ev.type];
      if (typeof h === 'function') h.call(this, ev);
    }
    _event(m: Extract<BrokerToClient, { type: 'ws-event' }>) {
      if (m.event === 'open') { this.readyState = 1; this.protocol = m.protocol; this.extensions = m.extensions; this.fire(new Event('open')); }
      else if (m.event === 'message') {
        const data = typeof m.data === 'string' ? m.data : this.binaryType === 'arraybuffer' ? m.data : new Blob([m.data]);
        this.fire(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
      } else if (m.event === 'error') this.fire(new Event('error'));
      else if (m.event === 'close') {
        this.readyState = 3;
        sockets.delete(this.id);
        this.fire(new CloseEvent('close', { code: m.code, reason: m.reason, wasClean: m.wasClean }));
      }
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState === 0) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
      if (this.readyState !== 1) return;
      const id = this.id;
      this.sendChain = this.sendChain.then(async () => {
        let payload: string | ArrayBuffer;
        if (typeof data === 'string') payload = data;
        else if (data instanceof Blob) payload = await data.arrayBuffer();
        else if (ArrayBuffer.isView(data)) payload = (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
        else payload = (data as ArrayBuffer).slice(0);
        send({ type: 'ws-send', id, data: payload }, typeof payload === 'string' ? [] : [payload]);
      });
    }
    close(code?: number, reason?: string) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      send({ type: 'ws-close', id: this.id, code, reason });
    }
  }
  w.WebSocket = TcWebSocket;

  void REAL_ORIGIN;
})();
