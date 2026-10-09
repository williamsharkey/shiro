// TLS in the page (docs/BROWSER.md, "Network"): subtls (MIT, TLS 1.3 on
// WebCrypto) over a ByteStream, so the relay only ever carries ciphertext.
//
// Trust: Mozilla's root store (public/browse/cacert.pem, from curl.se) plus any
// roots the user added (Settings in the Browser app, e.g. a company proxy's CA;
// the scoreboard adds its sandbox egress CA the same way).
import { LazyReadFunctionReadQueue, startTls, TrustedCert } from 'subtls';
import type { ByteStream } from './http1';

type RootDb = Awaited<ReturnType<typeof TrustedCert.databaseFromPEM>>;

let rootsPromise: Promise<RootDb> | null = null;
let extraPem = '';

/** Load the root store once: the bundled Mozilla roots plus `extra` PEM text. */
export function setTrustRoots(load: () => Promise<string>, extra = ''): void {
  extraPem = extra;
  rootsPromise = load().then((pem) => TrustedCert.databaseFromPEM(pem + '\n' + extraPem));
}

function roots(): Promise<RootDb> {
  if (!rootsPromise) throw new Error('TLS roots not configured');
  return rootsPromise;
}

export class TlsError extends Error {
  constructor(message: string, readonly code: 'tls-handshake' | 'tls-cert' | 'tls-version') { super(message); }
}

/** Wrap a connected stream in TLS 1.3 for `host`; resolves once the handshake verified the server. */
export async function tlsConnect(raw: ByteStream, host: string): Promise<ByteStream> {
  const db = await roots();
  const q = new LazyReadFunctionReadQueue(() => raw.read());
  let session: Awaited<ReturnType<typeof startTls>>;
  try {
    session = await startTls(host, db, q.read.bind(q), (d: Uint8Array) => { void raw.write(d).catch(() => {}); });
  } catch (e) {
    raw.close();
    const msg = String((e as Error)?.message ?? e);
    // subtls speaks only TLS 1.3: a 1.2-only server answers with a 1.2 ServerHello or a protocol_version alert
    const code = /cert|signature|root|trust|expired|subject/i.test(msg) ? 'tls-cert'
      : /version|alert|Unexpected TLS record|0x0303|supported_versions/i.test(msg) ? 'tls-version' : 'tls-handshake';
    throw new TlsError(`TLS with ${host} failed: ${msg}`, code);
  }
  let closed = false;
  return {
    async read() {
      if (closed) return undefined;
      try { return await session.read(); } catch (e) { if (closed) return undefined; throw e; }
    },
    write: (d) => session.write(d),
    close() { closed = true; raw.close(); },
  };
}
