/**
 * node:querystring as node has it: repeated keys parse to arrays and arrays
 * stringify to repeated keys (Next's webpack loaders pass `pageExtensions`
 * that way), `+` is a space, a value keeps any `=` after the first, custom
 * separators, maxKeys, and malformed escapes don't throw.
 */
function unescape(s: string): string {
  try { return decodeURIComponent(s); } catch {
    // (node decodes what it can: a lone or invalid %XX becomes U+FFFD or stays)
    return s.replace(/(%[0-9a-fA-F]{2})+/g, (m) => {
      const bytes = new Uint8Array(m.length / 3);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(m.slice(i * 3 + 1, i * 3 + 3), 16);
      return new TextDecoder().decode(bytes);
    });
  }
}

function stringifyPrimitive(v: unknown): string {
  if (typeof v === 'string') return v;
  if ((typeof v === 'number' && isFinite(v)) || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return '';
}

function parse(str: unknown, sep = '&', eq = '=', opts: { maxKeys?: number; decodeURIComponent?: (s: string) => string } = {}): Record<string, string | string[]> {
  const obj: Record<string, string | string[]> = Object.create(null);
  if (typeof str !== 'string' || !str.length) return obj;
  const decode = opts.decodeURIComponent ?? unescape;
  const maxKeys = opts.maxKeys ?? 1000;
  let pairs = str.split(sep || '&');
  if (maxKeys > 0) pairs = pairs.slice(0, maxKeys);
  for (const pair of pairs) {
    if (!pair) continue;
    const i = pair.indexOf(eq || '=');
    const rawK = i >= 0 ? pair.slice(0, i) : pair;
    const rawV = i >= 0 ? pair.slice(i + (eq || '=').length) : '';
    const k = decode(rawK.replace(/\+/g, ' '));
    const v = decode(rawV.replace(/\+/g, ' '));
    const have = obj[k];
    if (have === undefined) obj[k] = v;
    else if (Array.isArray(have)) have.push(v);
    else obj[k] = [have, v];
  }
  return obj;
}

function stringify(obj: unknown, sep = '&', eq = '=', opts: { encodeURIComponent?: (s: string) => string } = {}): string {
  if (obj === null || typeof obj !== 'object') return '';
  const encode = opts.encodeURIComponent ?? encodeURIComponent;
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const ks = encode(stringifyPrimitive(k)) + (eq || '=');
    if (Array.isArray(v)) for (const x of v) out.push(ks + encode(stringifyPrimitive(x)));
    else out.push(ks + encode(stringifyPrimitive(v)));
  }
  return out.join(sep || '&');
}

export function createQuerystringModule(): any {
  return {
    parse, decode: parse, stringify, encode: stringify,
    escape: (s: unknown) => encodeURIComponent(stringifyPrimitive(s)),
    unescape,
    unescapeBuffer: (s: string) => new TextEncoder().encode(unescape(s)),
  };
}
