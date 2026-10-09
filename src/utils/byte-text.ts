/**
 * Byte-exact text: commands with string stdio (src/commands) carry binary
 * data through strings without losing it.
 *
 * Bytes that are not valid UTF-8 decode to lone surrogates U+DC80–U+DCFF
 * (Python's "surrogateescape"), and encoding turns those back into the same
 * bytes. Valid UTF-8 decodes as usual, so `cat binary > copy`, `head -c`,
 * pipes and redirections keep every byte. A plain TextDecoder would turn each
 * invalid byte into U+FFFD (3 bytes when written back), so a 1000-byte binary
 * came out as ~2000 bytes.
 *
 * The fast paths are the native TextDecoder/TextEncoder: valid input costs
 * one decode, and a string without lone surrogates one
 * isWellFormed() scan.
 */

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Bytes → string; invalid UTF-8 bytes become U+DC80+byte. */
export function decodeBytes(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes);
  } catch {
    return decodeEscaped(bytes);
  }
}

/** String → bytes; U+DC80–U+DCFF lone surrogates become the bytes they stand for. */
export function encodeText(s: string): Uint8Array {
  if (isWellFormed(s)) return encoder.encode(s);
  return encodeEscaped(s);
}

/** Byte length of encodeText(s), without allocating for well-formed ASCII-heavy strings. */
export function byteLength(s: string): number {
  if (!isWellFormed(s)) return encodeEscaped(s).length;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

const wellFormed: ((s: string) => boolean) | null =
  typeof (String.prototype as { isWellFormed?: unknown }).isWellFormed === 'function'
    ? (s) => (s as unknown as { isWellFormed(): boolean }).isWellFormed()
    : null;

function isWellFormed(s: string): boolean {
  if (wellFormed) return wellFormed(s);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function decodeEscaped(b: Uint8Array): string {
  const out: string[] = [];
  const units: number[] = [];
  const flush = () => { if (units.length) { out.push(String.fromCharCode.apply(null, units)); units.length = 0; } };
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) { units.push(c); i++; }
    else {
      let need = 0, cp = 0, min = 0;
      if (c >= 0xc2 && c <= 0xdf) { need = 1; cp = c & 0x1f; min = 0x80; }
      else if (c >= 0xe0 && c <= 0xef) { need = 2; cp = c & 0x0f; min = 0x800; }
      else if (c >= 0xf0 && c <= 0xf4) { need = 3; cp = c & 0x07; min = 0x10000; }
      let ok = need > 0 && i + need < n;
      if (ok) {
        for (let k = 1; k <= need; k++) {
          const d = b[i + k];
          if (d === undefined || (d & 0xc0) !== 0x80) { ok = false; break; }
          cp = (cp << 6) | (d & 0x3f);
        }
      }
      if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
      if (!ok) { units.push(0xdc00 + c); i++; }
      else if (cp >= 0x10000) { cp -= 0x10000; units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); i += need + 1; }
      else { units.push(cp); i += need + 1; }
    }
    if (units.length >= 8192) flush();
  }
  flush();
  return out.join('');
}

function encodeEscaped(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 3);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out[o++] = 0xf0 | (cp >> 18); out[o++] = 0x80 | ((cp >> 12) & 0x3f);
        out[o++] = 0x80 | ((cp >> 6) & 0x3f); out[o++] = 0x80 | (cp & 0x3f);
        i++;
        continue;
      }
      c = 0xfffd; // lone high surrogate
    } else if (c >= 0xdc80 && c <= 0xdcff) {
      out[o++] = c - 0xdc00; // an escaped byte
      continue;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd; // other lone low surrogate
    }
    if (c < 0x80) out[o++] = c;
    else if (c < 0x800) { out[o++] = 0xc0 | (c >> 6); out[o++] = 0x80 | (c & 0x3f); }
    else { out[o++] = 0xe0 | (c >> 12); out[o++] = 0x80 | ((c >> 6) & 0x3f); out[o++] = 0x80 | (c & 0x3f); }
  }
  return out.subarray(0, o);
}
