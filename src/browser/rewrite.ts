// Response rewriting for proxied documents (docs/BROWSER.md, "What the broker
// changes"). HTML is handled as latin1 text so every byte survives unchanged
// whatever the page's real encoding; only ASCII patterns are touched.
import type { OriginMap } from './origin-map';

const FETCH_DIRECTIVES = new Set(['default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem',
  'img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src', 'prefetch-src', 'form-action']);

/**
 * Rewrite a page's Content-Security-Policy for its browse origin: 'self' also
 * names the real origin (pages use both relative and absolute URLs), the
 * runtime's nonce is allowed, and directives we can't honour here go
 * (frame-ancestors is enforced by the broker itself; reports would leak the
 * browse origin; sandbox would make the origin opaque and lose the SW).
 */
export function rewriteCsp(value: string, o: { nonce: string; realOrigin: string }): string | null {
  const out: string[] = [];
  const policies = value.split(',');
  for (const policy of policies) {
    const dirs: string[] = [];
    let hasScript = false;
    let defaultIdx = -1;
    for (const raw of policy.split(';')) {
      const parts = raw.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const name = parts[0].toLowerCase();
      if (['frame-ancestors', 'report-uri', 'report-to', 'sandbox', 'require-trusted-types-for', 'trusted-types'].includes(name)) continue;
      let srcs = parts.slice(1);
      if (FETCH_DIRECTIVES.has(name)) {
        const lower = srcs.map((x) => x.toLowerCase());
        // 'self' is now the browse origin: it must also name the real one, and a list naming the
        // real origin must also allow 'self' (relative URLs resolve on the browse origin)
        if (lower.includes("'self'")) srcs.push(o.realOrigin);
        else if (!lower.includes("'none'") && !lower.includes('*') && sourceMatches(lower.filter((x) => !x.startsWith("'")), o.realOrigin, '')) srcs.push("'self'");
      }
      if (name === 'script-src' || name === 'script-src-elem') {
        hasScript = true;
        srcs = allowRuntime(srcs, o.nonce);
      }
      if (name === 'default-src') defaultIdx = dirs.length;
      dirs.push([name, ...srcs].join(' '));
    }
    // default-src covers scripts when script-src is absent: add the nonce there
    if (!hasScript && defaultIdx >= 0) {
      dirs[defaultIdx] = ['default-src', ...allowRuntime(dirs[defaultIdx].split(' ').slice(1), o.nonce)].join(' ');
    }
    if (dirs.length) out.push(dirs.join('; '));
  }
  return out.length ? out.join(', ') : null;
}

/**
 * Let the runtime's <script> run under a script source list. A nonce disables
 * 'unsafe-inline', so a list that relies on 'unsafe-inline' (and has no nonce,
 * hash or 'strict-dynamic' of its own) gets 'self' instead: the runtime is
 * served from the browse origin.
 */
function allowRuntime(srcs: string[], nonce: string): string[] {
  const lower = srcs.map((x) => x.toLowerCase());
  if (lower.includes("'none'")) return [`'nonce-${nonce}'`];
  const usesNonces = lower.some((x) => x.startsWith("'nonce-") || /^'sha(256|384|512)-/.test(x) || x === "'strict-dynamic'");
  if (lower.includes("'unsafe-inline'") && !usesNonces) return lower.includes("'self'") ? srcs : [...srcs, "'self'"];
  return [...srcs, `'nonce-${nonce}'`];
}

/** <meta charset> / http-equiv content-type in the first bytes of a document. */
export function sniffCharset(latin1Head: string): string | null {
  const m = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_.:-]+)/i.exec(latin1Head);
  return m ? m[1].toLowerCase() : null;
}

const ATTR_TARGETS: Record<string, string[]> = {
  a: ['href'], area: ['href'], form: ['action'], iframe: ['src'], frame: ['src'], base: ['href'],
};

/**
 * Point navigational URLs (links, forms, frames, <base>, meta refresh) at
 * browse origins and put the runtime's <script> first in <head>. Subresource
 * URLs stay as they are: the service worker sees those requests anyway.
 */
export function rewriteHtml(html: string, o: { map: OriginMap; baseUrl: string; scriptTag: string }): string {
  let base = o.baseUrl;
  const toBrowse = (v: string): string | null => {
    const raw = v.trim();
    if (!/^(https?:)?\/\//i.test(raw)) return null; // relative URLs already resolve on the browse origin
    let u: URL;
    try { u = new URL(raw.replace(/&amp;/g, '&'), base); } catch { return null; }
    if (o.map.isBrowseOrigin(u.origin)) return null;
    const b = o.map.toBrowse(u);
    return b ? b.replace(/&/g, '&amp;') : null;
  };
  let out = html.replace(/<(a|area|form|iframe|frame|base)\b([^>]*)>/gi, (whole, tag: string, attrs: string) => {
    const names = ATTR_TARGETS[tag.toLowerCase()];
    const rewritten = attrs.replace(/(\s)([a-z-]+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
      (m, sp: string, name: string, eq: string, _q: string, dq?: string, sq?: string, bare?: string) => {
        if (!names.includes(name.toLowerCase())) return m;
        const val = dq ?? sq ?? bare ?? '';
        if (tag.toLowerCase() === 'base') { try { base = new URL(val.replace(/&amp;/g, '&'), base).href; } catch { /* keep */ } }
        const b = toBrowse(val);
        if (!b) return m;
        const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
        return `${sp}${name}${eq}${q}${b}${q}`;
      });
    return `<${tag}${rewritten}>`;
  });
  out = out.replace(/(<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*)([^"'>]+)/gi,
    (m, pre: string, url: string) => { const b = toBrowse(url); return b ? pre + b : m; });
  // A <meta http-equiv=Content-Security-Policy> can't name our nonce: drop it (the header form is rewritten instead)
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  // The runtime goes first in <head> (after <meta charset> if it comes first), else after <html>, else after the doctype
  const head = /<head\b[^>]*>/i.exec(out.slice(0, 256 * 1024));
  if (head) {
    let at = head.index + head[0].length;
    const charset = /^\s*<meta[^>]+charset[^>]*>/i.exec(out.slice(at, at + 1024));
    if (charset) at += charset[0].length;
    return out.slice(0, at) + o.scriptTag + out.slice(at);
  }
  const htmlTag = /<html\b[^>]*>/i.exec(out.slice(0, 64 * 1024));
  if (htmlTag) { const at = htmlTag.index + htmlTag[0].length; return out.slice(0, at) + o.scriptTag + out.slice(at); }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(out);
  const at = doctype ? doctype[0].length : 0;
  return out.slice(0, at) + o.scriptTag + out.slice(at);
}

/** X-Frame-Options / CSP frame-ancestors for a nested document, given its ancestors' real origins (null = unknown). */
export function framingAllowed(headers: [string, string][], docOrigin: string, ancestors: (string | null)[]): boolean {
  for (const [k, v] of headers) {
    const name = k.toLowerCase();
    if (name === 'content-security-policy') {
      for (const policy of v.split(',')) {
        const d = policy.split(';').map((s) => s.trim()).find((s) => /^frame-ancestors\b/i.test(s));
        if (!d) continue;
        const srcs = d.split(/\s+/).slice(1).map((s) => s.toLowerCase());
        if (!ancestors.every((a) => a !== null && sourceMatches(srcs, a, docOrigin))) return false;
      }
    }
  }
  // frame-ancestors present overrides XFO (as in browsers)
  if (headers.some(([k, v]) => k.toLowerCase() === 'content-security-policy' && /frame-ancestors/i.test(v))) return true;
  const xfo = headers.find(([k]) => k.toLowerCase() === 'x-frame-options')?.[1]?.trim().toLowerCase();
  if (xfo === 'deny') return false;
  if (xfo === 'sameorigin') return ancestors.every((a) => a === docOrigin);
  return true;
}

function sourceMatches(srcs: string[], origin: string, self: string): boolean {
  if (srcs.includes("'none'")) return false;
  const u = new URL(origin);
  for (const s of srcs) {
    if (s === "'self'") { if (origin === self) return true; continue; }
    if (s === '*') return true;
    if (/^[a-z][a-z0-9+.-]*:$/.test(s)) { if (u.protocol === s) return true; continue; }
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/.exec(s);
    if (!m) continue;
    if (m[1] && m[1] + ':' !== u.protocol) continue;
    const host = u.hostname;
    const ok = m[2] ? host.endsWith('.' + m[3]) : host === m[3];
    if (!ok) continue;
    if (m[4] && m[4] !== '*' && Number(m[4]) !== (Number(u.port) || (u.protocol === 'https:' ? 443 : 80))) continue;
    return true;
  }
  return false;
}
