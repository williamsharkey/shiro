/**
 * HTTP(S) for curl/wget when the page's fetch() can't have it: a site
 * that sends no CORS headers fails in the browser with a bare "Failed to
 * fetch", though the same request is fine from a terminal. This one goes
 * over the kernel's TCP relay, with TLS in the page (src/browser/tls.ts),
 * as the Browser app's broker does: the server only relays ciphertext.
 */
import type { ByteStream, HeaderList } from '../browser/http1';
import type { NetFetcher } from '../browser/netfetch';

let fetcher: Promise<NetFetcher> | null = null;

async function makeFetcher(): Promise<NetFetcher> {
  const [{ NetFetcher }, tls, net] = await Promise.all([
    import('../browser/netfetch'), import('../browser/tls'), import('../kernel/net'),
  ]);
  if (!tls.hasTrustRoots()) {
    // the Browser app's roots: Mozilla's plus the ones the user added (a company proxy's CA)
    const { kvGet } = await import('../browser/kv');
    const extra = (await kvGet<string>('extraRoots').catch(() => undefined)) ?? '';
    tls.setTrustRoots(async () => (await fetch('browse/cacert.pem')).text(), extra);
  }
  const dial = async (host: string, port: number): Promise<ByteStream> => {
    const s = net.netStack.socket(net.AF_INET, net.SOCK_STREAM) as import('../kernel/net').KSocket;
    if (typeof s === 'number') throw new Error(`socket: ${net.errnoName(-s)}`);
    const r = await s.connectHost(host, port);
    if (r < 0) { void s.close(); throw new Error(`Failed to connect to ${host} port ${port}: ${net.errnoName(-r)}`); }
    return {
      async read() {
        const buf = new Uint8Array(64 * 1024);
        const n = await s.read(buf);
        return n > 0 ? buf.subarray(0, n) : undefined;
      },
      async write(d) {
        for (let off = 0; off < d.length;) {
          const n = await s.write(d.subarray(off));
          if (n < 0) throw new Error(`write: ${net.errnoName(-n)}`);
          off += n;
        }
      },
      close() { void s.close(); },
    };
  };
  return new NetFetcher({ dial });
}

/** Can this page reach the relay at all (a browser page, not a test in node)? */
export function relayAvailable(): boolean {
  return typeof window !== 'undefined' && typeof WebSocket !== 'undefined' && typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
}

/** fetch() over the relay: redirects followed (unless `redirect: 'manual'`), content decoded. */
export async function relayFetch(url: string, init: RequestInit = {}): Promise<Response> {
  fetcher ??= makeFetcher().catch((e) => { fetcher = null; throw e; });
  const f = await fetcher;
  const { decodeBody } = await import('../browser/netfetch');
  let method = (init.method ?? 'GET').toUpperCase();
  let body: Uint8Array | null = init.body == null ? null
    : typeof init.body === 'string' ? new TextEncoder().encode(init.body)
    : init.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
  const headers: HeaderList = [];
  new Headers(init.headers).forEach((v, k) => headers.push([k, v]));
  if (!headers.some(([k]) => k === 'user-agent')) headers.push(['user-agent', 'curl/8.22.0']);
  if (!headers.some(([k]) => k === 'accept')) headers.push(['accept', '*/*']);
  headers.push(['accept-encoding', 'gzip, deflate']);
  for (let hops = 0; ; hops++) {
    const res = await f.fetch({ url, method, headers, body, signal: init.signal ?? undefined });
    const location = res.headers.find(([k]) => k.toLowerCase() === 'location')?.[1];
    if (init.redirect !== 'manual' && location && [301, 302, 303, 307, 308].includes(res.status) && hops < 20) {
      void res.body.cancel().catch(() => {});
      url = new URL(location, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = null; }
      continue;
    }
    const ce = res.headers.find(([k]) => k.toLowerCase() === 'content-encoding')?.[1] ?? null;
    const { body: out, decoded } = decodeBody(res.body, ce);
    const h = new Headers();
    for (const [k, v] of res.headers) {
      if (decoded && (k.toLowerCase() === 'content-encoding' || k.toLowerCase() === 'content-length')) continue;
      try { h.append(k, v); } catch { /* a header Headers refuses */ }
    }
    const response = new Response([204, 205, 304].includes(res.status) || method === 'HEAD' ? null : out, { status: res.status, statusText: res.statusText, headers: h });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  }
}
