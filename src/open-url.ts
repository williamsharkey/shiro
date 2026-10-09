/**
 * Opening a web page in a real browser tab for a program running here
 * (`open URL`, `xdg-open URL`, $BROWSER). A program that runs long after the
 * user's last click (native Claude Code signing in under the x86 emulator)
 * has no user activation left, so the browser blocks window.open. Then the
 * page offers the link instead: a small card the user clicks, which always
 * works. Either way the caller returns at once, as xdg-open does.
 */

/** Claude Code's OAuth client (its sign-in URLs carry it). */
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Where Claude Code's manual sign-in sends the browser: a page showing the code to paste. */
export const CLAUDE_MANUAL_REDIRECT = 'https://platform.claude.com/oauth/code/callback';

/**
 * Claude Code's automatic sign-in URL redirects to a localhost server inside
 * this machine, which the user's browser can't reach. Its manual twin (same
 * state and PKCE challenge) redirects to a page that shows a code to paste
 * into Claude Code's "Paste code here" prompt. Other URLs are unchanged.
 */
export function manualSignInUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (!/\/oauth\/authorize$/.test(u.pathname) || u.searchParams.get('client_id') !== CLAUDE_CLIENT_ID) return url;
  const redirect = u.searchParams.get('redirect_uri') ?? '';
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(redirect)) return url;
  u.searchParams.set('redirect_uri', CLAUDE_MANUAL_REDIRECT);
  u.searchParams.set('code', 'true');
  return u.toString();
}

const OFFER_ID = 'tabcomputer-open-offer';

/** A card with the link, for when the browser blocked the new tab. */
function offer(url: string): void {
  document.getElementById(OFFER_ID)?.remove();
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw text */ }
  const card = document.createElement('div');
  card.id = OFFER_ID;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Open a page');
  card.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:min(360px,calc(100vw - 32px));'
    + 'background:#1f2335;color:#e6e6f0;border:1px solid #3d3d5c;border-radius:10px;padding:12px 14px;'
    + 'font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center';
  const text = document.createElement('div');
  text.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere';
  text.textContent = `A program wants to open ${host}.`;
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open';
  link.style.cssText = 'background:#7aa2f7;color:#10121a;text-decoration:none;font-weight:600;padding:6px 12px;border-radius:6px;white-space:nowrap';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText = 'background:none;border:0;color:inherit;font-size:18px;cursor:pointer;padding:0 2px';
  const done = () => card.remove();
  link.addEventListener('click', () => setTimeout(done, 0));
  close.addEventListener('click', done);
  card.append(text, link, close);
  document.body.appendChild(card);
  setTimeout(done, 10 * 60_000);
}

/** Open `url` in a new tab, or offer it when the browser blocks that. */
export function openUrl(url: string): 'opened' | 'offered' | 'unavailable' {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'unavailable';
  let w: Window | null = null;
  // Without 'noopener' so a blocked open is visible (null); the opener is cut below
  try { w = window.open(url, '_blank'); } catch { w = null; }
  if (w) {
    try { w.opener = null; } catch { /* cross-origin already */ }
    return 'opened';
  }
  offer(url);
  return 'offered';
}
