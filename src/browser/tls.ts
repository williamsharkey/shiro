// TLS in the page (docs/BROWSER.md, "Network"): our own TLS 1.3/1.2 client
// (tlsclient.ts) over a ByteStream, so the relay only ever carries ciphertext.
//
// Trust: Mozilla's root store (public/browse/cacert.pem, from curl.se) plus any
// roots the user added (the Browser app's menu, e.g. a company proxy's CA; the
// scoreboard adds its sandbox egress CA the same way).
import { TrustedCert } from './vendor/subtls/index.js';
import type { ByteStream } from './http1';
import { tlsHandshake, type TlsSession } from './tlsclient';

type RootDb = Awaited<ReturnType<typeof TrustedCert.databaseFromPEM>>;

let rootsPromise: Promise<RootDb> | null = null;

/** Load the root store once: the bundled Mozilla roots plus `extra` PEM text. */
export function setTrustRoots(load: () => Promise<string>, extra = ''): void {
  rootsPromise = load().then((pem) => TrustedCert.databaseFromPEM(pem + '\n' + extra));
}

/** Whether setTrustRoots has run (the Browser app's, or a command's own). */
export function hasTrustRoots(): boolean { return rootsPromise !== null; }

function roots(): Promise<RootDb> {
  if (!rootsPromise) throw new Error('TLS roots not configured');
  return rootsPromise;
}

export class TlsError extends Error {
  /** The server closed the connection without answering at all. */
  silent = false;
  constructor(message: string, readonly code: 'tls-handshake' | 'tls-cert' | 'tls-version') { super(message); }
}

/** Hosts where the Chrome-shaped hello failed and the narrow one worked (for this page's lifetime). */
const narrowHosts = new Set<string>();

/** Use the narrow hello for `host` straight away (tests, diagnostics). */
export function preferNarrowHello(host: string): void { narrowHosts.add(host); }

const CERT_RE = /certificate|subjectAltName|trusted root|keyUsage|not valid now|signature does not verify|chain/i;

function classify(e: unknown, host: string): TlsError {
  if (e instanceof TlsError) return e;
  const msg = String((e as Error)?.message ?? e);
  const silent = !!(e as { silent?: boolean })?.silent;
  const code = CERT_RE.test(msg) ? 'tls-cert' : 'tls-version';
  const err = new TlsError(silent ? `${host} closed the connection on the TLS handshake` : `TLS with ${host} failed: ${msg}`, code);
  err.silent = silent;
  return err;
}

/**
 * TLS for `host` over `raw`. The first hello looks like Chrome's; if the server
 * picks something only Chrome can do, hangs up, or refuses it, and `redial`
 * can open a fresh connection, a narrow hello (only what we implement) is
 * tried and remembered for the host. A certificate failure never retries.
 */
export async function tlsConnect(raw: ByteStream, host: string, redial?: () => Promise<ByteStream>, alpn: string[] = ['http/1.1']): Promise<TlsSession> {
  const db = await roots();
  const narrow = narrowHosts.has(host);
  try {
    return await tlsHandshake(raw, host, db, { shape: narrow ? 'narrow' : 'chrome', alpn });
  } catch (e) {
    raw.close();
    const err = classify(e, host);
    if (err.code === 'tls-cert' || narrow || !redial) throw err;
  }
  const raw2 = await redial();
  try {
    const s = await tlsHandshake(raw2, host, db, { shape: 'narrow', alpn });
    narrowHosts.add(host);
    return s;
  } catch (e) {
    raw2.close();
    throw classify(e, host);
  }
}
