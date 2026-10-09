// The server-side fetch transport: the server makes the request and sees it
// in plaintext. For local measurement only (docs/BROWSER.md, "Decisions"):
// the server offers it only with TABCOMPUTER_BROWSE_SERVER_FETCH=1, and the app
// uses it only when also asked to (kv "transport" = "server").
import type { HeaderList } from './http1';
import type { Fetcher, NetRequest, NetResponse } from './netfetch';

export class ServerFetcher implements Fetcher {
  stats = { connects: 0, reused: 0, requests: 0, bytes: 0 };
  constructor(private endpoint = 'browse/fetch') {}

  async fetch(req: NetRequest): Promise<NetResponse> {
    this.stats.requests++;
    const body = req.body instanceof ReadableStream ? new Uint8Array(await new Response(req.body).arrayBuffer()) : req.body;
    const r = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'x-tc-url': req.url, 'x-tc-method': req.method, 'x-tc-headers': encodeURIComponent(JSON.stringify(req.headers)) },
      body: body as BodyInit | null,
      signal: req.signal,
    });
    const status = r.headers.get('x-tc-status');
    if (!status) throw new Error(`server fetch: ${r.status} ${await r.text()}`);
    const headers = JSON.parse(decodeURIComponent(r.headers.get('x-tc-headers') || '%5B%5D')) as HeaderList;
    let bytes = 0;
    const counted = r.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (c, ctl) => { bytes += c.length; this.stats.bytes += c.length; ctl.enqueue(c); },
    }));
    return {
      status: Number(status), statusText: decodeURIComponent(r.headers.get('x-tc-status-text') || ''), headers, body: counted,
      reusable: Promise.resolve(true), url: req.url, wireBytes: () => bytes,
    };
  }

  closeAll() {}
}
