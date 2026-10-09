// The Browser app's cookie jar (docs/BROWSER.md, "Cookies").
//
// Proxied requests are made by the broker, not by the host browser, so the
// browser's own cookie store never sees proxied sites' cookies: this jar
// does it instead, following RFC 6265bis closely enough for logins to work.
//
// Partitioned by the tab's top-level site, like browsers that block
// third-party cookies (CHIPS without the opt-in): an evil.example tab never
// carries the cookies a bank.example tab collected, so a proxied page can't
// CSRF another site with the user's session. HttpOnly cookies never reach page
// script; SameSite=Strict/Lax cookies are withheld from cross-site requests.
import { isPublicSuffix, registrableDomain } from './psl';

export type SameSite = 'strict' | 'lax' | 'none';

export interface Cookie {
  name: string;
  value: string;
  domain: string;      // lower-case host or domain, no leading dot
  hostOnly: boolean;
  path: string;
  expires: number | null;  // ms since epoch; null = session cookie
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  created: number;
  lastAccess: number;
}

export interface RequestContext {
  /** Partition key: the tab's top-level site (siteOf of the tab URL). */
  partition: string;
  /** The site the request comes from (initiator frame's real site); null for user-typed navigations. */
  initiatorSite: string | null;
  /** Top-level navigation (the tab itself, not a frame or subresource). */
  topLevelNavigation: boolean;
  method: string;
}

const MAX_PER_DOMAIN = 180;
const MAX_TOTAL = 6000;
const MAX_COOKIE_BYTES = 4096;

function defaultPath(u: URL): string {
  const p = u.pathname;
  if (!p.startsWith('/') || p === '/') return '/';
  const i = p.lastIndexOf('/');
  return i === 0 ? '/' : p.slice(0, i);
}

export function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith('.' + domain) && !/^[\d.]+$/.test(host) && !host.includes(':');
}

export function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
}

function parseExpires(s: string): number | null {
  const t = Date.parse(s.replace(/-/g, ' '));
  return Number.isFinite(t) ? t : null;
}

/** Parse one Set-Cookie value for `url`; null when it must be ignored. */
export function parseSetCookie(header: string, url: URL, now = Date.now(), fromScript = false): Cookie | null {
  if (header.length > MAX_COOKIE_BYTES + 1024) return null;
  const parts = header.split(';');
  const first = parts.shift()!;
  const eq = first.indexOf('=');
  const name = (eq < 0 ? '' : first.slice(0, eq)).trim();
  const value = (eq < 0 ? first : first.slice(eq + 1)).trim();
  if (!name && !value) return null;
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(name + value)) return null;
  if (name.length + value.length > MAX_COOKIE_BYTES) return null;
  const host = url.hostname.toLowerCase();
  const c: Cookie = {
    name, value, domain: host, hostOnly: true, path: defaultPath(url), expires: null,
    secure: false, httpOnly: false, sameSite: 'lax', created: now, lastAccess: now,
  };
  let maxAge: number | null = null;
  let domainAttr: string | null = null;
  let sameSiteSet = false;
  for (const raw of parts) {
    const i = raw.indexOf('=');
    const k = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const v = (i < 0 ? '' : raw.slice(i + 1)).trim();
    if (k === 'expires') { const t = parseExpires(v); if (t !== null) c.expires = t; }
    else if (k === 'max-age') { if (/^-?\d+$/.test(v)) maxAge = Number(v); }
    else if (k === 'domain') { domainAttr = v.replace(/^\./, '').toLowerCase(); }
    else if (k === 'path') { c.path = v.startsWith('/') ? v : defaultPath(url); }
    else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'samesite') {
      const s = v.toLowerCase();
      if (s === 'strict' || s === 'lax' || s === 'none') { c.sameSite = s; sameSiteSet = true; }
    }
  }
  if (maxAge !== null) c.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
  if (domainAttr) {
    if (isPublicSuffix(domainAttr)) {
      if (domainAttr !== host) return null; // a public suffix only as the host itself
    } else {
      if (!domainMatch(host, domainAttr)) return null;
      c.domain = domainAttr;
      c.hostOnly = false;
    }
  }
  if (fromScript && c.httpOnly) return null;
  // Secure cookies only from secure origins; SameSite=None requires Secure
  if (c.secure && url.protocol !== 'https:') return null;
  if (sameSiteSet && c.sameSite === 'none' && !c.secure) return null;
  // Cookie prefixes
  if (name.startsWith('__Secure-') && !c.secure) return null;
  if (name.startsWith('__Host-') && (!c.secure || !c.hostOnly || c.path !== '/')) return null;
  return c;
}

export class CookieJar {
  /** partition → cookies */
  private parts = new Map<string, Cookie[]>();
  onChange?: () => void;

  private list(partition: string): Cookie[] {
    let l = this.parts.get(partition);
    if (!l) { l = []; this.parts.set(partition, l); }
    return l;
  }

  /** Store a cookie (or delete, when already expired). Same-name/domain/path replaces, keeping `created`. */
  store(partition: string, c: Cookie, opts: { fromHttp: boolean } = { fromHttp: true }): boolean {
    const l = this.list(partition);
    const i = l.findIndex((o) => o.name === c.name && o.domain === c.domain && o.path === c.path);
    if (i >= 0) {
      if (l[i].httpOnly && !opts.fromHttp) return false; // script can't overwrite an HttpOnly cookie
      c.created = l[i].created;
      l.splice(i, 1);
    }
    if (c.expires !== null && c.expires <= Date.now()) { this.onChange?.(); return true; }
    l.push(c);
    const sameDomain = l.filter((o) => o.domain === c.domain);
    if (sameDomain.length > MAX_PER_DOMAIN) {
      sameDomain.sort((a, b) => a.lastAccess - b.lastAccess);
      l.splice(l.indexOf(sameDomain[0]), 1);
    }
    let total = 0;
    for (const p of this.parts.values()) total += p.length;
    if (total > MAX_TOTAL) l.sort((a, b) => b.lastAccess - a.lastAccess).length = Math.max(0, l.length - (total - MAX_TOTAL));
    this.onChange?.();
    return true;
  }

  /** Apply a response's Set-Cookie headers. */
  setFromResponse(url: URL, setCookies: string[], ctx: RequestContext): void {
    const crossSite = isCrossSite(url, ctx);
    for (const h of setCookies) {
      const c = parseSetCookie(h, url);
      if (!c) continue;
      // Cross-site responses may only set SameSite=None cookies (Chrome's rule)
      if (crossSite && c.sameSite !== 'none') continue;
      this.store(ctx.partition, c);
    }
  }

  /** document.cookie = "…" */
  setFromScript(url: URL, cookie: string, partition: string): void {
    const c = parseSetCookie(cookie, url, Date.now(), true);
    if (c) this.store(partition, c, { fromHttp: false });
  }

  private matching(url: URL, partition: string, filter: (c: Cookie) => boolean): Cookie[] {
    const host = url.hostname.toLowerCase();
    const now = Date.now();
    const l = this.list(partition);
    const out: Cookie[] = [];
    if (l.some((c) => c.expires !== null && c.expires <= now)) {
      const live = l.filter((c) => c.expires === null || c.expires > now);
      l.length = 0; l.push(...live);
    }
    for (const c of l) {
      if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) continue;
      if (!pathMatch(url.pathname || '/', c.path)) continue;
      if (c.secure && url.protocol !== 'https:') continue;
      if (!filter(c)) continue;
      out.push(c);
    }
    // Longer paths first, then older cookies first (RFC 6265 5.4)
    out.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    for (const c of out) c.lastAccess = now;
    return out;
  }

  /** The Cookie request header for a request, or null. */
  cookieHeader(url: URL, ctx: RequestContext): string | null {
    const crossSite = isCrossSite(url, ctx);
    const safe = ctx.method === 'GET' || ctx.method === 'HEAD' || ctx.method === 'OPTIONS' || ctx.method === 'TRACE';
    const cs = this.matching(url, ctx.partition, (c) => {
      if (!crossSite || c.sameSite === 'none') return true;
      // Lax cookies go with cross-site top-level navigations that are safe (a link click)
      return c.sameSite === 'lax' && ctx.topLevelNavigation && safe;
    });
    return cs.length ? cs.map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join('; ') : null;
  }

  /** document.cookie for a page at `url` (no HttpOnly). */
  documentCookie(url: URL, partition: string): string {
    return this.matching(url, partition, (c) => !c.httpOnly).map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join('; ');
  }

  all(partition?: string): Cookie[] {
    if (partition) return this.list(partition).slice();
    return [...this.parts.values()].flat();
  }

  partitions(): string[] { return [...this.parts.keys()].filter((k) => this.parts.get(k)!.length); }

  clear(partition?: string): void {
    if (partition) this.parts.delete(partition); else this.parts.clear();
    this.onChange?.();
  }

  /** Persistent cookies only (session cookies end with the app). */
  toJSON(): Record<string, Cookie[]> {
    const out: Record<string, Cookie[]> = {};
    for (const [k, l] of this.parts) {
      const keep = l.filter((c) => c.expires !== null && c.expires > Date.now());
      if (keep.length) out[k] = keep;
    }
    return out;
  }

  static fromJSON(data: Record<string, Cookie[]> | null | undefined): CookieJar {
    const jar = new CookieJar();
    for (const [k, l] of Object.entries(data ?? {})) if (Array.isArray(l)) jar.parts.set(k, l.filter((c) => c && typeof c.name === 'string'));
    return jar;
  }
}

export function isCrossSite(url: URL, ctx: RequestContext): boolean {
  const target = `${url.protocol}//${registrableDomain(url.hostname)}`;
  if (ctx.topLevelNavigation) return ctx.initiatorSite !== null && ctx.initiatorSite !== target;
  // Subresources and frames: cross-site unless the target, the initiator and the top-level site agree
  if (ctx.partition !== target) return true;
  return ctx.initiatorSite !== null && ctx.initiatorSite !== target;
}
