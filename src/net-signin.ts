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
 * (localStorage `shiro_github_token`, src/github-auth.ts).
 */

/** Same key as GITHUB_TOKEN_KEY in github-auth.ts (not imported: that module is lazy) */
const GITHUB_TOKEN_KEY = 'shiro_github_token';

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
