/**
 * Accounts (docs/DESKTOP.md "Accounts"): GitHub (the network sign-in,
 * network.ts) and Claude (Claude Code's sign-in, src/claude-signin.ts), with
 * their state and Sign in / Sign out. Shown in Settings → Accounts and in the
 * menu bar's network popover. Also the desktop's Claude sign-in sheet, which
 * replaces the floating panel while the desktop runs (claude-signin-ui.ts).
 * Loaded on first use.
 */

import type { WindowManager } from './wm';
import type { FileSystem } from '../filesystem';
import { GLYPHS } from './icons';
import { glyphFor } from './iconsets';
import { networkCredential, onNetworkStatus } from '../net-signin';
import { openSignIn, signedInAccount, signOut } from './network';
import { CLAUDE_CREDENTIALS_PATH, beginClaudeSignIn, claudeAccount, claudeSignInSubtitle, signOutClaude, type ClaudeAccount } from '../claude-signin';
import type { ClaudeSignInUIOptions } from '../claude-signin-ui';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A white glyph (24-unit) on a colored rounded square, like Settings' sidebar */
const tileIcon = (d: string, color: string) =>
  `<span class="sd-set-ico sd-acct-ico" style="background:${color}"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg></span>`;
/** A branch: commits on GitHub */
const BRANCH_D = 'M7 4.5v15M17 8.5v1a3 3 0 0 1-3 3h-4a3 3 0 0 0-3 3M7 4.5h.01M7 19.5h.01M17 6.2a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 1 0 0-4.4z';
const GITHUB_ICON = tileIcon(BRANCH_D, '#2b3137');
const CLAUDE_ICON = tileIcon(glyphFor('agents')!, '#c96442');

/** "max" → "Claude Max" */
export function planName(plan: string | undefined): string | null {
  if (!plan) return null;
  const p = plan.toLowerCase();
  const name = p === 'pro' ? 'Pro' : p === 'max' ? 'Max' : p === 'team' ? 'Team' : p === 'enterprise' ? 'Enterprise' : plan;
  return `Claude ${name}`;
}

/** One line of state for the Claude row: never a token */
export function claudeStateText(a: ClaudeAccount): string {
  if (!a.signedIn) return 'Not signed in. Claude Code can also sign in from the terminal.';
  const who = a.email ?? a.organization;
  const plan = planName(a.plan);
  return `Signed in${who ? ` as ${who}` : ''}${plan ? ` · ${plan}` : ''}`;
}

export interface AccountsOptions {
  wm: WindowManager;
  fs: FileSystem;
  /** The menu bar popover: tighter rows, no explanations */
  compact?: boolean;
  /** Called before opening a sheet (the popover closes itself) */
  onOpenSheet?: () => void;
}

/**
 * Render the GitHub and Claude rows into `host`, kept current as either
 * account changes. Sign out asks first, in place. Returns a cleanup.
 */
export function renderAccounts(host: HTMLElement, opts: AccountsOptions): () => void {
  const { fs, compact } = opts;
  let gh: string | null = null;
  let claude: ClaudeAccount = { signedIn: false };
  let confirming: 'github' | 'claude' | null = null;
  let busy = false;
  let alive = true;

  const row = (id: 'github' | 'claude', icon: string, name: string, state: string, signedIn: boolean, signInLabel: string) => `
    <div class="sd-acct-row" data-acct="${id}">
      ${icon}
      <span class="sd-grow sd-acct-text"><b>${name}</b><span class="sd-small sd-muted sd-acct-state" title="${esc(state)}">${esc(state)}</span></span>
      ${signedIn
        ? `<button class="sd-btn" data-act="${id}-signout" type="button"${busy ? ' disabled' : ''}>Sign Out…</button>`
        : `<button class="sd-btn sd-primary" data-act="${id}-signin" type="button"${busy ? ' disabled' : ''}>${signInLabel}</button>`}
    </div>
    ${confirming === id ? `
    <div class="sd-acct-confirm" role="alertdialog" aria-label="Sign out of ${name}?">
      <span class="sd-grow sd-small">${id === 'claude'
        ? `Sign out of Claude? Claude Code will need to sign in again. ${compact ? '' : `This removes <code>~/.claude/.credentials.json</code>.`}`
        : `Sign out of GitHub? Programs lose outbound connections until you sign in again.`}</span>
      <button class="sd-btn" data-act="cancel" type="button">Cancel</button>
      <button class="sd-btn sd-danger" data-act="${id}-confirm" type="button">Sign Out</button>
    </div>` : ''}`;

  const render = () => {
    if (!alive) return;
    const ghSigned = !!networkCredential();
    host.innerHTML =
      row('github', GITHUB_ICON, 'GitHub', ghSigned ? (gh ? `Signed in as @${gh}` : 'Signed in') : (compact ? 'Not signed in' : 'Not signed in. Lets programs here reach the internet.'), ghSigned, 'Sign In…') +
      row('claude', CLAUDE_ICON, 'Claude', compact && !claude.signedIn ? 'Not signed in' : claudeStateText(claude), claude.signedIn, 'Sign In…');
    host.querySelector<HTMLElement>('.sd-acct-confirm .sd-danger')?.focus();
  };
  const refresh = async () => {
    const [a, c] = await Promise.all([networkCredential() ? signedInAccount().catch(() => null) : null, claudeAccount(fs)]);
    gh = a; claude = c;
    render();
  };

  host.addEventListener('click', async (e) => {
    e.stopPropagation();
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') { confirming = null; render(); return; }
    if (act === 'github-signout') { confirming = 'github'; render(); return; }
    if (act === 'claude-signout') { confirming = 'claude'; render(); return; }
    if (act === 'github-confirm') { confirming = null; signOut(); gh = null; render(); return; }
    if (act === 'claude-confirm') {
      confirming = null; busy = true; render();
      await signOutClaude(fs);
      busy = false;
      await refresh();
      return;
    }
    if (act === 'github-signin') { opts.onOpenSheet?.(); await openSignIn(); void refresh(); return; }
    if (act === 'claude-signin') { opts.onOpenSheet?.(); await openClaudeSheet(opts.wm, fs, {}); void refresh(); }
  });
  host.addEventListener('keydown', (e) => { if (e.key === 'Escape' && confirming) { e.stopPropagation(); confirming = null; render(); } });

  // Either account can change elsewhere: `claude` signing in from the terminal, another sheet
  const offFs = fs.onChange((_ev, path) => { if (path === CLAUDE_CREDENTIALS_PATH || path === '/home/user/.claude.json') void refresh(); });
  const offNet = onNetworkStatus(() => void refresh());
  render();
  void refresh();
  return () => { alive = false; offFs(); offNet?.(); };
}

// ── The Claude sign-in sheet ──

let current: Promise<boolean> | null = null;

/** The desktop's Claude sign-in: a sheet like the GitHub one, in the desktop's style */
export function openClaudeSheet(wm: WindowManager, fs: FileSystem, opts: ClaudeSignInUIOptions): Promise<boolean> {
  if (current) return current;
  const sheet = document.createElement('div');
  sheet.className = 'sd-sheet sd-claude-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Sign in to Claude');
  current = new Promise<boolean>((resolve) => {
    let closed = false;
    const done = (ok: boolean) => {
      if (closed) return;
      closed = true;
      current = null;
      sheet.classList.add('sd-leaving');
      setTimeout(() => sheet.remove(), 220);
      resolve(ok);
    };
    sheet.innerHTML = `
      <div class="sd-sheet-head"><div class="sd-sheet-icon sd-claude-icon">${CLAUDE_ICON}</div><div>
        <h3>Sign in to Claude</h3>
        <p>${esc(opts.subtitle || claudeSignInSubtitle())}</p>
      </div></div>
      <ol class="sd-steps">
        <li><span class="sd-step-n">1</span><span class="sd-grow">Open the sign-in page and approve access.</span>
          <a class="sd-btn sd-primary" data-act="open" target="_blank" rel="noopener" aria-disabled="true">Open Sign-in Page</a></li>
        <li><span class="sd-step-n">2</span><span class="sd-grow">Paste the code the page shows you.</span></li>
      </ol>
      <form class="sd-code-form">
        <input class="sd-input" name="code" type="text" placeholder="Paste code here" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Code from the sign-in page">
        <button class="sd-btn sd-primary" data-act="submit" type="submit">Sign In</button>
      </form>
      <div class="sd-status-line" aria-live="polite"></div>
      <div class="sd-sheet-actions"><span class="sd-grow"></span><button class="sd-btn" data-act="cancel" type="button">Not Now</button></div>`;
    const status = (text: string, cls = '') => {
      const s = sheet.querySelector<HTMLElement>('.sd-status-line')!;
      s.textContent = text;
      s.className = 'sd-status-line ' + cls;
    };
    const input = sheet.querySelector<HTMLInputElement>('input[name=code]')!;
    const submit = sheet.querySelector<HTMLButtonElement>('[data-act=submit]')!;
    const open = sheet.querySelector<HTMLAnchorElement>('[data-act=open]')!;
    const flowP = beginClaudeSignIn(fs, opts.cwd);
    void flowP.then((f) => { open.href = f.authorizeUrl; open.removeAttribute('aria-disabled'); }, (e) => status(`Couldn't start sign-in: ${e?.message ?? e}`, 'err'));
    open.addEventListener('click', () => { status('Waiting for the code from the sign-in page…'); setTimeout(() => input.focus(), 300); });
    sheet.querySelector('form')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = input.value.trim();
      if (!code) { input.focus(); return; }
      submit.disabled = true;
      status('Signing in…');
      try {
        await (await flowP).complete(code);
        status('Signed in. Claude Code is ready.', 'ok');
        setTimeout(() => done(true), 900);
      } catch (err) {
        submit.disabled = false;
        status((err as Error)?.message ?? String(err), 'err');
      }
    });
    sheet.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act=cancel]')) done(false);
    });
    sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    wm.root.appendChild(sheet);
    setTimeout(() => (open.hasAttribute('aria-disabled') ? input : open).focus(), 50);
  });
  return current;
}

