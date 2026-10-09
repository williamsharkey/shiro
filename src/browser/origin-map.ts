// Proxied origins ↔ browse origins (docs/BROWSER.md, "Origins").
//
// Every real origin the Browser app shows gets its own browse origin: one DNS
// label that encodes scheme, host and port, put into a template such as
// `https://{key}.tabcomputer.com` or `http://{key}.localhost:5299`. The host
// browser then isolates each proxied origin's storage, service worker and
// script context from every other one and from the desktop itself.
//
// The label is reversible, so the service worker, the in-page runtime and the
// broker all map URLs without a lookup table:
//   "."  → "-"      "-" → "--"     (hostname labels never start or end with "-",
//                                   so a run of 3 dashes can't come from a host)
//   "---" + "h" (http) or "s" (https) + optional port, when not https:443.
// Hosts that can't fit one 63-character label, single-label hosts, IPv6
// literals and non-http(s) schemes have no browse origin (null): the app
// offers "Open in a real tab" for those.
//
// This file must stay dependency-free: scripts/build-browse.mjs bundles it into
// the service worker and the in-page runtime.

export interface RealOrigin { scheme: 'http' | 'https'; host: string; port: number }

const LABEL_MAX = 63;

export function encodeOriginKey(origin: string | URL): string | null {
  let u: URL;
  try { u = typeof origin === 'string' ? new URL(origin) : origin; } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (!host || host.startsWith('[') || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null;
  if (host.split('.').some((l) => !l || l.startsWith('-') || l.endsWith('-'))) return null;
  const scheme = u.protocol === 'https:' ? 's' : 'h';
  const port = u.port ? Number(u.port) : (scheme === 's' ? 443 : 80);
  let key = host.replace(/-/g, '--').replace(/\./g, '-');
  if (!(scheme === 's' && port === 443)) key += '---' + scheme + (port === (scheme === 's' ? 443 : 80) ? '' : String(port));
  return key.length <= LABEL_MAX ? key : null;
}

export function decodeOriginKey(key: string): RealOrigin | null {
  if (!key || key.length > LABEL_MAX || !/^[a-z0-9-]+$/.test(key)) return null;
  let scheme: 'http' | 'https' = 'https';
  let port = 443;
  const meta = key.match(/^(.*[a-z0-9])---([hs])(\d{0,5})$/);
  if (meta) {
    key = meta[1];
    scheme = meta[2] === 's' ? 'https' : 'http';
    port = meta[3] ? Number(meta[3]) : (scheme === 'https' ? 443 : 80);
    if (port < 1 || port > 65535) return null;
  }
  // Runs of dashes: even → that many / 2 literal dashes; 1 → a dot. Odd runs > 1 are invalid.
  let host = '';
  for (const part of key.split(/(-+)/)) {
    if (!part.startsWith('-')) { host += part; continue; }
    if (part.length === 1) host += '.';
    else if (part.length % 2 === 0) host += '-'.repeat(part.length / 2);
    else return null;
  }
  if (!host.includes('.') || host.split('.').some((l) => !l || l.startsWith('-') || l.endsWith('-'))) return null;
  return { scheme, host, port };
}

export function originString(o: RealOrigin): string {
  const def = o.scheme === 'https' ? 443 : 80;
  return `${o.scheme}://${o.host}${o.port === def ? '' : ':' + o.port}`;
}

/** Template helpers. A template is an origin with one `{key}` placeholder in its host. */
export class OriginMap {
  private re: RegExp;
  readonly template: string;
  constructor(template: string) {
    if (!/^https?:\/\/\{key\}\.[a-z0-9.-]+(:\d+)?$/i.test(template)) throw new Error(`bad browse origin template: ${template}`);
    this.template = template.toLowerCase();
    const esc = this.template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{key\\}', '([a-z0-9-]{1,63})');
    this.re = new RegExp(`^${esc}$`);
  }

  /** The browse origin for a real URL or origin, or null when it can't be proxied. */
  browseOrigin(real: string | URL): string | null {
    const key = encodeOriginKey(real);
    return key ? this.template.replace('{key}', key) : null;
  }

  /** The real origin a browse origin stands for, or null when `origin` isn't one. */
  realOrigin(browseOrigin: string): string | null {
    const m = this.re.exec(browseOrigin.toLowerCase());
    if (!m) return null;
    const o = decodeOriginKey(m[1]);
    return o ? originString(o) : null;
  }

  isBrowseOrigin(origin: string): boolean { return this.realOrigin(origin) !== null; }

  /** https://www.example.com/a?b#c → https://www-example-com.<suffix>/a?b#c (null if not proxyable) */
  toBrowse(realUrl: string | URL): string | null {
    let u: URL;
    try { u = new URL(String(realUrl)); } catch { return null; }
    const o = this.browseOrigin(u);
    return o ? o + u.pathname + u.search + u.hash : null;
  }

  /** The inverse of toBrowse; URLs that aren't on a browse origin come back unchanged. */
  toReal(url: string | URL): string {
    let u: URL;
    try { u = new URL(String(url)); } catch { return String(url); }
    const real = this.realOrigin(u.origin);
    return real ? real + u.pathname + u.search + u.hash : u.href;
  }
}

/**
 * The template a browse origin belongs to: keys never contain dots, so the
 * first host label is the key (`http://www-example-com.localhost:5299` →
 * `http://{key}.localhost:5299`). Used by the service worker and the page runtime.
 */
export function templateFromBrowseOrigin(origin: string): string | null {
  const m = /^(https?:\/\/)([a-z0-9-]+)\.([a-z0-9.-]+(?::\d+)?)$/i.exec(origin);
  return m && decodeOriginKey(m[2].toLowerCase()) ? `${m[1]}{key}.${m[3]}`.toLowerCase() : null;
}

/** The desktop app's own origin for a template: the template with "{key}." removed. */
export function appOriginFor(template: string): string {
  return template.replace('{key}.', '');
}

/** Whether `origin` matches one of `patterns` (exact origins, or `scheme://*.domain` for its subdomains). */
export function originMatches(origin: string, patterns: string[]): boolean {
  const o = origin.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    const star = q.indexOf('://*.');
    if (star < 0) return q === o;
    const scheme = q.slice(0, star + 3), suffix = q.slice(star + 4);
    return o.startsWith(scheme) && o.endsWith(suffix) && !o.slice(scheme.length, -suffix.length).includes('/') && o.length > scheme.length + suffix.length;
  });
}

/**
 * The app (desktop) origin showing this browse-origin document: the top of the
 * frame tree (location.ancestorOrigins, which the page can't forge), if the
 * server lists it. Several instances (example.com, music.example.com) share
 * one browse zone, so the server can't name a single one.
 */
export function parentAppOrigin(patterns: string[], loc: Location = location): string | null {
  const anc = (loc as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (anc && anc.length) {
    const top = anc[anc.length - 1];
    return originMatches(top, patterns) && !templateFromBrowseOrigin(top) ? top : null;
  }
  // No ancestorOrigins (Firefox): only an exact single origin will do
  return patterns.length === 1 && !patterns[0].includes('*') ? patterns[0] : null;
}
