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
import { BRAND } from './brand';
import { claudeSignInUI } from './claude-signin-ui';

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

/** What the desktop shows for the Claude account: never tokens */
export interface ClaudeAccount {
  signedIn: boolean;
  /** "pro", "max", "team", "enterprise"… when Claude Code recorded it */
  plan?: string;
  email?: string;
  organization?: string;
}

/** The signed-in Claude account, from ~/.claude/.credentials.json and ~/.claude.json */
export async function claudeAccount(fs: Pick<FileSystem, 'readFile'>): Promise<ClaudeAccount> {
  let oauth: Record<string, unknown> | undefined;
  try { oauth = JSON.parse(await fs.readFile(CLAUDE_CREDENTIALS_PATH, 'utf8') as string)?.claudeAiOauth; } catch {}
  if (!oauth || (!oauth.accessToken && !oauth.refreshToken)) return { signedIn: false };
  const acct: ClaudeAccount = { signedIn: true };
  if (typeof oauth.subscriptionType === 'string' && oauth.subscriptionType) acct.plan = oauth.subscriptionType;
  try {
    const o = JSON.parse(await fs.readFile('/home/user/.claude.json', 'utf8') as string)?.oauthAccount;
    if (typeof o?.emailAddress === 'string') acct.email = o.emailAddress;
    if (typeof o?.organizationName === 'string') acct.organization = o.organizationName;
  } catch {}
  return acct;
}

/** Sign out: remove the credentials file both Claude Code builds read */
export async function signOutClaude(fs: Pick<FileSystem, 'unlink'>): Promise<void> {
  try { await fs.unlink(CLAUDE_CREDENTIALS_PATH); } catch {}
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
  /* The desktop's Settings look (src/desktop/desktop.css): light and dark, one accent */
  :root { color-scheme: light dark; --bg: #fbfbfd; --text: #1c1d26; --text-2: #555a6b; --field: rgba(0,0,0,.045); --sep: rgba(0,0,0,.1);
    --accent: #6e6aff; --err: #d93025; --ok: #1e8e3e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1d29; --text: #ecedf3; --text-2: #a4a8b8; --field: rgba(255,255,255,.06); --sep: rgba(255,255,255,.1);
    --err: #ff6b6b; --ok: #4cd07d; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 13px/1.45 system-ui, sans-serif; -webkit-font-smoothing: antialiased;
    background: var(--bg); color: var(--text); min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 18px;
  }
  .card { max-width: 360px; width: 100%; }
  h1 { font-size: 17px; font-weight: 650; letter-spacing: -.01em; margin-bottom: 4px; }
  .subtitle { color: var(--text-2); margin-bottom: 14px; }
  .step { display: flex; gap: 8px; align-items: baseline; margin: 14px 0 6px; color: var(--text-2); }
  .num { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; flex: none; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; height: 30px; padding: 0 14px; width: 100%;
    font: inherit; font-weight: 600; border: 0; border-radius: 7px; cursor: default; text-decoration: none;
    background: var(--accent); color: #fff; -webkit-tap-highlight-color: transparent;
  }
  .btn:active { filter: brightness(.92); }
  .btn:disabled { opacity: .5; }
  .btn-ghost { background: var(--field); color: var(--text); border: 1px solid var(--sep); margin-top: 12px; font-weight: 500; }
  input {
    flex: 1; min-width: 0; height: 30px; padding: 0 10px; font: 13px ui-monospace, monospace;
    background: var(--field); border: 1px solid var(--sep); border-radius: 7px; color: var(--text); outline: none;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  .row { display: flex; gap: 8px; }
  .row .btn { width: auto; white-space: nowrap; }
  .status { margin-top: 10px; color: var(--text-2); min-height: 1.2em; }
  .status.error { color: var(--err); }
  .status.success { color: var(--ok); }
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

/** The default line under "Sign in to Claude" */
export function claudeSignInSubtitle(): string {
  return `Use your Claude account for Claude Code in ${BRAND.name}.`;
}

/** One sign-in attempt: the page to open, and what to do with the code it shows */
export interface ClaudeSignInFlow {
  authorizeUrl: string;
  /** Exchange the pasted code and save the credentials; throws a readable error */
  complete(code: string): Promise<void>;
}

export async function beginClaudeSignIn(fs: SignInFs, cwd?: string): Promise<ClaudeSignInFlow> {
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
  return {
    authorizeUrl: `${AUTHORIZE_URL}?${params}`,
    async complete(code: string) {
      const tokens = await exchangeCode(code.trim(), verifier, state);
      await ensureClaudeAuthState(fs, {
        homeDir: '/home/user',
        projectPath: cwd,
        tokens,
        theme: DEFAULT_CLAUDE_THEME,
        ensureBootstrap: true,
        refreshRemoteState: true,
      });
    },
  };
}

/**
 * Show the sign-in UI: the desktop's sheet when there is one (claude-signin-ui.ts),
 * else a floating panel. Resolves true once credentials are saved, false if
 * it is skipped or closed.
 */
export async function openClaudeSignIn(opts: ClaudeSignInOptions): Promise<boolean> {
  const ui = claudeSignInUI();
  if (ui) return ui({ subtitle: opts.subtitle, cwd: opts.cwd });
  const flow = await beginClaudeSignIn(opts.fs, opts.cwd);
  const authorizeUrl = flow.authorizeUrl;

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
        await flow.complete(String(event.data.code || ''));
        reply({ type: 'claude-signin-done' });
        finish(true);
        setTimeout(() => win.close(), 400);
      } catch (e: any) {
        reply({ type: 'claude-signin-error', message: e?.message || String(e) });
      }
    }

    window.addEventListener('message', onMessage);
    win.updateIframe(buildPanelHTML(authorizeUrl, opts.subtitle || claudeSignInSubtitle()));
  });
}
