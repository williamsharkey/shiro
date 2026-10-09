/**
 * Network status in the menu bar, and the sign-in sheet behind
 * requireNetworkSignIn (src/net-signin.ts): the desktop boots straight to
 * work; the first time a program needs outbound network that requires a
 * sign-in, a non-blocking sheet offers "Sign in with GitHub" (OAuth device
 * flow, src/github-auth.ts). The token is saved, so later visits connect
 * silently.
 */

import {
  networkCredential, networkStatus, onNetworkStatus, setNetworkSignInHandler, setNetworkStatus,
  resetNetworkDecline, ownRelay, onOwnRelayChange, relayNetConfig, type NetworkNeed, type NetworkStatus,
} from '../net-signin';
import { netStackOf } from '../kernel/net';
import type { Kernel } from '../kernel/kernel';
import type { FileSystem } from '../filesystem';
import type { WindowManager } from './wm';
import { GLYPHS } from './icons';

const GLOBE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.7 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.7-3.8-9S9.4 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;

let root: HTMLElement;
let fsRef: FileSystem;
let wmRef: WindowManager;
let current: { el: HTMLElement; done: (tok: string | null) => void; promise: Promise<string | null> } | null = null;

export function initNetwork(wm: WindowManager, fs: FileSystem, button: HTMLElement, kernel?: Kernel): void {
  root = wm.root;
  fsRef = fs;
  wmRef = wm;
  // "Use my own connection" (Settings → Network) points the kernel's sockets at the user's relay
  const applyRelay = () => { if (kernel) netStackOf(kernel)?.configure(relayNetConfig()); };
  applyRelay();
  onOwnRelayChange(() => { applyRelay(); setNetworkStatus(navigator.onLine ? 'online' : 'offline'); });
  setNetworkSignInHandler((need) => showSignInSheet(need));
  const initial: NetworkStatus = !navigator.onLine ? 'offline' : networkCredential() ? 'signed-in' : 'online';
  setNetworkStatus(initial);
  window.addEventListener('online', () => setNetworkStatus(networkCredential() ? 'signed-in' : 'online'));
  window.addEventListener('offline', () => setNetworkStatus('offline'));
  const paint = (s: NetworkStatus) => {
    // Globe + status dot: green signed in, blue online, amber needs sign-in, gray offline
    button.innerHTML = `${GLYPHS.net}<span class="sd-net-dot"></span>`;
    button.title = statusText(s);
    button.setAttribute('aria-label', `Network: ${statusText(s)}`);
    button.dataset.status = s;
  };
  paint(networkStatus());
  onNetworkStatus(paint);
  button.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(wm, button); });
}

export function statusText(s: NetworkStatus): string {
  switch (s) {
    case 'signed-in': return 'Connected — signed in';
    case 'online': return 'Online';
    case 'needs-sign-in': return 'Sign in to connect to the internet';
    case 'offline': return 'Offline';
    case 'unavailable': return 'Internet relay is off on this server';
    default: return 'Checking…';
  }
}

/**
 * Check a relay of the user's own: fetch a token if it has a token URL, then
 * open (and close) a WebSocket. Resolves to null when reachable, else why not.
 */
export async function testOwnRelay(url: string, tokenUrl?: string, timeoutMs = 6000): Promise<string | null> {
  let token: string | null = null;
  if (tokenUrl) {
    try {
      const r = await fetch(tokenUrl, { method: 'POST' });
      if (!r.ok) return `token request answered ${r.status}`;
      token = (await r.json())?.token ?? null;
    } catch (e) { return `token request failed (${(e as Error)?.message ?? e}; is this site allowed by its CORS/origin list?)`; }
  }
  return new Promise((resolve) => {
    let ws: WebSocket;
    try { ws = new WebSocket(token ? `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : url); }
    catch (e) { resolve(`bad URL: ${(e as Error)?.message ?? e}`); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve('no answer within 6 s'); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(null); };
    ws.onerror = () => { clearTimeout(timer); resolve('the relay refused the connection (wrong URL, not running, or this site is not in its allowed origins)'); };
  });
}

/** Ask the relay whether it would let this browser connect: updates the status. */
export async function probeRelay(): Promise<NetworkStatus> {
  if (!navigator.onLine) { setNetworkStatus('offline'); return 'offline'; }
  const own = ownRelay();
  if (own) {
    const err = await testOwnRelay(own.url, own.tokenUrl);
    const s: NetworkStatus = err ? 'unavailable' : 'online';
    setNetworkStatus(s);
    return s;
  }
  const cred = networkCredential();
  try {
    const res = await fetch('/tcp/token', { method: 'POST', credentials: 'same-origin', ...(cred ? { headers: { Authorization: `Bearer ${cred}` } } : {}) });
    const s: NetworkStatus = res.ok ? (cred ? 'signed-in' : 'online') : res.status === 401 ? 'needs-sign-in' : res.status === 404 ? 'unavailable' : 'online';
    setNetworkStatus(s);
    return s;
  } catch {
    setNetworkStatus('offline');
    return 'offline';
  }
}

/** The GitHub login of the saved token, if it is still valid. */
export async function signedInAccount(): Promise<string | null> {
  const tok = networkCredential();
  if (!tok) return null;
  try {
    const res = await fetch('/api/github/user', { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    return (await res.json())?.login ?? null;
  } catch { return null; }
}

export function signOut(): void {
  try { localStorage.removeItem('tabcomputer_github_token'); } catch {}
  setNetworkStatus(navigator.onLine ? 'online' : 'offline');
}

/** Open the sheet on purpose (Settings, the menu bar): resolves to the token or null. */
export function openSignIn(need: NetworkNeed = {}): Promise<string | null> {
  resetNetworkDecline();
  return showSignInSheet({ reason: need.reason ?? 'Sign in to let programs on this computer reach the internet.', ...need }, true);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function showSignInSheet(need: NetworkNeed, manual = false): Promise<string | null> {
  if (current) return current.promise;
  const sheet = el('div', 'sd-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Connect to the internet');
  let resolveFn!: (tok: string | null) => void;
  const promise = new Promise<string | null>((r) => { resolveFn = r; });
  const abort = new AbortController();
  const done = (tok: string | null) => {
    if (!current || current.el !== sheet) return;
    current = null;
    abort.abort();
    sheet.classList.add('sd-leaving');
    setTimeout(() => sheet.remove(), 220);
    resolveFn(tok);
  };
  current = { el: sheet, done, promise };

  const what = need.host ? `${esc(need.reason ?? 'A program wants to connect')} (${esc(need.host)}${need.port ? ':' + need.port : ''}).` : esc(need.reason ?? 'A program wants to connect to the internet.');
  const ask = () => {
    sheet.innerHTML = `
      <div class="sd-sheet-head"><div class="sd-sheet-icon">${GLOBE}</div><div>
        <h3>Connect to the internet</h3>
        <p>${what} ${manual ? '' : 'Sign in once to turn on outbound connections for this computer; you can keep working meanwhile.'}</p>
      </div></div>
      <div class="sd-sheet-actions">
        <button class="sd-link sd-small" data-act="other" type="button">Other ways to connect</button>
        <span class="sd-grow"></span>
        <button class="sd-btn" data-act="later" type="button">Not now</button>
        <button class="sd-btn sd-primary" data-act="github" type="button">Sign in with GitHub</button>
      </div>
      <div class="sd-other sd-small sd-muted" hidden style="margin-top:10px">
        Use your own connection: point this computer at a TCP relay you run
        (<button class="sd-link" data-act="own" type="button">set it up in Settings</button>);
        your GitHub sign-in is never sent to it. Downloads from this site
        (like <code>apt install</code>) never need a sign-in.
      </div>`;
    sheet.querySelector<HTMLElement>('[data-act=github]')!.focus();
  };
  sheet.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'later' || act === 'cancel') done(null);
    else if (act === 'other') { const o = sheet.querySelector<HTMLElement>('.sd-other'); if (o) o.hidden = !o.hidden; }
    else if (act === 'github' || act === 'retry') void deviceFlow();
    else if (act === 'own') { done(null); void wmRef?.openApp('settings', { pane: 'network' }); }
  });
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });

  const deviceFlow = async () => {
    sheet.innerHTML = `
      <div class="sd-sheet-head"><div class="sd-sheet-icon">${GLYPHS.key}</div><div>
        <h3>Sign in with GitHub</h3><p>Asking GitHub for a one-time code…</p></div></div>
      <div class="sd-status-line"></div>
      <div class="sd-sheet-actions"><span class="sd-grow"></span><button class="sd-btn" data-act="cancel" type="button">Cancel</button></div>`;
    const status = (text: string, cls = '') => {
      const s = sheet.querySelector<HTMLElement>('.sd-status-line');
      if (s) { s.textContent = text; s.className = 'sd-status-line ' + cls; }
    };
    try {
      const gh = await import('../github-auth');
      const code = await gh.requestDeviceCode(gh.DEFAULT_GITHUB_SCOPES);
      if (abort.signal.aborted) return;
      sheet.innerHTML = `
        <div class="sd-sheet-head"><div class="sd-sheet-icon">${GLYPHS.key}</div><div>
          <h3>Enter this code on GitHub</h3>
          <p>Copy the code, open GitHub, paste it and approve. This window updates by itself.</p></div></div>
        <div class="sd-code">${esc(code.user_code)}</div>
        <div class="sd-status-line">Waiting for you to approve on GitHub…</div>
        <div class="sd-sheet-actions">
          <button class="sd-btn" data-act="cancel" type="button">Cancel</button><span class="sd-grow"></span>
          <button class="sd-btn" data-act="copy" type="button">Copy code</button>
          <a class="sd-btn sd-primary" data-act="open" href="${esc(code.verification_uri)}" target="_blank" rel="noopener">Open GitHub</a>
        </div>`;
      const copy = () => { navigator.clipboard?.writeText(code.user_code).catch(() => {}); };
      sheet.querySelector('[data-act=copy]')!.addEventListener('click', (e) => { copy(); (e.currentTarget as HTMLElement).textContent = 'Copied'; });
      sheet.querySelector('[data-act=open]')!.addEventListener('click', copy);
      const token = await gh.pollForToken(code, { signal: abort.signal, onStatus: (s) => { if (s === 'slow_down') status('Still waiting…'); } });
      gh.saveGitHubToken(token);
      setNetworkStatus('signed-in');
      void gh.ensureGitIdentity(fsRef, token).catch(() => {});
      status('Connected. Programs can reach the internet now.', 'ok');
      setTimeout(() => done(token), 1200);
    } catch (e) {
      if (abort.signal.aborted) return;
      status(`Couldn't sign in: ${(e as Error)?.message ?? e}`, 'err');
      const actions = sheet.querySelector('.sd-sheet-actions');
      if (actions && !actions.querySelector('[data-act=retry]')) {
        const retry = el('button', 'sd-btn sd-primary', 'Try again');
        retry.dataset.act = 'retry';
        actions.appendChild(retry);
      }
    }
  };

  ask();
  root.appendChild(sheet);
  return promise;
}

// ── Menu bar popover ──

let popover: HTMLElement | null = null;

function togglePopover(wm: WindowManager, anchor: HTMLElement): void {
  if (popover) { closePopover(); return; }
  const p = el('div', 'sd-popover');
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-label', 'Network');
  const r = anchor.getBoundingClientRect();
  p.style.top = `${r.bottom + 6}px`;
  p.style.right = `${Math.max(8, window.innerWidth - r.right - 8)}px`;
  const render = (s: NetworkStatus, account: string | null) => {
    const dot = s === 'signed-in' || s === 'online' ? 'ok' : s === 'needs-sign-in' ? 'warn' : 'off';
    p.innerHTML = `
      <div class="sd-row"><span class="sd-dot ${dot}"></span><b class="sd-grow">Network</b><span class="sd-small sd-muted">${esc(statusText(s))}</span></div>
      <div class="sd-row sd-small sd-muted">${account ? `Signed in as <b style="color:var(--sd-text)">@${esc(account)}</b>` : networkCredential() ? 'Signed in with GitHub' : 'Not signed in. Downloads from this site work anyway.'}</div>
      <div class="sd-row" style="padding-top:8px">
        ${networkCredential() ? `<button class="sd-btn" data-act="signout" type="button">Sign out</button>` : `<button class="sd-btn sd-primary" data-act="signin" type="button">Sign in with GitHub</button>`}
        <span class="sd-grow"></span><button class="sd-link sd-small" data-act="settings" type="button">Network settings…</button>
      </div>`;
  };
  render(networkStatus(), null);
  p.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'signin') { closePopover(); void openSignIn(); }
    if (act === 'signout') { signOut(); render(networkStatus(), null); }
    if (act === 'settings') { closePopover(); void wm.openApp('settings', { pane: 'network' }); }
  });
  wm.root.appendChild(p);
  popover = p;
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  void probeRelay().then(async (s) => { if (popover === p) render(s, await signedInAccount()); });
}

function outside(e: Event): void {
  if (popover && !popover.contains(e.target as Node)) closePopover();
}

function closePopover(): void {
  popover?.remove();
  popover = null;
  document.removeEventListener('pointerdown', outside, true);
}
