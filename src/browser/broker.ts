// The broker: the trusted half of the Browser app, running in the desktop page
// (docs/BROWSER.md). Documents on browse origins ask it for MessagePorts; it
// binds each port to the document's tab, real origin and position in the
// frame tree (read from the browser's own WindowProxy chain, never from the
// message), then performs that document's requests: cookies from the
// partitioned jar, browser-like request headers, CORS, redirects, and the
// response changes a page needs to run on its browse origin.
import { OriginMap } from './origin-map';
import { CookieJar, type RequestContext } from './cookies';
import { siteOf } from './psl';
import { HeaderList, headerGet } from './http1';
import { NetFetcher, decodeBody, supportsBrotli, type Dialer, type Fetcher } from './netfetch';
import { framingAllowed, rewriteCsp, rewriteHtml, sniffCharset } from './rewrite';
import { rewriteJs } from './jsrewrite';
import { TlsError, tlsConnect } from './tls';
import { WsClient } from './websocket';
import type { BrokerReply, BrokerToClient, ClientMsg, FetchMsg } from './protocol';

export interface BrokerTab {
  readonly id: number;
  frame(): HTMLIFrameElement | null;
  /** The real URL the tab shows. */
  readonly url: string;
  /** The tab's top-level site (cookie partition), set by its last top-level navigation. */
  partition: string | null;
  bytes: number;
  requests: number;
  onUrl(url: string): void;
  onTitle(title: string): void;
  onFallback(reason: string, url: string): void;
  openTab(url: string): void;
  /** A document of the tab shows a sign-in form; `fill` types a login into it (only on the user's click). */
  onLoginForm?(origin: string, fill: (username: string, password: string) => void): void;
  /** The user submitted a sign-in form (offer to save it). */
  onLoginSubmitted?(origin: string, url: string, username: string, password: string): void;
}

interface DocCtx {
  tab: BrokerTab;
  realOrigin: string;
  browseOrigin: string;
  url: string;
  nested: boolean;
  win: Window;
  /** Real origins of the frames above this one up to the tab (null when unknown). */
  ancestors: (string | null)[];
  /**
   * Cookie partition, fixed when the port is bound: a top-level document's own
   * site, a nested one's tab site at that moment. Never the tab's *current*
   * site: a port that outlives its document must not ride a later site's jar.
   */
  partition: string;
}

export interface BrokerOptions {
  map: OriginMap;
  /** The app's origin (where hello messages must be answered from). */
  app: string;
  dial: Dialer;
  jar: CookieJar;
  tabs: () => BrokerTab[];
  /** Another transport (the server-side fetch used for local comparisons). */
  fetcher?: Fetcher;
  /** Sites whose sign-in can't work proxied: navigations there get the fallback offer. */
  realTabOnly?: (url: URL) => string | null;
}

/** Hosts whose sign-in pages refuse embedded or unknown browsers, or need the real origin. */
export function defaultRealTabOnly(url: URL): string | null {
  if (url.hostname === 'accounts.google.com' && !url.pathname.startsWith('/gsi/')) return 'google-signin';
  return null;
}

const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'cookie', 'cookie2', 'origin', 'referer', 'accept-encoding', 'content-length', 'user-agent', 'dnt', 'expect']);
const DROP_RESPONSE = new Set(['set-cookie', 'set-cookie2', 'transfer-encoding', 'connection', 'keep-alive', 'alt-svc', 'strict-transport-security',
  'public-key-pins', 'public-key-pins-report-only', 'expect-ct', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-opener-policy-report-only',
  'cross-origin-embedder-policy', 'cross-origin-embedder-policy-report-only', 'cross-origin-resource-policy', 'nel', 'report-to', 'reporting-endpoints',
  'clear-site-data', 'origin-agent-cluster', 'content-security-policy', 'content-security-policy-report-only', 'service-worker-allowed',
  'access-control-allow-origin', 'access-control-allow-credentials', 'proxy-authenticate', 'www-authenticate']);
const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);
const SIMPLE_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type', 'range']);

const latin1Decode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return s;
};
const latin1Encode = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
/** Script loads whose bodies get the location rewrite (jsrewrite.ts). Worklets have no location. */
const SCRIPT_DEST = new Set<string>(['script', 'worker', 'sharedworker']);
const WORKER_DEST = new Set<string>(['worker', 'sharedworker']);
const JS_CT = /^\s*$|javascript|ecmascript|^\s*text\/jscript/i;

/** Does `bytes` match an integrity attribute? The strongest algorithm listed decides (as in browsers). */
export async function sriMatches(bytes: Uint8Array, integrity: string): Promise<boolean> {
  const algs: Record<string, string> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
  const items = integrity.split(/\s+/).map((t) => /^(sha256|sha384|sha512)-([A-Za-z0-9+/=_-]+)/.exec(t)).filter(Boolean) as RegExpExecArray[];
  if (!items.length) return true; // nothing we understand: browsers ignore it too
  const best = ['sha512', 'sha384', 'sha256'].find((a) => items.some((m) => m[1] === a))!;
  const digest = new Uint8Array(await crypto.subtle.digest(algs[best], bytes as Uint8Array<ArrayBuffer>));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const norm = (x: string) => x.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  return items.some((m) => m[1] === best && norm(m[2]) === norm(b64));
}

/** Rewritten scripts by URL and content: pages load the same bundles again and again. */
class ScriptCache {
  private m = new Map<string, string>();
  private size = 0;
  constructor(private max = 32 << 20) {}
  key(url: string, text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return `${url}\n${text.length}\n${(h >>> 0).toString(36)}`;
  }
  get(k: string): string | undefined {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: string, v: string) {
    if (v.length > this.max / 4) return;
    this.m.set(k, v);
    this.size += v.length;
    for (const [old, ov] of this.m) { if (this.size <= this.max) break; this.m.delete(old); this.size -= ov.length; }
  }
}

const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function randomToken(n = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('');
}

function acceptFor(dest: string, navigation: boolean): string {
  if (navigation || dest === 'document' || dest === 'iframe') return 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  if (dest === 'style') return 'text/css,*/*;q=0.1';
  if (dest === 'image') return 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
  return '*/*';
}

function secFetchSite(initiator: string | null, target: URL): string {
  if (!initiator) return 'none';
  const i = new URL(initiator);
  if (i.origin === target.origin) return 'same-origin';
  return siteOf(i) === siteOf(target) ? 'same-site' : 'cross-site';
}

/** Referer under the request's policy (default strict-origin-when-cross-origin). */
function refererFor(referrer: string, target: URL, policy: string): string | null {
  if (!referrer || referrer === 'about:client' || !/^https?:/.test(referrer)) return null;
  const r = new URL(referrer);
  r.hash = '';
  const same = r.origin === target.origin;
  const downgrade = r.protocol === 'https:' && target.protocol === 'http:';
  switch (policy || 'strict-origin-when-cross-origin') {
    case 'no-referrer': return null;
    case 'origin': return r.origin + '/';
    case 'same-origin': return same ? r.href : null;
    case 'strict-origin': return downgrade ? null : r.origin + '/';
    case 'unsafe-url': return r.href;
    case 'no-referrer-when-downgrade': return downgrade ? null : r.href;
    case 'origin-when-cross-origin': return same ? r.href : r.origin + '/';
    default: return same ? r.href : downgrade ? null : r.origin + '/';
  }
}

export class Broker {
  readonly fetcher: Fetcher;
  private docs = new Map<Window, DocCtx>();
  private sockets = new Map<string, WsClient>();
  private listener = (e: MessageEvent) => this.onWindowMessage(e);
  private br = supportsBrotli();
  /** Integrity hashes taken out of pages (rewriteHtmlScripts), by real URL. */
  private sri = new Map<string, string>();
  private scripts = new ScriptCache();
  stats = { navigations: 0, requests: 0, errors: 0 };

  constructor(private o: BrokerOptions) {
    this.fetcher = o.fetcher ?? new NetFetcher({ dial: o.dial });
  }

  start() { addEventListener('message', this.listener); }
  stop() {
    removeEventListener('message', this.listener);
    this.fetcher.closeAll();
    for (const s of this.sockets.values()) s.abort();
  }

  /** Which tab a window belongs to, and the frames between them. */
  private locate(src: Window): { tab: BrokerTab; nested: boolean; chain: Window[] } | null {
    for (const tab of this.o.tabs()) {
      const top = tab.frame()?.contentWindow;
      if (!top) continue;
      const chain: Window[] = [];
      let w: Window | null = src;
      for (let depth = 0; w && depth < 32; depth++) {
        if (w === top) return { tab, nested: depth > 0, chain };
        if (w === window || w === w.parent) break;
        w = w.parent;
        chain.push(w);
      }
    }
    return null;
  }

  private onWindowMessage(e: MessageEvent) {
    const real = this.o.map.realOrigin(e.origin);
    if (!real || !e.source) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    const src = e.source as Window;
    const where = this.locate(src);
    if (!where) return;
    if (d.tc === 'fallback') { where.tab.onFallback(String(d.reason), String(d.url || real)); return; }
    if (d.tc !== 'hello' || (d.role !== 'sw' && d.role !== 'client')) return;
    let url = real + '/';
    try { const u = new URL(String(d.url)); if (u.origin === real) url = u.href; } catch { /* keep the origin */ }
    const ctx: DocCtx = {
      tab: where.tab, realOrigin: real, browseOrigin: e.origin, url, nested: where.nested, win: src,
      ancestors: where.chain.map((w) => this.docs.get(w)?.realOrigin ?? null),
      partition: where.nested ? (where.tab.partition ?? `opaque:${randomToken(8)}`) : siteOf(url),
    };
    if (d.role === 'client') this.docs.set(src, ctx);
    const ch = new MessageChannel();
    if (d.role === 'sw') ch.port1.onmessage = (m) => void this.onSwMessage(ctx, ch.port1, m.data as FetchMsg);
    else ch.port1.onmessage = (m) => void this.onClientMessage(ctx, ch.port1, m.data as ClientMsg);
    src.postMessage({ tc: 'port', role: d.role }, e.origin, [ch.port2]);
  }

  private async onSwMessage(ctx: DocCtx, port: MessagePort, msg: FetchMsg) {
    if (msg?.type !== 'fetch') return;
    let reply: BrokerReply;
    try { reply = await this.fetch(ctx, msg); } catch (e) {
      this.stats.errors++;
      const fallback = e instanceof TlsError && e.code === 'tls-version' ? 'tls' : undefined;
      reply = { type: 'error', id: msg.id, message: String((e as Error)?.message ?? e), fallback };
      if (msg.navigation && !ctx.nested && fallback) ctx.tab.onFallback(fallback, msg.url);
    }
    if (reply.type === 'error') console.debug('[browser]', msg.navigation ? 'navigation' : msg.destination || 'fetch', msg.method, msg.url, '→', reply.message);
    const transfer: Transferable[] = [];
    if (reply.type === 'response' && reply.body && typeof reply.body === 'object') transfer.push(reply.body as unknown as Transferable);
    try { port.postMessage(reply, transfer); } catch {
      // A browser that can't transfer streams: send bytes
      if (reply.type === 'response' && reply.body instanceof ReadableStream) {
        reply.body = await new Response(reply.body).arrayBuffer();
        port.postMessage(reply, [reply.body]);
      }
    }
  }


  /** One request from a document (subresource) or for it (its navigation). */
  async fetch(ctx: DocCtx, msg: FetchMsg): Promise<BrokerReply> {
    let url = new URL(msg.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { type: 'error', id: msg.id, message: `unsupported scheme ${url.protocol}` };
    if (msg.navigation && url.origin !== ctx.realOrigin) return { type: 'error', id: msg.id, message: 'navigation for another origin' };
    const realTab = msg.navigation ? (this.o.realTabOnly ?? defaultRealTabOnly)(url) : null;
    if (realTab) {
      if (!ctx.nested) ctx.tab.onFallback(realTab, url.href);
      return { type: 'error', id: msg.id, message: 'This sign-in only works in a real browser tab.', fallback: realTab };
    }
    this.stats.requests++;
    ctx.tab.requests++;
    if (msg.navigation) this.stats.navigations++;
    const initiator = msg.navigation ? (msg.referrer && /^https?:/.test(msg.referrer) ? new URL(msg.referrer).origin : null) : ctx.realOrigin;
    const topNav = msg.navigation && !ctx.nested;
    const partition = ctx.partition;
    let method = msg.method.toUpperCase();
    let body: Uint8Array | null = msg.body ? new Uint8Array(msg.body) : null;
    const pageHeaders = msg.headers.filter(([k]) => !DROP_REQUEST.has(k.toLowerCase()) && !k.toLowerCase().startsWith('sec-') && !k.toLowerCase().startsWith('proxy-'));
    const cors = !msg.navigation && msg.mode === 'cors' && url.origin !== ctx.realOrigin;
    // Proxied documents declare COEP credentialless, and the browser can't make our constructed
    // responses opaque: so cross-origin no-cors requests go without cookies, as under that policy.
    // Otherwise fetch(url, {mode: 'no-cors', credentials: 'include'}) would read another site with its cookies.
    const withCookies = (u: URL) => {
      if (msg.navigation) return true;
      if (u.origin === ctx.realOrigin) return msg.credentials !== 'omit';
      return msg.mode === 'cors' && msg.credentials === 'include';
    };

    if (cors && (!SIMPLE_METHODS.has(method) || pageHeaders.some(([k, v]) => !SIMPLE_HEADERS.has(k.toLowerCase())
      || (k.toLowerCase() === 'content-type' && !/^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i.test(v))))) {
      const ok = await this.preflight(ctx, url, method, pageHeaders, msg);
      if (!ok) return { type: 'error', id: msg.id, message: `CORS preflight for ${url.href} failed` };
    }

    for (let hops = 0; ; hops++) {
      const rctx: RequestContext = { partition, initiatorSite: initiator ? siteOf(initiator) : null, topLevelNavigation: topNav, method };
      const h: HeaderList = [...pageHeaders];
      const has = (n: string) => h.some(([k]) => k.toLowerCase() === n);
      h.push(['User-Agent', navigator.userAgent]);
      if (!has('accept')) h.push(['Accept', acceptFor(msg.destination, msg.navigation)]);
      if (!has('accept-language')) h.push(['Accept-Language', navigator.languages.map((l, i) => (i ? `${l};q=${Math.max(0.1, 1 - i / 10).toFixed(1)}` : l)).join(',')]);
      h.push(['Accept-Encoding', this.br ? 'gzip, deflate, br' : 'gzip, deflate']);
      const ua = (navigator as any).userAgentData;
      if (ua?.brands) {
        h.push(['sec-ch-ua', ua.brands.map((b: any) => `"${b.brand}";v="${b.version}"`).join(', ')]);
        h.push(['sec-ch-ua-mobile', ua.mobile ? '?1' : '?0'], ['sec-ch-ua-platform', `"${ua.platform}"`]);
      }
      h.push(['Sec-Fetch-Site', secFetchSite(initiator, url)], ['Sec-Fetch-Mode', msg.navigation ? 'navigate' : msg.mode],
        ['Sec-Fetch-Dest', msg.navigation ? (ctx.nested ? 'iframe' : 'document') : (msg.destination || 'empty')]);
      // Once: the page's request often has it already, and a duplicate makes some servers (PayPal's) hang
      if (msg.navigation && !has('upgrade-insecure-requests')) h.push(['Upgrade-Insecure-Requests', '1']);
      if (cors || (method !== 'GET' && method !== 'HEAD')) h.push(['Origin', initiator ?? 'null']);
      const ref = refererFor(msg.referrer, url, msg.referrerPolicy);
      if (ref) h.push(['Referer', ref]);
      if (withCookies(url)) { const c = this.o.jar.cookieHeader(url, rctx); if (c) h.push(['Cookie', c]); }

      const res = await this.fetcher.fetch({ url: url.href, method, headers: h, body });
      const setCookies = res.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
      if (setCookies.length && withCookies(url)) this.o.jar.setFromResponse(url, setCookies, rctx);
      const location = headerGet(res.headers, 'location');
      // Navigations are always 'manual' at the SW: their redirects go back to the shell as browse URLs
      // (handing the real Location to the browser would leave the proxy)
      if ([301, 302, 303, 307, 308].includes(res.status) && location && (msg.navigation || msg.redirect !== 'manual')) {
        void res.body.cancel().catch(() => {});
        const next = new URL(location, url);
        if (msg.navigation) return { type: 'redirect', id: msg.id, location: next.href };
        if (msg.redirect === 'error' || hops >= 20) return { type: 'error', id: msg.id, message: 'redirect not allowed' };
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET';
          body = null;
        }
        url = next;
        continue;
      }
      return this.respond(ctx, msg, res, url, hops > 0, cors);
    }
  }

  private async preflight(ctx: DocCtx, url: URL, method: string, headers: HeaderList, msg: FetchMsg): Promise<boolean> {
    const names = headers.map(([k]) => k.toLowerCase()).filter((k) => !SIMPLE_HEADERS.has(k)).sort();
    const res = await this.fetcher.fetch({
      url: url.href, method: 'OPTIONS', body: null,
      headers: [['User-Agent', navigator.userAgent], ['Accept', '*/*'], ['Origin', ctx.realOrigin], ['Access-Control-Request-Method', method],
        ...(names.length ? [['Access-Control-Request-Headers', names.join(',')] as [string, string]] : []),
        ['Sec-Fetch-Mode', 'cors'], ['Sec-Fetch-Site', secFetchSite(ctx.realOrigin, url)], ['Sec-Fetch-Dest', 'empty']],
    });
    void res.body.cancel().catch(() => {});
    if (res.status < 200 || res.status > 299) return false;
    const acao = headerGet(res.headers, 'access-control-allow-origin');
    const creds = msg.credentials === 'include';
    if (!(acao === ctx.realOrigin || (acao === '*' && !creds))) return false;
    if (creds && headerGet(res.headers, 'access-control-allow-credentials') !== 'true') return false;
    const methods = (headerGet(res.headers, 'access-control-allow-methods') ?? '').split(',').map((s) => s.trim().toUpperCase());
    if (!SIMPLE_METHODS.has(method) && !methods.includes(method) && !(methods.includes('*') && !creds)) return false;
    const allowed = (headerGet(res.headers, 'access-control-allow-headers') ?? '').split(',').map((s) => s.trim().toLowerCase());
    return names.every((n) => allowed.includes(n) || (allowed.includes('*') && !creds && n !== 'authorization'));
  }

  private async respond(ctx: DocCtx, msg: FetchMsg, res: Awaited<ReturnType<Fetcher['fetch']>>, finalUrl: URL, redirected: boolean, cors: boolean): Promise<BrokerReply> {
    const { body: decoded, decoded: wasDecoded } = decodeBody(res.body, headerGet(res.headers, 'content-encoding'));
    const headers: HeaderList = res.headers.filter(([k]) => {
      const n = k.toLowerCase();
      if (DROP_RESPONSE.has(n)) return false;
      if (wasDecoded && (n === 'content-encoding' || n === 'content-length')) return false;
      return true;
    });
    if (cors && finalUrl.origin !== ctx.realOrigin) {
      const acao = headerGet(res.headers, 'access-control-allow-origin');
      const creds = msg.credentials === 'include';
      const ok = acao === ctx.realOrigin || (acao === '*' && !creds);
      if (!ok || (creds && headerGet(res.headers, 'access-control-allow-credentials') !== 'true')) {
        void decoded.cancel().catch(() => {});
        return { type: 'error', id: msg.id, message: `CORS: ${finalUrl.origin} does not allow ${ctx.realOrigin}` };
      }
      headers.push(['Access-Control-Allow-Origin', ctx.browseOrigin]);
      if (creds) headers.push(['Access-Control-Allow-Credentials', 'true']);
    }
    headers.push(['Cross-Origin-Resource-Policy', 'cross-origin']);
    const tab = ctx.tab;
    const count = new TransformStream<Uint8Array, Uint8Array>({ flush: () => { tab.bytes += res.wireBytes(); } });
    let bodyOut: ReadableStream<Uint8Array> | ArrayBuffer | null = decoded.pipeThrough(count);

    if (msg.navigation) {
      if (ctx.nested && !framingAllowed(res.headers, ctx.realOrigin, ctx.ancestors)) {
        void (bodyOut as ReadableStream).cancel().catch(() => {});
        return { type: 'error', id: msg.id, message: `${ctx.realOrigin} refuses to be shown inside another site.`, fallback: 'frame-denied' };
      }
      headers.push(['Cross-Origin-Embedder-Policy', 'credentialless'], ['Origin-Agent-Cluster', '?1']);
      const browseAny = this.o.map.template.replace('{key}', '*');
      headers.push(['Content-Security-Policy', `frame-ancestors ${this.o.app} ${browseAny}`]);
      const ct = headerGet(res.headers, 'content-type') ?? '';
      if (/^\s*(text\/html|application\/xhtml\+xml)/i.test(ct) || (!ct && res.status !== 204)) {
        const bytes = new Uint8Array(await new Response(bodyOut as ReadableStream).arrayBuffer());
        const text = latin1Decode(bytes);
        const nonce = randomToken(12);
        const docCookie = this.o.jar.documentCookie(finalUrl, topPartition(ctx, finalUrl));
        const tag = `<script src="/__tc/client.js" nonce="${nonce}" data-app="${escAttr(this.o.app)}" data-cookie="${escAttr(docCookie)}"></script>`;
        const html = rewriteHtml(text, {
          map: this.o.map, baseUrl: finalUrl.href, scriptTag: tag, nonce,
          onSri: (u, integrity) => { if (this.sri.size > 4096) this.sri.clear(); this.sri.set(u, integrity); },
        });
        const csp = res.headers.filter(([k]) => k.toLowerCase() === 'content-security-policy').map(([, v]) => rewriteCsp(v, { nonce, realOrigin: ctx.realOrigin })).filter(Boolean) as string[];
        for (const c of csp) headers.push(['Content-Security-Policy', c]);
        if (!/charset=/i.test(ct)) {
          const cs = sniffCharset(text.slice(0, 4096));
          const i = headers.findIndex(([k]) => k.toLowerCase() === 'content-type');
          const val = `text/html; charset=${cs ?? 'utf-8'}`;
          if (i >= 0) headers[i] = ['Content-Type', val]; else headers.push(['Content-Type', val]);
        }
        const outBytes = latin1Encode(html);
        bodyOut = outBytes.buffer as ArrayBuffer;
        const cl = headers.findIndex(([k]) => k.toLowerCase() === 'content-length');
        if (cl >= 0) headers.splice(cl, 1);
      }
      ctx.url = finalUrl.href;
      if (!ctx.nested) { tab.partition = siteOf(finalUrl); tab.onUrl(finalUrl.href); }
    } else if (SCRIPT_DEST.has(msg.destination) && !msg.integrity && res.status >= 200 && res.status < 300 && JS_CT.test(headerGet(res.headers, 'content-type') ?? '')) {
      const out = await this.rewriteScript(msg, finalUrl, new Uint8Array(await new Response(bodyOut as ReadableStream).arrayBuffer()), headers);
      if (typeof out === 'string') return { type: 'error', id: msg.id, message: out };
      bodyOut = out.buffer as ArrayBuffer;
    } else if (!msg.navigation && (this.sri.has(finalUrl.href) || this.sri.has(msg.url))) {
      // A stylesheet or preload whose integrity attribute we took out of its page
      const bytes = new Uint8Array(await new Response(bodyOut as ReadableStream).arrayBuffer());
      if (!(await sriMatches(bytes, (this.sri.get(finalUrl.href) ?? this.sri.get(msg.url))!))) {
        return { type: 'error', id: msg.id, message: `${finalUrl.href} does not match the integrity hash its page gave` };
      }
      bodyOut = bytes.buffer as ArrayBuffer;
    }
    return { type: 'response', id: msg.id, status: res.status, statusText: res.statusText, headers, body: bodyOut, url: finalUrl.href, redirected };
  }

  /**
   * A script's body for its browse origin: integrity the page declared is
   * checked on the original bytes, then `location` and friends are rewritten
   * (jsrewrite.ts). Returns the body to send, or an error message.
   */
  private async rewriteScript(msg: FetchMsg, finalUrl: URL, bytes: Uint8Array, headers: HeaderList): Promise<Uint8Array | string> {
    const integrity = this.sri.get(finalUrl.href) ?? this.sri.get(msg.url);
    if (integrity && !(await sriMatches(bytes, integrity))) return `${finalUrl.href} does not match the integrity hash its page gave`;
    const ct = headerGet(headers, 'content-type') ?? '';
    const charset = /charset\s*=\s*"?([\w-]+)/i.exec(ct)?.[1] ?? 'utf-8';
    let text: string;
    try { text = new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { return bytes; } // unknown encoding: leave it alone
    const worker = WORKER_DEST.has(msg.destination);
    const key = this.scripts.key(`${msg.destination} ${finalUrl.href}`, text);
    let code = this.scripts.get(key);
    if (code === undefined) {
      const r = rewriteJs(text);
      code = r.code;
      // A worker has no page runtime: it loads the shim first
      if (r.changed && worker) code = code.slice(0, r.preludeAt) + (r.module ? 'import "/__tc/shim.js";' : 'importScripts("/__tc/shim.js");') + code.slice(r.preludeAt);
      this.scripts.set(key, code);
    }
    if (code === text) return bytes;
    for (let i = headers.length - 1; i >= 0; i--) {
      const n = headers[i][0].toLowerCase();
      if (n === 'content-length' || n === 'content-type') headers.splice(i, 1);
    }
    headers.push(['Content-Type', 'text/javascript; charset=utf-8']);
    return new TextEncoder().encode(code);
  }

  private async onClientMessage(ctx: DocCtx, port: MessagePort, m: ClientMsg) {
    const reply = (r: BrokerToClient, t: Transferable[] = []) => { try { port.postMessage(r, t); } catch { /* closed */ } };
    switch (m?.type) {
      case 'cookie-get': {
        const u = sameOriginUrl(ctx, m.url);
        reply({ type: 'cookie', id: m.id, value: this.o.jar.documentCookie(u, topPartition(ctx, u)) });
        break;
      }
      case 'cookie-set': {
        const u = sameOriginUrl(ctx, m.url);
        this.o.jar.setFromScript(u, String(m.cookie), topPartition(ctx, u));
        break;
      }
      case 'title': if (!ctx.nested) ctx.tab.onTitle(String(m.title).slice(0, 300)); break;
      case 'url': {
        const u = sameOriginUrl(ctx, m.url);
        ctx.url = u.href;
        if (!ctx.nested) ctx.tab.onUrl(u.href);
        break;
      }
      case 'open-tab': {
        try { const u = new URL(m.url); if (/^https?:$/.test(u.protocol)) ctx.tab.openTab(u.href); } catch { /* ignore */ }
        break;
      }
      case 'fallback': case 'unproxyable':
        ctx.tab.onFallback(m.type === 'fallback' ? String(m.reason) : 'unproxyable', String(m.url));
        break;
      case 'login-form': case 'login-submitted': {
        // Logins go only to the tab's own top-level origin: never to a third-party frame inside it
        let topOrigin = '';
        try { topOrigin = new URL(ctx.tab.url).origin; } catch { /* no page yet */ }
        if (ctx.nested && ctx.realOrigin !== topOrigin) break;
        if (m.type === 'login-form') ctx.tab.onLoginForm?.(ctx.realOrigin, (username, password) => reply({ type: 'fill', username, password }));
        else ctx.tab.onLoginSubmitted?.(ctx.realOrigin, ctx.url, String(m.username).slice(0, 500), String(m.password).slice(0, 1000));
        break;
      }
      case 'ws-open': void this.openWebSocket(ctx, m, reply); break;
      case 'ws-send': void this.sockets.get(`${ctx.tab.id}:${ctx.browseOrigin}:${m.id}`)?.send(m.data); break;
      case 'ws-close': void this.sockets.get(`${ctx.tab.id}:${ctx.browseOrigin}:${m.id}`)?.close(m.code, m.reason); break;
    }
  }

  private async openWebSocket(ctx: DocCtx, m: Extract<ClientMsg, { type: 'ws-open' }>, reply: (r: BrokerToClient, t?: Transferable[]) => void) {
    const key = `${ctx.tab.id}:${ctx.browseOrigin}:${m.id}`;
    const closeWith = (code: number) => reply({ type: 'ws-event', id: m.id, event: 'close', code, reason: '', wasClean: false });
    let url: URL;
    try { url = new URL(m.url); } catch { reply({ type: 'ws-event', id: m.id, event: 'error' }); closeWith(1006); return; }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') { reply({ type: 'ws-event', id: m.id, event: 'error' }); closeWith(1006); return; }
    const secure = url.protocol === 'wss:';
    const port = Number(url.port) || (secure ? 443 : 80);
    try {
      let s = await this.o.dial(url.hostname, port);
      if (secure) s = await tlsConnect(s, url.hostname, () => this.o.dial(url.hostname, port));
      const httpUrl = new URL(url.href.replace(/^ws/, 'http'));
      const rctx: RequestContext = { partition: ctx.partition, initiatorSite: siteOf(ctx.realOrigin), topLevelNavigation: false, method: 'GET' };
      const headers: HeaderList = [['Origin', ctx.realOrigin], ['User-Agent', navigator.userAgent], ['Pragma', 'no-cache'], ['Cache-Control', 'no-cache']];
      const c = this.o.jar.cookieHeader(httpUrl, rctx);
      if (c) headers.push(['Cookie', c]);
      const ws = new WsClient(s, {
        open: (protocol, extensions) => reply({ type: 'ws-event', id: m.id, event: 'open', protocol, extensions }),
        message: (data) => reply({ type: 'ws-event', id: m.id, event: 'message', data }, typeof data === 'string' ? [] : [data]),
        error: () => reply({ type: 'ws-event', id: m.id, event: 'error' }),
        close: (code, reason, wasClean) => { this.sockets.delete(key); reply({ type: 'ws-event', id: m.id, event: 'close', code, reason, wasClean }); },
      });
      this.sockets.set(key, ws);
      await ws.run(url, headers, m.protocols.map(String));
    } catch (e) {
      console.warn('[browser] WebSocket', url.href, (e as Error)?.message ?? e);
      this.sockets.delete(key);
      reply({ type: 'ws-event', id: m.id, event: 'error' });
      closeWith(1006);
    }
  }
}

/** A URL the page claims for itself, held to its own origin. */
function sameOriginUrl(ctx: DocCtx, url: string): URL {
  try { const u = new URL(url); if (u.origin === ctx.realOrigin) return u; } catch { /* fall through */ }
  return new URL(ctx.url);
}

function topPartition(ctx: DocCtx, _u: URL): string {
  return ctx.partition;
}
