/**
 * The one hook for "this needs the internet, and the internet needs a
 * sign-in" (docs/DESKTOP.md, "Network sign-in").
 *
 * Nothing gates boot. Code that is about to make an outbound connection that
 * the server will only allow for a signed-in user calls
 * `requireNetworkSignIn({ host, port, reason })`:
 *   - with a saved credential it resolves at once (later visits connect silently);
 *   - otherwise the page's sign-in UI (the desktop's sheet, registered with
 *     `setNetworkSignInHandler`) asks once; concurrent callers share that ask;
 *   - it resolves to the credential, or null if the user said "not now" (then
 *     callers fail the way they would offline, e.g. ENETUNREACH).
 * Same-origin requests (package downloads, /api proxies) never need it:
 * `needsSignIn(url)` is false for them.
 *
 * The credential is the GitHub token `gh auth login` already saves
 * (localStorage `tabcomputer_github_token`, src/github-auth.ts).
 */

/** Same key as GITHUB_TOKEN_KEY in github-auth.ts (not imported: that module is lazy) */
const GITHUB_TOKEN_KEY = 'tabcomputer_github_token';

export interface NetworkNeed {
  /** Where the program wants to go (shown to the user) */
  host?: string;
  port?: number;
  /** Short reason, e.g. "curl wants to reach example.com" */
  reason?: string;
}

export type NetworkStatus = 'unknown' | 'online' | 'signed-in' | 'needs-sign-in' | 'offline' | 'unavailable';

type Handler = (need: NetworkNeed) => Promise<string | null>;

let handler: Handler | null = null;
let pending: Promise<string | null> | null = null;
/** "Not now" holds for a while, so a retry loop doesn't re-open the sheet every second */
let declinedUntil = 0;
const DECLINE_MS = 60_000;
let status: NetworkStatus = 'unknown';
const statusListeners = new Set<(s: NetworkStatus) => void>();

/** The saved credential (a GitHub token), if any. */
export function networkCredential(): string | null {
  try { return localStorage.getItem(GITHUB_TOKEN_KEY) || null; } catch { return null; }
}

/** Register the UI that asks the user to sign in (the desktop's sheet). Returns unregister. */
export function setNetworkSignInHandler(h: Handler): () => void {
  handler = h;
  return () => { if (handler === h) handler = null; };
}

/** True when `url` leaves this origin (only those can need a sign-in). */
export function needsSignIn(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    return u.origin !== location.origin;
  } catch { return false; }
}

/**
 * Make sure the user is signed in for outbound network. Resolves to the
 * credential, or null when there is none and the user didn't sign in.
 */
export async function requireNetworkSignIn(need: NetworkNeed = {}): Promise<string | null> {
  const saved = networkCredential();
  if (saved) return saved;
  if (pending) return pending;
  if (!handler || Date.now() < declinedUntil) return null;
  pending = handler(need).then((tok) => {
    if (!tok) declinedUntil = Date.now() + DECLINE_MS;
    else setNetworkStatus('signed-in');
    return tok;
  }, () => null).finally(() => { pending = null; });
  return pending;
}

/** Forget a "not now" (the user opened the sheet themselves). */
export function resetNetworkDecline(): void {
  declinedUntil = 0;
}

export function networkStatus(): NetworkStatus {
  return status;
}

export function setNetworkStatus(s: NetworkStatus): void {
  if (s === status) return;
  status = s;
  for (const cb of statusListeners) { try { cb(s); } catch {} }
}

export function onNetworkStatus(cb: (s: NetworkStatus) => void): () => void {
  statusListeners.add(cb);
  return () => { statusListeners.delete(cb); };
}

// Other bundles (seeded pages, worker hosts) reach it without importing
(globalThis as any).__shiroRequireNetwork = requireNetworkSignIn;

// ── "Use my own connection" ──────────────────────────────────────────

/** A relay the user chose instead of this site's (Settings → Network). */
export interface OwnRelay {
  /** ws:// or wss:// URL of a TCP relay speaking docs/NETWORKING.md's protocol */
  url: string;
  /** POST endpoint returning {token, expires}, if that relay wants one */
  tokenUrl?: string;
}

const RELAY_KEY = 'tabcomputer_relay';
const relayListeners = new Set<(r: OwnRelay | null) => void>();

/** The user's own relay, or null for this site's. */
export function ownRelay(): OwnRelay | null {
  try {
    const r = JSON.parse(localStorage.getItem(RELAY_KEY) || 'null');
    return r && typeof r.url === 'string' && /^wss?:\/\//.test(r.url) ? { url: r.url, ...(r.tokenUrl ? { tokenUrl: String(r.tokenUrl) } : {}) } : null;
  } catch { return null; }
}

/** Choose a relay (null = this site's). Throws on a URL that isn't ws(s)://. */
export function setOwnRelay(r: OwnRelay | null): void {
  if (r) {
    if (!/^wss?:\/\/[^/\s]+/.test(r.url)) throw new Error('The relay URL must start with ws:// or wss://');
    if (r.tokenUrl && !/^https?:\/\/[^/\s]+/.test(r.tokenUrl)) throw new Error('The token URL must start with http:// or https://');
  }
  try {
    if (r) localStorage.setItem(RELAY_KEY, JSON.stringify(r)); else localStorage.removeItem(RELAY_KEY);
  } catch {}
  for (const cb of relayListeners) { try { cb(r); } catch {} }
}

export function onOwnRelayChange(cb: (r: OwnRelay | null) => void): () => void {
  relayListeners.add(cb);
  return () => { relayListeners.delete(cb); };
}

/**
 * NetStack settings for the current choice: the user's relay (no token unless
 * they gave a URL, and never their GitHub sign-in), or this site's /tcp.
 */
export function relayNetConfig(loc: Pick<Location, 'protocol' | 'host'> = location): { relayUrl: string | null; tokenUrl: string | null; credentials: boolean } {
  const own = ownRelay();
  if (own) return { relayUrl: own.url, tokenUrl: own.tokenUrl ?? null, credentials: false };
  const web = (loc.protocol === 'https:' || loc.protocol === 'http:') && !!loc.host;
  return {
    relayUrl: web ? `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/tcp` : null,
    tokenUrl: web ? `${loc.protocol}//${loc.host}/tcp/token` : null,
    credentials: true,
  };
}
