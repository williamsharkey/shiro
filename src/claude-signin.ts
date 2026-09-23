/**
 * Claude sign-in panel.
 *
 * Claude Code's own /login opens the browser at a localhost:<port>/callback
 * redirect, which can't reach a CLI running inside a browser tab, so it
 * falls back to making you copy a code out of its output. This panel runs the
 * same OAuth PKCE flow up front: a link that opens the sign-in page, and a box
 * for the code that page shows afterwards. Tokens are exchanged here in the
 * main page and written to ~/.claude/.credentials.json (IndexedDB-backed, so
 * they survive reloads), then Claude Code starts already signed in.
 */

import type { FileSystem } from './filesystem';
import { createServerWindow } from './server-window';
import { DEFAULT_CLAUDE_THEME } from './claude-config';
import { ensureClaudeAuthState } from './claude-auth';
import { getShiroOrigin } from './utils/shiro-origin';

// Values Claude Code itself uses for "Claude account with subscription" login.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const MANUAL_REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ');

export const CLAUDE_CREDENTIALS_PATH = '/home/user/.claude/.credentials.json';

type SignInFs = Parameters<typeof ensureClaudeAuthState>[0] & Pick<FileSystem, 'readFile'>;

export async function hasClaudeCredentials(fs: Pick<FileSystem, 'readFile'>): Promise<boolean> {
  try {
    const creds = JSON.parse(await fs.readFile(CLAUDE_CREDENTIALS_PATH, 'utf8') as string);
    return !!creds.claudeAiOauth?.accessToken || !!creds.claudeAiOauth?.refreshToken;
  } catch {
    return false;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function buildPanelHTML(authorizeUrl: string, subtitle: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117; color: #e6edf3; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 1.25rem;
  }
  .card { max-width: 380px; width: 100%; }
  h1 { font-size: 1.25rem; margin-bottom: 0.35rem; }
  .subtitle { color: #8b949e; font-size: 0.875rem; margin-bottom: 1.25rem; line-height: 1.4; }
  .step { display: flex; gap: 0.6rem; align-items: baseline; margin: 1rem 0 0.5rem; color: #8b949e; font-size: 0.85rem; }
  .num { color: #da7756; font-weight: 700; }
  .btn {
    display: block; width: 100%; padding: 12px 20px; font-size: 1rem; font-weight: 600;
    border: none; border-radius: 8px; cursor: pointer; text-align: center; text-decoration: none;
    background: #da7756; color: #fff; -webkit-tap-highlight-color: transparent;
  }
  .btn:active { opacity: 0.85; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn-ghost { background: #21262d; color: #e6edf3; border: 1px solid #30363d; margin-top: 0.6rem; }
  input {
    width: 100%; padding: 10px 12px; font-size: 1rem; font-family: ui-monospace, Menlo, monospace;
    background: #010409; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; outline: none;
  }
  input:focus { border-color: #da7756; }
  .row { display: flex; gap: 0.5rem; }
  .row .btn { width: auto; white-space: nowrap; }
  .status { margin-top: 0.9rem; font-size: 0.85rem; color: #8b949e; min-height: 1.2em; }
  .status.error { color: #f85149; }
  .status.success { color: #3fb950; }
</style>
</head><body>
<div class="card">
  <h1>Sign in to Claude</h1>
  <p class="subtitle">${escapeHtml(subtitle)}</p>

  <div class="step"><span class="num">1</span><span>Open the sign-in page and approve access.</span></div>
  <a class="btn" id="open" href="${escapeHtml(authorizeUrl)}" target="_blank" rel="noopener">Open sign-in page</a>

  <div class="step"><span class="num">2</span><span>Paste the code it shows you.</span></div>
  <form class="row" id="form">
    <input id="code" type="text" placeholder="Paste code here" autocomplete="off"
      autocorrect="off" autocapitalize="off" spellcheck="false">
    <button class="btn" id="submit" type="submit">Sign in</button>
  </form>
  <div id="status" class="status"></div>
  <button class="btn btn-ghost" id="skip" type="button">Skip for now</button>
</div>
<script>
  var statusEl = document.getElementById('status');
  var submitEl = document.getElementById('submit');
  var codeEl = document.getElementById('code');
  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = 'status' + (cls ? ' ' + cls : ''); }
  document.getElementById('open').addEventListener('click', function () {
    setStatus('Waiting for the code from the sign-in page\\u2026');
    setTimeout(function () { codeEl.focus(); }, 300);
  });
  document.getElementById('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = codeEl.value.trim();
    if (!code) { codeEl.focus(); return; }
    submitEl.disabled = true;
    setStatus('Signing in\\u2026');
    parent.postMessage({ type: 'claude-signin-code', code: code }, '*');
  });
  document.getElementById('skip').addEventListener('click', function () {
    parent.postMessage({ type: 'claude-signin-skip' }, '*');
  });
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.type === 'claude-signin-error') { submitEl.disabled = false; setStatus(e.data.message, 'error'); }
    if (e.data.type === 'claude-signin-done') { setStatus('Signed in.', 'success'); }
  });
</script>
</body></html>`;
}

async function exchangeCode(pasted: string, verifier: string, expectedState: string) {
  // The callback page shows "<code>#<state>"
  const [code, state = expectedState] = pasted.split('#');
  if (state !== expectedState) {
    throw new Error('That code is from a different sign-in attempt. Open the sign-in page again from this panel.');
  }
  const resp = await fetch(`${getShiroOrigin()}/api/platform/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: MANUAL_REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  });
  if (!resp.ok) {
    let detail = '';
    try { const body = await resp.json(); detail = body?.error_description || body?.error?.message || (typeof body?.error === 'string' ? body.error : '');
      detail = String(detail).replace(/\.+$/, ''); } catch {}
    throw new Error(`Sign-in failed (HTTP ${resp.status})${detail ? ': ' + detail : ''}. Try opening the sign-in page again.`);
  }
  const data = await resp.json();
  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) ?? null,
    expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
    scopes: String(data.scope || OAUTH_SCOPES).split(' '),
  };
}

export interface ClaudeSignInOptions {
  fs: SignInFs;
  /** Project directory to pre-trust for Claude Code. */
  cwd?: string;
  subtitle?: string;
}

/**
 * Show the sign-in panel. Resolves true once credentials are saved, false if
 * the panel is skipped or closed.
 */
export async function openClaudeSignIn(opts: ClaudeSignInOptions): Promise<boolean> {
  const verifier = randomToken();
  const state = randomToken();
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: MANUAL_REDIRECT,
    scope: OAUTH_SCOPES,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  });
  const authorizeUrl = `${AUTHORIZE_URL}?${params}`;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      resolve(ok);
    };

    const win = createServerWindow({
      mode: 'iframe',
      title: 'Sign in to Claude',
      width: '26em',
      height: '25em',
      onClose: () => finish(false),
    });

    const reply = (msg: Record<string, unknown>) => win.iframe.contentWindow?.postMessage(msg, '*');

    async function onMessage(event: MessageEvent) {
      if (event.source !== win.iframe.contentWindow || !event.data) return;
      if (event.data.type === 'claude-signin-skip') {
        win.close();
        return;
      }
      if (event.data.type !== 'claude-signin-code') return;
      try {
        const tokens = await exchangeCode(String(event.data.code || ''), verifier, state);
        await ensureClaudeAuthState(opts.fs, {
          homeDir: '/home/user',
          projectPath: opts.cwd,
          tokens,
          theme: DEFAULT_CLAUDE_THEME,
          ensureBootstrap: true,
          refreshRemoteState: true,
        });
        reply({ type: 'claude-signin-done' });
        finish(true);
        setTimeout(() => win.close(), 400);
      } catch (e: any) {
        reply({ type: 'claude-signin-error', message: e?.message || String(e) });
      }
    }

    window.addEventListener('message', onMessage);
    win.updateIframe(buildPanelHTML(authorizeUrl, opts.subtitle || 'Claude Code in Shiro uses your Claude subscription.'));
  });
}
