// HPACK (RFC 7541) for the Browser app's HTTP/2 client: the full decoder
// (static and dynamic tables, Huffman) and a simple encoder (literal fields,
// static-table names, no dynamic-table insertions, no Huffman).

export type Header = [string, string];

const STATIC: Header[] = [
  [':authority', ''], [':method', 'GET'], [':method', 'POST'], [':path', '/'], [':path', '/index.html'], [':scheme', 'http'],
  [':scheme', 'https'], [':status', '200'], [':status', '204'], [':status', '206'], [':status', '304'], [':status', '400'],
  [':status', '404'], [':status', '500'], ['accept-charset', ''], ['accept-encoding', 'gzip, deflate'], ['accept-language', ''],
  ['accept-ranges', ''], ['accept', ''], ['access-control-allow-origin', ''], ['age', ''], ['allow', ''], ['authorization', ''],
  ['cache-control', ''], ['content-disposition', ''], ['content-encoding', ''], ['content-language', ''], ['content-length', ''],
  ['content-location', ''], ['content-range', ''], ['content-type', ''], ['cookie', ''], ['date', ''], ['etag', ''], ['expect', ''],
  ['expires', ''], ['from', ''], ['host', ''], ['if-match', ''], ['if-modified-since', ''], ['if-none-match', ''], ['if-range', ''],
  ['if-unmodified-since', ''], ['last-modified', ''], ['link', ''], ['location', ''], ['max-forwards', ''], ['proxy-authenticate', ''],
  ['proxy-authorization', ''], ['range', ''], ['referer', ''], ['refresh', ''], ['retry-after', ''], ['server', ''], ['set-cookie', ''],
  ['strict-transport-security', ''], ['transfer-encoding', ''], ['user-agent', ''], ['vary', ''], ['via', ''], ['www-authenticate', ''],
];
const STATIC_NAME = new Map<string, number>();
STATIC.forEach(([n], i) => { if (!STATIC_NAME.has(n)) STATIC_NAME.set(n, i + 1); });

// RFC 7541 Appendix B: code (hex):bits for symbols 0..256 (256 = EOS)
const HUFF_TABLE =
  '1ff8:13,7fffd8:23,fffffe2:28,fffffe3:28,fffffe4:28,fffffe5:28,fffffe6:28,fffffe7:28,fffffe8:28,' +
  'ffffea:24,3ffffffc:30,fffffe9:28,fffffea:28,3ffffffd:30,fffffeb:28,fffffec:28,fffffed:28,fffffee:28,' +
  'fffffef:28,ffffff0:28,ffffff1:28,ffffff2:28,3ffffffe:30,ffffff3:28,ffffff4:28,ffffff5:28,ffffff6:28,' +
  'ffffff7:28,ffffff8:28,ffffff9:28,ffffffa:28,ffffffb:28,14:6,3f8:10,3f9:10,ffa:12,1ff9:13,15:6,f8:8,' +
  '7fa:11,3fa:10,3fb:10,f9:8,7fb:11,fa:8,16:6,17:6,18:6,0:5,1:5,2:5,19:6,1a:6,1b:6,1c:6,1d:6,1e:6,1f:6,' +
  '5c:7,fb:8,7ffc:15,20:6,ffb:12,3fc:10,1ffa:13,21:6,5d:7,5e:7,5f:7,60:7,61:7,62:7,63:7,64:7,65:7,66:7,' +
  '67:7,68:7,69:7,6a:7,6b:7,6c:7,6d:7,6e:7,6f:7,70:7,71:7,72:7,fc:8,73:7,fd:8,1ffb:13,7fff0:19,1ffc:13,' +
  '3ffc:14,22:6,7ffd:15,3:5,23:6,4:5,24:6,5:5,25:6,26:6,27:6,6:5,74:7,75:7,28:6,29:6,2a:6,7:5,2b:6,76:7,' +
  '2c:6,8:5,9:5,2d:6,77:7,78:7,79:7,7a:7,7b:7,7ffe:15,7fc:11,3ffd:14,1ffd:13,ffffffc:28,fffe6:20,' +
  '3fffd2:22,fffe7:20,fffe8:20,3fffd3:22,3fffd4:22,3fffd5:22,7fffd9:23,3fffd6:22,7fffda:23,7fffdb:23,' +
  '7fffdc:23,7fffdd:23,7fffde:23,ffffeb:24,7fffdf:23,ffffec:24,ffffed:24,3fffd7:22,7fffe0:23,ffffee:24,' +
  '7fffe1:23,7fffe2:23,7fffe3:23,7fffe4:23,1fffdc:21,3fffd8:22,7fffe5:23,3fffd9:22,7fffe6:23,7fffe7:23,' +
  'ffffef:24,3fffda:22,1fffdd:21,fffe9:20,3fffdb:22,3fffdc:22,7fffe8:23,7fffe9:23,1fffde:21,7fffea:23,' +
  '3fffdd:22,3fffde:22,fffff0:24,1fffdf:21,3fffdf:22,7fffeb:23,7fffec:23,1fffe0:21,1fffe1:21,3fffe0:22,' +
  '1fffe2:21,7fffed:23,3fffe1:22,7fffee:23,7fffef:23,fffea:20,3fffe2:22,3fffe3:22,3fffe4:22,7ffff0:23,' +
  '3fffe5:22,3fffe6:22,7ffff1:23,3ffffe0:26,3ffffe1:26,fffeb:20,7fff1:19,3fffe7:22,7ffff2:23,3fffe8:22,' +
  '1ffffec:25,3ffffe2:26,3ffffe3:26,3ffffe4:26,7ffffde:27,7ffffdf:27,3ffffe5:26,fffff1:24,1ffffed:25,' +
  '7fff2:19,1fffe3:21,3ffffe6:26,7ffffe0:27,7ffffe1:27,3ffffe7:26,7ffffe2:27,fffff2:24,1fffe4:21,' +
  '1fffe5:21,3ffffe8:26,3ffffe9:26,ffffffd:28,7ffffe3:27,7ffffe4:27,7ffffe5:27,fffec:20,fffff3:24,' +
  'fffed:20,1fffe6:21,3fffe9:22,1fffe7:21,1fffe8:21,7ffff3:23,3fffea:22,3fffeb:22,1ffffee:25,1ffffef:25,' +
  'fffff4:24,fffff5:24,3ffffea:26,7ffff4:23,3ffffeb:26,7ffffe6:27,3ffffec:26,3ffffed:26,7ffffe7:27,' +
  '7ffffe8:27,7ffffe9:27,7ffffea:27,7ffffeb:27,ffffffe:28,7ffffec:27,7ffffed:27,7ffffee:27,7ffffef:27,' +
  '7fffff0:27,3ffffee:26,3fffffff:30';

interface Node { sym?: number; kids?: [Node | undefined, Node | undefined] }
let huffRoot: Node | null = null;
function huffTree(): Node {
  if (huffRoot) return huffRoot;
  const root: Node = {};
  HUFF_TABLE.split(',').forEach((e, sym) => {
    const [hex, bits] = e.split(':');
    const code = parseInt(hex, 16), n = Number(bits);
    let node = root;
    for (let i = n - 1; i >= 0; i--) {
      const b = (code >>> i) & 1;
      node.kids ??= [undefined, undefined];
      node = node.kids[b] ??= {};
    }
    node.sym = sym;
  });
  huffRoot = root;
  return root;
}

export function huffmanDecode(data: Uint8Array): string {
  const root = huffTree();
  const out: number[] = [];
  let node = root;
  let depth = 0, ones = true;
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) {
      const b = (byte >> i) & 1;
      node = node.kids?.[b] as Node;
      if (!node) throw new Error('HPACK: bad Huffman code');
      depth++;
      ones &&= b === 1;
      if (node.sym !== undefined) {
        if (node.sym === 256) throw new Error('HPACK: EOS in string');
        out.push(node.sym);
        node = root; depth = 0; ones = true;
      }
    }
  }
  // Padding: at most 7 bits, all ones (a prefix of EOS)
  if (depth > 7 || !ones) throw new Error('HPACK: bad Huffman padding');
  return new TextDecoder('latin1').decode(new Uint8Array(out));
}

class In {
  o = 0;
  constructor(private b: Uint8Array) {}
  get done() { return this.o >= this.b.length; }
  byte() { if (this.o >= this.b.length) throw new Error('HPACK: truncated'); return this.b[this.o++]; }
  int(prefix: number, first: number): number {
    const max = (1 << prefix) - 1;
    let v = first & max;
    if (v < max) return v;
    let m = 0, b: number;
    do { b = this.byte(); v += (b & 127) * 2 ** m; m += 7; if (m > 35) throw new Error('HPACK: integer too large'); } while (b & 128);
    return v;
  }
  str(): string {
    const f = this.byte();
    const len = this.int(7, f);
    if (this.o + len > this.b.length) throw new Error('HPACK: truncated string');
    const raw = this.b.subarray(this.o, this.o + len);
    this.o += len;
    return f & 128 ? huffmanDecode(raw) : new TextDecoder('latin1').decode(raw);
  }
}

export class HpackDecoder {
  private dyn: Header[] = [];
  private size = 0;
  constructor(private maxSize = 4096, private allowedMax = 4096) {}
  private get(i: number): Header {
    if (i <= 0) throw new Error('HPACK: index 0');
    if (i <= STATIC.length) return STATIC[i - 1];
    const d = this.dyn[i - STATIC.length - 1];
    if (!d) throw new Error('HPACK: index out of range');
    return d;
  }
  private add(h: Header) {
    const s = h[0].length + h[1].length + 32;
    this.dyn.unshift(h);
    this.size += s;
    this.evict();
  }
  private evict() {
    while (this.size > this.maxSize && this.dyn.length) { const x = this.dyn.pop()!; this.size -= x[0].length + x[1].length + 32; }
  }
  decode(block: Uint8Array): Header[] {
    const r = new In(block);
    const out: Header[] = [];
    while (!r.done) {
      const b = r.byte();
      if (b & 128) out.push(this.get(r.int(7, b)));                               // indexed
      else if (b & 64) {                                                           // literal, incremental indexing
        const idx = r.int(6, b);
        const h: Header = [idx ? this.get(idx)[0] : r.str(), r.str()];
        this.add(h); out.push(h);
      } else if (b & 32) {                                                         // dynamic table size update
        const s = r.int(5, b);
        if (s > this.allowedMax) throw new Error('HPACK: table size above the limit');
        this.maxSize = s; this.evict();
      } else {                                                                     // literal without / never indexed
        const idx = r.int(4, b);
        out.push([idx ? this.get(idx)[0] : r.str(), r.str()]);
      }
    }
    return out;
  }
}

const enc = new TextEncoder();
function intBytes(v: number, prefix: number, flags: number): number[] {
  const max = (1 << prefix) - 1;
  if (v < max) return [flags | v];
  const out = [flags | max];
  v -= max;
  while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128); }
  out.push(v);
  return out;
}
function strBytes(s: string): number[] {
  const b = enc.encode(s);
  return [...intBytes(b.length, 7, 0), ...b];
}

/** Literal header fields without indexing; names from the static table when it has them. */
export function hpackEncode(headers: Header[]): Uint8Array {
  const out: number[] = [];
  for (const [name, value] of headers) {
    const exact = STATIC.findIndex(([n, v]) => n === name && v === value && v !== '');
    if (exact >= 0) { out.push(...intBytes(exact + 1, 7, 128)); continue; }
    const idx = STATIC_NAME.get(name);
    if (idx) out.push(...intBytes(idx, 4, 0), ...strBytes(value));
    else out.push(0, ...strBytes(name), ...strBytes(value));
  }
  return new Uint8Array(out);
}
