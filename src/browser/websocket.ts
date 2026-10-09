// RFC 6455 client over a ByteStream, for WebSockets that proxied pages open
// (the page runtime's WebSocket goes to the broker, which dials the real
// server through the relay and TLS in the page).
import { ByteStream, HeaderList, StreamReader, headerGet, readResponseHead, serializeRequest } from './http1';

export interface WsHandlers {
  open(protocol: string, extensions: string): void;
  message(data: string | ArrayBuffer): void;
  close(code: number, reason: string, wasClean: boolean): void;
  error(err: unknown): void;
}

const te = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function acceptFor(key: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', te.encode(key + '258EAFA5-E914-47DA-95CA-C5AB0DC11B5B'));
  return b64(new Uint8Array(d));
}

export function encodeFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = new Uint8Array(head + 4 + len);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) out[1] = 0x80 | len;
  else if (len < 65536) { out[1] = 0x80 | 126; out[2] = len >> 8; out[3] = len & 255; }
  else { out[1] = 0x80 | 127; new DataView(out.buffer).setBigUint64(2, BigInt(len)); }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  out.set(mask, head);
  for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

export class WsClient {
  private reader: StreamReader;
  private closed = false;
  private closeSent = false;
  constructor(private s: ByteStream, private h: WsHandlers) { this.reader = new StreamReader(s); }

  /** Handshake, then read frames until the connection ends. */
  async run(url: URL, headers: HeaderList, protocols: string[]): Promise<void> {
    const key = b64(crypto.getRandomValues(new Uint8Array(16)));
    const httpUrl = new URL(url.href.replace(/^ws/, 'http'));
    const req: HeaderList = [
      ['Host', httpUrl.host], ['Upgrade', 'websocket'], ['Connection', 'Upgrade'],
      ['Sec-WebSocket-Key', key], ['Sec-WebSocket-Version', '13'], ...headers,
    ];
    if (protocols.length) req.push(['Sec-WebSocket-Protocol', protocols.join(', ')]);
    await this.s.write(serializeRequest('GET', httpUrl, req, null));
    const head = await readResponseHead(this.reader);
    if (head.status !== 101) throw new Error(`WebSocket handshake: HTTP ${head.status}`);
    if (headerGet(head.headers, 'sec-websocket-accept') !== await acceptFor(key)) throw new Error('WebSocket handshake: bad accept key');
    const proto = headerGet(head.headers, 'sec-websocket-protocol') ?? '';
    if (proto && !protocols.includes(proto)) throw new Error('WebSocket handshake: unexpected subprotocol');
    this.h.open(proto, headerGet(head.headers, 'sec-websocket-extensions') ?? '');
    await this.readLoop();
  }

  private async readLoop() {
    let fragments: Uint8Array[] = [];
    let fragOp = 0;
    const td = new TextDecoder('utf-8', { fatal: true });
    try {
      for (;;) {
        const h = await this.reader.exactly(2);
        const fin = (h[0] & 0x80) !== 0;
        const op = h[0] & 0x0f;
        if (h[1] & 0x80) throw new Error('masked frame from server');
        let len = h[1] & 0x7f;
        if (len === 126) { const b = await this.reader.exactly(2); len = (b[0] << 8) | b[1]; }
        else if (len === 127) { const b = await this.reader.exactly(8); len = Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0)); }
        if (len > 64 * 1024 * 1024) throw new Error('frame too large');
        const payload = len ? (await this.reader.exactly(len)).slice() : new Uint8Array(0);
        if (op === 0x8) {
          const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
          const reason = payload.length > 2 ? new TextDecoder().decode(payload.subarray(2)) : '';
          if (!this.closeSent) await this.sendFrame(0x8, payload.subarray(0, 2));
          this.finish(code, reason, true);
          return;
        }
        if (op === 0x9) { await this.sendFrame(0xa, payload); continue; }
        if (op === 0xa) continue;
        if (op === 0x1 || op === 0x2) { fragOp = op; fragments = [payload]; }
        else if (op === 0x0) fragments.push(payload);
        else throw new Error(`bad opcode ${op}`);
        if (!fin) continue;
        let data: Uint8Array = fragments.length === 1 ? fragments[0] : new Uint8Array(fragments.reduce((n, f) => n + f.length, 0));
        if (fragments.length > 1) { let o = 0; for (const f of fragments) { data.set(f, o); o += f.length; } }
        fragments = [];
        this.h.message(fragOp === 0x1 ? td.decode(data) : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
    } catch (e) {
      if (!this.closed) { this.h.error(e); this.finish(1006, '', false); }
    }
  }

  private finish(code: number, reason: string, clean: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.s.close();
    this.h.close(code, reason, clean);
  }

  private sendFrame(op: number, payload: Uint8Array) { return this.s.write(encodeFrame(op, payload)); }

  async send(data: string | ArrayBuffer) {
    if (this.closed || this.closeSent) return;
    await this.sendFrame(typeof data === 'string' ? 0x1 : 0x2, typeof data === 'string' ? te.encode(data) : new Uint8Array(data));
  }

  async close(code = 1000, reason = '') {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    const r = te.encode(reason).subarray(0, 123);
    const p = new Uint8Array(2 + r.length);
    p[0] = code >> 8; p[1] = code & 255; p.set(r, 2);
    await this.sendFrame(0x8, p).catch(() => {});
    setTimeout(() => this.finish(code, reason, true), 3000);
  }

  abort() { this.finish(1006, '', false); }
}
