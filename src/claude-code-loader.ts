/**
 * Claude Code Loader for Shiro
 *
 * This module loads and runs the real Claude Code CLI in Shiro's browser environment.
 * It patches the environment to:
 * 1. Redirect API calls through a CORS proxy
 * 2. Shim native modules (ripgrep) with JS implementations
 * 3. Use Shiro's virtual filesystem
 *
 * Usage:
 *   import { loadClaudeCode } from './claude-code-loader';
 *   await loadClaudeCode(shell, terminal);
 */

import type { Shell } from './shell';
import type { ShiroTerminal } from './terminal';

// Configuration for the proxy
const PROXY_CONFIG = {
  // Determine proxy base URL based on current host
  getProxyBase(): string {
    const host = typeof location !== 'undefined' ? location.host : 'localhost:9999';

    // Production - shiro.computer (future)
    if (host.includes('shiro.computer')) {
      return 'https://shiro.computer';
    }

    // Cloudflare Pages - shiro-3m3.pages.dev
    if (host.includes('.pages.dev')) {
      return `https://${host}`;
    }

    // Local development with proxy server
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
      return `http://${host}`;
    }

    // Default to current origin
    return typeof location !== 'undefined' ? location.origin : 'http://localhost:9999';
  },

  // Rewrite API URLs to go through proxy
  rewriteUrl(url: string): string {
    const proxyBase = this.getProxyBase();

    // Use /api/ prefix for Pages/production, /proxy/ for local dev server
    const isLocalDev = proxyBase.includes('localhost') || proxyBase.includes('127.0.0.1');
    const prefix = isLocalDev ? '/proxy/' : '/api/';

    if (url.startsWith('https://api.anthropic.com/')) {
      return url.replace('https://api.anthropic.com/', `${proxyBase}${prefix}${isLocalDev ? 'api.anthropic.com/' : 'anthropic/'}`);
    }
    if (url.startsWith('https://platform.claude.com/')) {
      return url.replace('https://platform.claude.com/', `${proxyBase}${prefix}${isLocalDev ? 'platform.claude.com/' : 'platform/'}`);
    }
    if (url.startsWith('https://mcp-proxy.anthropic.com/')) {
      return url.replace('https://mcp-proxy.anthropic.com/', `${proxyBase}${prefix}${isLocalDev ? 'mcp-proxy.anthropic.com/' : 'mcp-proxy/'}`);
    }
    return url;
  }
};

/**
 * Environment patches for Claude Code
 */
export function createClaudeCodeEnv(shell: Shell): Record<string, string> {
  const proxyBase = PROXY_CONFIG.getProxyBase();

  return {
    // Tell Claude Code to use embedded ripgrep mode (we'll shim the spawn)
    RIPGREP_EMBEDDED: 'true',

    // Point to proxy URLs
    ANTHROPIC_BASE_URL: `${proxyBase}/api/anthropic`,

    // Shiro-specific flags
    CLAUDE_CODE_RUNTIME: 'shiro',
    CLAUDE_CODE_BROWSER: 'true',

    // Inherit user's API key if set
    ANTHROPIC_API_KEY: shell.env['ANTHROPIC_API_KEY'] || '',

    // Home directory
    HOME: '/home/user',
    USER: 'user',

    // Terminal
    TERM: 'xterm-256color',
    COLUMNS: '120',
    LINES: '40',
  };
}

/**
 * Patch fetch to redirect Anthropic API calls through proxy
 */
export function patchFetch(): void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url: string;

    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = input.url;
    }

    // Rewrite Anthropic URLs to go through proxy
    const rewrittenUrl = PROXY_CONFIG.rewriteUrl(url);

    if (rewrittenUrl !== url) {
      console.log(`[Claude Code] Proxying: ${url} -> ${rewrittenUrl}`);

      if (typeof input === 'string') {
        input = rewrittenUrl;
      } else if (input instanceof URL) {
        input = new URL(rewrittenUrl);
      } else {
        // Request object - create new one with rewritten URL
        input = new Request(rewrittenUrl, input);
      }
    }

    return originalFetch.call(globalThis, input, init);
  };
}

/**
 * Create ripgrep shim that uses Shiro's grep command
 */
export function createRipgrepShim(shell: Shell) {
  return async function ripgrepMain(args: string[]): Promise<number> {
    // Parse ripgrep args and convert to grep
    // Common patterns:
    //   rg "pattern" path -> grep -r "pattern" path
    //   rg -l "pattern" -> grep -l -r "pattern"
    //   rg -i "pattern" -> grep -i -r "pattern"
    //   rg --json -> not supported, return empty

    const grepArgs: string[] = ['-r']; // Always recursive
    let pattern = '';
    let paths: string[] = [];
    let jsonOutput = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--no-config') continue; // Ignore
      if (arg === '--json') {
        jsonOutput = true;
        continue;
      }
      if (arg === '-l' || arg === '--files-with-matches') {
        grepArgs.push('-l');
        continue;
      }
      if (arg === '-i' || arg === '--ignore-case') {
        grepArgs.push('-i');
        continue;
      }
      if (arg === '-n' || arg === '--line-number') {
        grepArgs.push('-n');
        continue;
      }
      if (arg === '-c' || arg === '--count') {
        grepArgs.push('-c');
        continue;
      }
      if (arg === '-v' || arg === '--invert-match') {
        grepArgs.push('-v');
        continue;
      }
      if (arg.startsWith('-')) {
        // Skip unknown flags
        continue;
      }

      // First non-flag is pattern, rest are paths
      if (!pattern) {
        pattern = arg;
      } else {
        paths.push(arg);
      }
    }

    if (!pattern) {
      return 1;
    }

    // If JSON output requested, we can't really support it
    // Return empty array for now
    if (jsonOutput) {
      console.log('[]');
      return 0;
    }

    // Build grep command
    const grepCmd = shell.commands.get('grep');
    if (!grepCmd) {
      console.error('grep command not available');
      return 1;
    }

    const fullArgs = [...grepArgs, pattern, ...(paths.length ? paths : ['.'])];

    const ctx = {
      args: fullArgs,
      fs: shell.fs,
      cwd: shell.cwd,
      env: shell.env,
      stdin: '',
      stdout: '',
      stderr: '',
      shell: shell,
    };

    try {
      const code = await grepCmd.exec(ctx);
      if (ctx.stdout) console.log(ctx.stdout.trimEnd());
      if (ctx.stderr) console.error(ctx.stderr.trimEnd());
      return code;
    } catch (e: any) {
      console.error(`grep error: ${e.message}`);
      return 1;
    }
  };
}

/**
 * Generate PKCE code verifier and challenge
 */
async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  // Generate random code verifier (43-128 chars)
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const codeVerifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // Generate code challenge (SHA-256 hash of verifier)
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { codeVerifier, codeChallenge };
}

/**
 * OAuth handler for browser-based authentication
 * Uses the same OAuth flow as the real Claude Code CLI
 */
export class BrowserOAuth {
  private proxyBase: string;

  // Claude Code's official OAuth configuration
  private readonly CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
  private readonly AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
  private readonly TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
  private readonly MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';
  private readonly SCOPES = 'user:profile user:inference';

  constructor() {
    this.proxyBase = PROXY_CONFIG.getProxyBase();
  }

  /**
   * Start OAuth flow with popup and code paste UI
   */
  async login(): Promise<{ accessToken: string; refreshToken?: string }> {
    // Build authorization URL using Claude Code's real OAuth endpoint
    // Testing without PKCE to match what Claude Code source shows
    const state = crypto.randomUUID();
    const authUrl = `${this.AUTHORIZE_URL}?` +
      `client_id=${encodeURIComponent(this.CLIENT_ID)}&` +
      `redirect_uri=${encodeURIComponent(this.MANUAL_REDIRECT_URL)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(this.SCOPES)}&` +
      `state=${encodeURIComponent(state)}`;

    // Open auth page in popup
    const popup = window.open(authUrl, 'claude-login', 'width=500,height=700,menubar=no,toolbar=no');

    return new Promise((resolve, reject) => {
      // Create modal overlay for code input
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.85); z-index: 10000;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, sans-serif;
      `;

      // Create modal container
      const modal = document.createElement('div');
      modal.style.cssText = `
        background: #1a1a2e; border-radius: 12px; padding: 24px;
        width: 90%; max-width: 450px;
        display: flex; flex-direction: column; gap: 20px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      `;

      // Header
      const header = document.createElement('div');
      header.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
      header.innerHTML = `
        <h2 style="margin: 0; color: #fff; font-size: 20px;">Login to Claude</h2>
        <button id="close-oauth" style="background: none; border: none; color: #888; font-size: 28px; cursor: pointer; line-height: 1;">&times;</button>
      `;

      // Instructions
      const instructions = document.createElement('div');
      instructions.style.cssText = 'color: #aaa; font-size: 14px; line-height: 1.6;';
      instructions.innerHTML = `
        <p style="margin: 0 0 12px 0;"><strong style="color: #fff;">Step 1:</strong> Log in to Claude in the popup window</p>
        <p style="margin: 0 0 12px 0;"><strong style="color: #fff;">Step 2:</strong> After login, you'll see an authorization code</p>
        <p style="margin: 0;"><strong style="color: #fff;">Step 3:</strong> Copy the code and paste it below</p>
      `;

      // Code input area
      const inputArea = document.createElement('div');
      inputArea.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';

      const codeInput = document.createElement('input');
      codeInput.type = 'text';
      codeInput.placeholder = 'Paste authorization code here...';
      codeInput.style.cssText = `
        padding: 14px 16px; border-radius: 8px;
        border: 2px solid #333; background: #0d0d1a; color: #fff;
        font-size: 16px; outline: none; font-family: monospace;
      `;
      codeInput.onfocus = () => { codeInput.style.borderColor = '#6366f1'; };
      codeInput.onblur = () => { codeInput.style.borderColor = '#333'; };

      const submitBtn = document.createElement('button');
      submitBtn.textContent = 'Complete Login';
      submitBtn.style.cssText = `
        padding: 14px 24px; border-radius: 8px; border: none;
        background: #6366f1; color: #fff; font-size: 16px;
        cursor: pointer; font-weight: 600; transition: background 0.2s;
      `;
      submitBtn.onmouseover = () => { submitBtn.style.background = '#5558e3'; };
      submitBtn.onmouseout = () => { submitBtn.style.background = '#6366f1'; };

      const errorMsg = document.createElement('p');
      errorMsg.style.cssText = 'color: #ef4444; margin: 0; font-size: 14px; display: none;';

      inputArea.appendChild(codeInput);
      inputArea.appendChild(submitBtn);
      inputArea.appendChild(errorMsg);

      // Open popup link (in case popup was blocked)
      const popupLink = document.createElement('a');
      popupLink.href = authUrl;
      popupLink.target = '_blank';
      popupLink.style.cssText = 'color: #6366f1; font-size: 13px; text-align: center;';
      popupLink.textContent = "Popup didn't open? Click here to login";

      // Assemble modal
      modal.appendChild(header);
      modal.appendChild(instructions);
      modal.appendChild(inputArea);
      modal.appendChild(popupLink);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Handle close
      const close = () => {
        document.body.removeChild(overlay);
        popup?.close();
        reject(new Error('Login cancelled'));
      };
      overlay.querySelector('#close-oauth')?.addEventListener('click', close);

      // Handle submit
      const submit = async () => {
        const code = codeInput.value.trim();
        if (!code) {
          codeInput.style.borderColor = '#ef4444';
          errorMsg.textContent = 'Please paste the authorization code';
          errorMsg.style.display = 'block';
          return;
        }

        submitBtn.textContent = 'Logging in...';
        submitBtn.disabled = true;
        errorMsg.style.display = 'none';

        try {
          const tokens = await this.exchangeCode(code);
          document.body.removeChild(overlay);
          popup?.close();
          resolve(tokens);
        } catch (err: any) {
          submitBtn.textContent = 'Complete Login';
          submitBtn.disabled = false;
          codeInput.style.borderColor = '#ef4444';
          errorMsg.textContent = `Error: ${err.message}`;
          errorMsg.style.display = 'block';
        }
      };

      submitBtn.addEventListener('click', submit);
      codeInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') submit(); });

      // Focus input after a short delay
      setTimeout(() => codeInput.focus(), 500);
    });
  }

  /**
   * Exchange authorization code for tokens using PKCE
   * Claude Code uses JSON Content-Type for the token endpoint
   */
  async exchangeCodeWithPKCE(code: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken?: string }> {
    // Use proxy for token exchange to avoid CORS
    const tokenUrl = `${this.proxyBase}/api/platform/v1/oauth/token`;

    // Claude Code's token request only has grant_type, code, redirect_uri
    // (based on source code analysis - client_id and code_verifier may be handled differently)
    const requestBody = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.MANUAL_REDIRECT_URL,
    };

    console.log('[OAuth] Token exchange request:', tokenUrl);
    console.log('[OAuth] Request body:', JSON.stringify(requestBody, null, 2));
    console.log('[OAuth] code_verifier being sent:', codeVerifier);

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'claude-code/2.1.27',
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();
    console.log('[OAuth] Token exchange response:', response.status, responseText);

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status} - ${responseText}`);
    }

    const data = JSON.parse(responseText);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };
  }

  /**
   * Exchange authorization code for tokens
   * Uses JSON and minimal body matching Claude Code source
   */
  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string }> {
    const tokenUrl = `${this.proxyBase}/api/platform/v1/oauth/token`;

    // Minimal request body matching Claude Code's implementation
    const requestBody = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.MANUAL_REDIRECT_URL,
    };

    console.log('[OAuth] Token exchange request:', tokenUrl);
    console.log('[OAuth] Request body:', JSON.stringify(requestBody, null, 2));

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'claude-code/2.1.27',
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();
    console.log('[OAuth] Token exchange response:', response.status, responseText);

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status} - ${responseText}`);
    }

    const data = JSON.parse(responseText);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };
  }

  /**
   * Refresh access token
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string }> {
    const tokenUrl = `${this.proxyBase}/api/platform/v1/oauth/token`;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.CLIENT_ID,
      scope: this.SCOPES,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
    };
  }
}

/**
 * Store for OAuth tokens
 */
export class TokenStore {
  private static STORAGE_KEY = 'shiro_claude_oauth';

  static save(tokens: { accessToken: string; refreshToken?: string }): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(tokens));
  }

  static load(): { accessToken: string; refreshToken?: string } | null {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    if (!stored) return null;
    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  }

  static clear(): void {
    localStorage.removeItem(this.STORAGE_KEY);
  }
}

/**
 * Main loader function - initializes Claude Code in Shiro
 */
export async function initClaudeCode(shell: Shell): Promise<void> {
  // Patch fetch for API proxying
  patchFetch();

  // Create ripgrep shim and expose it globally
  (globalThis as any).__shiro_ripgrep = createRipgrepShim(shell);

  // Set environment variables
  const env = createClaudeCodeEnv(shell);
  Object.assign(shell.env, env);

  console.log('[Claude Code] Initialized for Shiro');
  console.log(`[Claude Code] Proxy base: ${PROXY_CONFIG.getProxyBase()}`);
}
