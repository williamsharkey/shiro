/**
 * GitHub sign-in for gh and git, using GitHub's OAuth device flow.
 *
 * `gh auth login` asks GitHub for a one-time code, shows it (in the terminal
 * and in a panel with Copy and Open buttons), and polls until the user
 * approves at github.com/login/device. The token goes where gh and git
 * already look (localStorage `shiro_github_token`). github.com's OAuth
 * endpoints have no CORS, so requests go through the server's narrow
 * `/api/github-login/` proxy route.
 */

import type { FileSystem } from './filesystem';
import { createServerWindow } from './server-window';
import { getShiroOrigin } from './utils/shiro-origin';
import { copyText } from './utils/osc52';
import { GLOBAL_GITCONFIG, formatGitConfig, parseGitConfig } from './commands/git';

/** Client ID of the "Shiro" GitHub OAuth app (device flow enabled; not a secret). */
export const GITHUB_OAUTH_CLIENT_ID = 'Ov23liznflO83ISe0lvr';

/** Scopes gh itself asks for, plus workflow and user:email (for git identity). */
export const DEFAULT_GITHUB_SCOPES = ['repo', 'read:org', 'gist', 'workflow', 'user:email'];

export const GITHUB_TOKEN_KEY = 'shiro_github_token';

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

type FetchLike = typeof fetch;

async function postForm(fetchImpl: FetchLike, path: string, body: Record<string, string>): Promise<any> {
  const resp = await fetchImpl(`${getShiroOrigin()}/api/github-login${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok && !data?.error) throw new Error(`GitHub returned HTTP ${resp.status}`);
  return data;
}

export async function requestDeviceCode(scopes: string[], fetchImpl: FetchLike = fetch): Promise<DeviceCode> {
  const data = await postForm(fetchImpl, '/login/device/code', {
    client_id: GITHUB_OAUTH_CLIENT_ID,
    scope: scopes.join(' '),
  });
  if (data?.error) {
    throw new Error(data.error === 'device_flow_disabled'
      ? 'device flow is not enabled for the Shiro GitHub OAuth app'
      : `${data.error}${data.error_description ? ': ' + data.error_description : ''}`);
  }
  return data as DeviceCode;
}

export type PollStatus = 'waiting' | 'slow_down';

/**
 * Poll until the user approves the code, it expires, or they deny it.
 * Resolves to the access token.
 */
export async function pollForToken(
  code: DeviceCode,
  opts: { signal?: AbortSignal; onStatus?: (s: PollStatus) => void; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl || fetch;
  const sleep = opts.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let interval = Math.max(1, code.interval || 5);
  const deadline = Date.now() + (code.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    if (opts.signal?.aborted) throw new Error('cancelled');
    const data = await postForm(fetchImpl, '/login/oauth/access_token', {
      client_id: GITHUB_OAUTH_CLIENT_ID,
      device_code: code.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (data?.access_token) return data.access_token as string;
    switch (data?.error) {
      case 'authorization_pending': opts.onStatus?.('waiting'); break;
      case 'slow_down': interval = (data.interval || interval + 5); opts.onStatus?.('slow_down'); break;
      case 'expired_token': throw new Error('the code expired before it was approved');
      case 'access_denied': throw new Error('access was denied on GitHub');
      default: throw new Error(data?.error_description || data?.error || 'unexpected response from GitHub');
    }
  }
  throw new Error('the code expired before it was approved');
}

export function saveGitHubToken(token: string): void {
  try { localStorage.setItem(GITHUB_TOKEN_KEY, token); } catch {}
}

/**
 * Fill in ~/.gitconfig user.name / user.email from the GitHub account when they
 * aren't set yet, so commits are attributed without extra setup. Returns what was set.
 */
export async function ensureGitIdentity(
  fs: Pick<FileSystem, 'readFile' | 'writeFile'>,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ name?: string; email?: string }> {
  let config: Record<string, string> = {};
  try { config = parseGitConfig(await fs.readFile(GLOBAL_GITCONFIG, 'utf8') as string); } catch {}
  if (config['user.name'] && config['user.email']) return {};
  const api = (path: string) => fetchImpl(`${getShiroOrigin()}/api/github${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const user = await api('/user');
  if (!user?.login) return {};
  const set: { name?: string; email?: string } = {};
  if (!config['user.name']) set.name = config['user.name'] = user.name || user.login;
  if (!config['user.email']) {
    const emails = await api('/user/emails');
    const primary = Array.isArray(emails) ? emails.find((e: any) => e.primary && e.verified) : null;
    set.email = config['user.email'] = primary?.email || user.email || `${user.id}+${user.login}@users.noreply.github.com`;
  }
  await fs.writeFile(GLOBAL_GITCONFIG, formatGitConfig(config));
  return set;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function panelHTML(code: DeviceCode): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.25rem; }
  .card { max-width: 360px; width: 100%; text-align: center; }
  h1 { font-size: 1.2rem; margin-bottom: 0.35rem; }
  p { color: #8b949e; font-size: 0.875rem; line-height: 1.4; }
  .code { font: 700 2rem/1 ui-monospace, Menlo, monospace; letter-spacing: 0.12em; margin: 1rem 0 0.75rem;
    padding: 0.75rem; border: 1px solid #30363d; border-radius: 8px; background: #010409; user-select: all; }
  .row { display: flex; gap: 0.5rem; }
  .btn { flex: 1; display: block; padding: 11px 14px; font-size: 0.95rem; font-weight: 600; border: 1px solid #30363d;
    border-radius: 8px; cursor: pointer; text-decoration: none; background: #21262d; color: #e6edf3; }
  .primary { background: #238636; border-color: #238636; color: #fff; }
  .status { margin-top: 0.9rem; font-size: 0.85rem; color: #8b949e; min-height: 1.2em; }
  .ok { color: #3fb950; } .err { color: #f85149; }
</style></head><body><div class="card">
  <h1>Sign in to GitHub</h1>
  <p>Copy the code, open GitHub, and paste it there to give gh and git access.</p>
  <div class="code" id="code">${escapeHtml(code.user_code)}</div>
  <div class="row">
    <button class="btn" id="copy" type="button">Copy code</button>
    <a class="btn primary" id="open" href="${escapeHtml(code.verification_uri)}" target="_blank" rel="noopener">Open GitHub</a>
  </div>
  <div class="status" id="status">Waiting for you to approve on GitHub…</div>
  <p style="margin-top:0.9rem"><a href="#" id="cancel" style="color:#8b949e">Cancel</a></p>
</div><script>
  var statusEl = document.getElementById('status');
  document.getElementById('copy').addEventListener('click', function () {
    parent.postMessage({ type: 'gh-login-copy' }, '*');
    this.textContent = 'Copied';
  });
  document.getElementById('open').addEventListener('click', function () {
    parent.postMessage({ type: 'gh-login-copy' }, '*');
  });
  document.getElementById('cancel').addEventListener('click', function (e) {
    e.preventDefault(); parent.postMessage({ type: 'gh-login-cancel' }, '*');
  });
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.type === 'gh-login-status') { statusEl.textContent = e.data.text; statusEl.className = 'status ' + (e.data.cls || ''); }
  });
</script></body></html>`;
}

/**
 * Show the sign-in panel for a device code. Returns a handle to update its
 * status and close it, plus an AbortSignal that fires when the user cancels.
 */
export function openGitHubLoginPanel(code: DeviceCode): { setStatus: (text: string, cls?: string) => void; close: () => void; signal: AbortSignal } {
  const abort = new AbortController();
  let closed = false;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win.iframe.contentWindow || !e.data) return;
    if (e.data.type === 'gh-login-copy') copyText(code.user_code);
    if (e.data.type === 'gh-login-cancel') { abort.abort(); win.close(); }
  };
  const win = createServerWindow({
    mode: 'iframe', title: 'Sign in to GitHub', width: '24em', height: '22em',
    onClose: () => { closed = true; window.removeEventListener('message', onMessage); if (!abort.signal.aborted) abort.abort(); },
  });
  window.addEventListener('message', onMessage);
  win.updateIframe(panelHTML(code));
  return {
    setStatus: (text, cls) => { if (!closed) win.iframe.contentWindow?.postMessage({ type: 'gh-login-status', text, cls }, '*'); },
    close: () => { if (!closed) win.close(); },
    signal: abort.signal,
  };
}
