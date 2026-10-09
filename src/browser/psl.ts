// Registrable domains ("sites") from the Public Suffix List, for cookie Domain
// checks, SameSite and the cookie jar's partitions. Without it, a proxied
// user.github.io page could set cookies for every github.io site.
import pslText from './public-suffix-list.txt?raw';

let rules: { exact: Set<string>; wild: Set<string>; except: Set<string> } | null = null;

function load() {
  const exact = new Set<string>(), wild = new Set<string>(), except = new Set<string>();
  for (const raw of pslText.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const ascii = (s: string) => { try { return new URL(`http://${s}`).hostname; } catch { return s; } };
    if (line.startsWith('!')) except.add(ascii(line.slice(1)));
    else if (line.startsWith('*.')) wild.add(ascii(line.slice(2)));
    else exact.add(ascii(line));
  }
  rules = { exact, wild, except };
  return rules;
}

/** The public suffix of a host name (its longest matching rule; "*" by default). */
export function publicSuffix(host: string): string {
  const r = rules ?? load();
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < labels.length; i++) {
    const cand = labels.slice(i).join('.');
    if (r.except.has(cand)) return labels.slice(i + 1).join('.');
    if (r.exact.has(cand)) return cand;
    if (i > 0 && r.wild.has(cand)) return labels.slice(i - 1).join('.');
  }
  return labels[labels.length - 1];
}

export function isPublicSuffix(host: string): boolean {
  return publicSuffix(host) === host.toLowerCase().replace(/\.$/, '');
}

/** eTLD+1, or the host itself for IP literals and public suffixes. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const suffix = publicSuffix(h);
  if (suffix === h) return h;
  const rest = h.slice(0, h.length - suffix.length - 1).split('.');
  return `${rest[rest.length - 1]}.${suffix}`;
}

/** "Site" of a URL or origin, as browsers use it for SameSite: scheme + registrable domain. */
export function siteOf(url: string | URL): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  return `${u.protocol}//${registrableDomain(u.hostname)}`;
}
