/**
 * setup - Mobile-friendly Claude Code authentication & onboarding.
 *
 * Opens a touch-friendly GUI window that handles:
 *   1. Opens OAuth sign-in page in a new tab
 *   2. User pastes the authorization code back
 *   3. Exchanges code for tokens via PKCE, writes credentials
 *   4. Launches Claude Code in a new terminal window
 *
 *   setup          # Open the setup wizard
 */

import { Command } from './index';
import { createServerWindow } from '../server-window';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES = 'user:inference user:profile';
const MANUAL_REDIRECT = 'https://platform.claude.com/oauth/code/callback';

function buildSetupHTML(opts: {
  alreadyAuthenticated: boolean;
  codeVerifier: string;
  codeChallenge: string;
  origin: string;
}): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117; color: #e6edf3;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; min-height: 100vh; padding: 1.5rem;
  }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    padding: 2rem; max-width: 380px; width: 100%; text-align: center;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  .subtitle { color: #8b949e; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .btn {
    display: inline-block; width: 100%; padding: 14px 24px;
    font-size: 1rem; font-weight: 600; border: none; border-radius: 8px;
    cursor: pointer; text-decoration: none; transition: opacity 0.15s;
    -webkit-tap-highlight-color: transparent;
  }
  .btn:active { opacity: 0.8; }
  .btn-primary { background: #da7756; color: #fff; }
  .btn-secondary { background: #21262d; color: #e6edf3; border: 1px solid #30363d; margin-top: 0.75rem; }
  .btn-launch { background: #238636; color: #fff; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .status { margin-top: 1rem; font-size: 0.85rem; color: #8b949e; min-height: 1.2em; }
  .status.error { color: #f85149; }
  .status.success { color: #3fb950; }
  .step { display: none; }
  .step.active { display: block; }
  .code-area { margin-top: 1.25rem; }
  .code-area label { display: block; color: #8b949e; font-size: 0.85rem; margin-bottom: 0.5rem; text-align: left; }
  .code-area input {
    width: 100%; padding: 10px 12px; font-size: 1rem;
    background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
    color: #e6edf3; outline: none;
  }
  .code-area input:focus { border-color: #da7756; }
  .code-area .btn { margin-top: 0.75rem; }
  .checkmark { font-size: 2rem; margin-bottom: 0.75rem; }
  .steps-hint { color: #8b949e; font-size: 0.8rem; text-align: left; margin-top: 1rem; line-height: 1.5; }
  .steps-hint b { color: #e6edf3; }
</style>
</head><body>

<div class="card">
  <!-- Step 1: Sign In -->
  <div id="step-signin" class="step active">
    <h1>Claude Code Setup</h1>
    <p class="subtitle">Sign in to start using Claude Code on Shiro</p>
    <button id="btn-signin" class="btn btn-primary" onclick="openSignIn()">Open Sign-In Page</button>
    ${opts.alreadyAuthenticated ? '<button class="btn btn-secondary" onclick="showStep(\'launch\')">Already signed in &mdash; Skip</button>' : ''}
    <div id="status-signin" class="status"></div>
    <div class="steps-hint" id="hint" style="display:none">
      <b>1.</b> Sign in on the page that opened<br>
      <b>2.</b> Copy the code shown after sign-in<br>
      <b>3.</b> Paste it below and tap Submit
    </div>
    <div class="code-area" id="code-area" style="display:none">
      <label for="auth-code">Paste your authorization code:</label>
      <input id="auth-code" type="text" placeholder="Enter code here" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <button class="btn btn-primary" onclick="submitCode()">Submit Code</button>
    </div>
  </div>

  <!-- Step 2: Launch -->
  <div id="step-launch" class="step">
    <div class="checkmark">&#10003;</div>
    <h1>Ready to Go</h1>
    <p class="subtitle">Claude Code is configured and ready to launch</p>
    <button class="btn btn-launch" onclick="launchClaude()">Launch Claude Code</button>
    <div id="status-launch" class="status"></div>
  </div>
</div>

<script>
var CLIENT_ID = ${JSON.stringify(CLIENT_ID)};
var SCOPES = ${JSON.stringify(OAUTH_SCOPES)};
var REDIRECT = ${JSON.stringify(MANUAL_REDIRECT)};
var CODE_VERIFIER = ${JSON.stringify(opts.codeVerifier)};
var CODE_CHALLENGE = ${JSON.stringify(opts.codeChallenge)};
var ORIGIN = ${JSON.stringify(opts.origin)};

function showStep(name) {
  document.querySelectorAll('.step').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById('step-' + name).classList.add('active');
}

function setStatus(id, msg, cls) {
  var el = document.getElementById('status-' + id);
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function openSignIn() {
  var params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: SCOPES,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    state: Math.random().toString(36).slice(2),
  });
  var url = 'https://claude.ai/oauth/authorize?' + params.toString();
  // Ask parent to open URL (srcdoc iframes can't open cross-origin tabs directly)
  window.parent.postMessage({ type: 'setup-open-url', url: url }, '*');
  document.getElementById('hint').style.display = 'block';
  document.getElementById('code-area').style.display = 'block';
  setStatus('signin', 'Waiting for you to sign in and copy the code...');
}

function submitCode() {
  var code = document.getElementById('auth-code').value.trim();
  if (!code) return;
  setStatus('signin', 'Exchanging code for tokens...');
  fetch(ORIGIN + '/api/platform/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
      redirect_uri: REDIRECT,
    }).toString(),
  }).then(function(resp) {
    if (!resp.ok) return resp.text().then(function(t) { throw new Error(t); });
    return resp.json();
  }).then(function(data) {
    window.parent.postMessage({
      type: 'setup-save-tokens',
      tokens: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
        scopes: (data.scope || SCOPES).split(' '),
      },
    }, '*');
    setStatus('signin', 'Signed in successfully!', 'success');
    setTimeout(function() { showStep('launch'); }, 600);
  }).catch(function(e) {
    setStatus('signin', 'Error: ' + e.message, 'error');
  });
}

function launchClaude() {
  window.parent.postMessage({ type: 'setup-launch-claude' }, '*');
  setStatus('launch', 'Launching...', 'success');
}
</script>
</body></html>`;
}

// PKCE helpers
function base64urlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64urlEncode(array.buffer);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(digest);
}

export const setupCmd: Command = {
  name: 'setup',
  description: 'Mobile-friendly Claude Code authentication setup',
  async exec(ctx) {
    const credsPath = '/home/user/.claude/.credentials.json';
    let alreadyAuthenticated = false;
    try {
      const credsStr = await ctx.fs.readFile(credsPath, 'utf8');
      const creds = JSON.parse(credsStr as string);
      if (creds.claudeAiOauth?.accessToken) {
        alreadyAuthenticated = true;
      }
    } catch {
      // No credentials yet
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const html = buildSetupHTML({
      alreadyAuthenticated,
      codeVerifier,
      codeChallenge,
      origin: window.location.origin,
    });

    const win = createServerWindow({
      mode: 'iframe',
      title: 'Claude Code Setup',
      width: '26em',
      height: '24em',
      onClose: () => {
        window.removeEventListener('message', messageHandler);
      },
    });
    win.updateIframe(html);

    const messageHandler = async (event: MessageEvent) => {
      if (event.data?.type === 'setup-open-url' && event.data.url) {
        window.open(event.data.url, '_blank', 'noopener');
      }

      if (event.data?.type === 'setup-save-tokens') {
        const { tokens } = event.data;
        try {
          try { await ctx.fs.mkdir('/home/user/.claude'); } catch { /* exists */ }

          const creds = {
            claudeAiOauth: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
              scopes: tokens.scopes,
            },
          };
          await ctx.fs.writeFile(credsPath, JSON.stringify(creds, null, 2));

          const configPath = '/home/user/.claude.json';
          let config: Record<string, unknown> = {};
          try {
            const existing = await ctx.fs.readFile(configPath, 'utf8');
            config = JSON.parse(existing as string);
          } catch { /* no existing config */ }
          config.hasCompletedOnboarding = true;
          await ctx.fs.writeFile(configPath, JSON.stringify(config, null, 2));
        } catch (e: any) {
          console.warn('[setup] Failed to save credentials:', e.message);
        }
      }

      if (event.data?.type === 'setup-launch-claude') {
        const scCommand = ctx.shell.commands.get('sc');
        if (scCommand) {
          scCommand.exec({ ...ctx, args: [], stdout: '', stderr: '' });
        }
        window.removeEventListener('message', messageHandler);
        win.close();
      }
    };

    window.addEventListener('message', messageHandler);

    return 0;
  },
};
