// TLS in the page (docs/BROWSER.md, "Network"): subtls (MIT, TLS 1.3 on
// WebCrypto) over a ByteStream, so the relay only ever carries ciphertext.
//
// Trust: Mozilla's root store (public/browse/cacert.pem, from curl.se) plus any
// roots the user added (Settings in the Browser app, e.g. a company proxy's CA;
// the scoreboard adds its sandbox egress CA the same way).
import { LazyReadFunctionReadQueue, startTls, TrustedCert } from './vendor/subtls/index.js';
import type { ByteStream } from './http1';
import { tls12Connect } from './tls12';

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

/** Hosts that refused TLS 1.3 (for this page's lifetime): they go straight to TLS 1.2. */
const tls12Hosts = new Set<string>();

/**
 * TLS for `host` over `raw`: 1.3 (subtls) first; when the server refuses it and
 * `redial` can open a fresh connection, 1.2 (tls12.ts), remembered per host.
 */
export async function tlsConnect(raw: ByteStream, host: string, redial?: () => Promise<ByteStream>): Promise<ByteStream> {
  if (redial && tls12Hosts.has(host)) return tls12(raw, host);
  try {
    return await tls13Connect(raw, host);
  } catch (e) {
    // Any 1.3 failure that isn't about the certificate (no 1.3, a HelloRetryRequest subtls can't do, an
    // odd extension) retries as 1.2; a certificate failure never does. An attacker who can drop packets
    // could force the retry too; it still lands on ECDHE + AEAD + extended master secret.
    if (!(e instanceof TlsError) || e.code === 'tls-cert' || !redial) throw e;
    const s = await tls12(await redial(), host);
    tls12Hosts.add(host);
    return s;
  }
}

async function tls12(raw: ByteStream, host: string): Promise<ByteStream> {
  try {
    return await tls12Connect(raw, host, await roots());
  } catch (e) {
    raw.close();
    const msg = String((e as Error)?.message ?? e);
    throw new TlsError(`TLS 1.2 with ${host} failed: ${msg}`, /certificate|chain|signature|trusted/i.test(msg) ? 'tls-cert' : 'tls-version');
  }
}

async function tls13Connect(raw: ByteStream, host: string): Promise<ByteStream> {
  const db = await roots();
  let received = 0;
  const q = new LazyReadFunctionReadQueue(async () => { const d = await raw.read(); received += d?.length ?? 0; return d; });
  let session: Awaited<ReturnType<typeof startTls>>;
  try {
    session = await startTls(host, db, q.read.bind(q), (d: Uint8Array) => { void raw.write(d).catch(() => {}); });
  } catch (e) {
    raw.close();
    const msg = String((e as Error)?.message ?? e);
    // subtls speaks only TLS 1.3: a 1.2-only server answers with a 1.2 ServerHello or a protocol_version alert
    // A TLS 1.2-only server often just hangs up on a 1.3-only ClientHello (Craigslist does)
    const code = received === 0 ? 'tls-version'
      : /cert|signature|root|trust|expired|subject/i.test(msg) ? 'tls-cert'
      : /version|alert|Unexpected TLS record|0x0303|supported_versions|Expected 771, got 76[89]/i.test(msg) ? 'tls-version' : 'tls-handshake';
    throw new TlsError(received === 0 ? `${host} closed the connection on a TLS 1.3 handshake (it may only speak TLS 1.2)` : `TLS with ${host} failed: ${msg}`, code);
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
