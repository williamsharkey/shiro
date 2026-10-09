/**
 * Accounts (src/desktop/accounts.ts, src/claude-signin.ts; docs/DESKTOP.md
 * "Accounts"): the Claude account's state from Claude Code's own files (never
 * a token), sign out with an in-page confirmation, the desktop's sign-in UI
 * taking over from the floating panel, and copy that names the brand.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_CREDENTIALS_PATH, claudeAccount, claudeSignInSubtitle, openClaudeSignIn, signOutClaude } from '@shiro/claude-signin';
import { setClaudeSignInUI } from '@shiro/claude-signin-ui';
import { BRAND } from '@shiro/brand';

if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
  };
}

/** Just enough of FileSystem: files in a map, change listeners */
function memFs(files: Record<string, string> = {}) {
  const m = new Map(Object.entries(files));
  const listeners = new Set<(ev: string, path: string) => void>();
  const emit = (ev: string, p: string) => { for (const l of listeners) l(ev, p); };
  return {
    files: m,
    async readFile(p: string) { if (!m.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return m.get(p)!; },
    async writeFile(p: string, d: string) { m.set(p, d); emit('change', p); },
    async unlink(p: string) { if (!m.delete(p)) throw new Error('ENOENT'); emit('unlink', p); },
    onChange(l: (ev: string, path: string) => void) { listeners.add(l); return () => listeners.delete(l); },
  };
}

const TOKEN = 'sk-ant-oat01-SECRET';
const signedIn = () => memFs({
  [CLAUDE_CREDENTIALS_PATH]: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'sk-ant-ort01-SECRET', expiresAt: Date.now() + 1e6, scopes: ['user:inference'], subscriptionType: 'max' } }),
  '/home/user/.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'ada@example.com', organizationName: 'Example' } }),
});
const tick = () => new Promise(r => setTimeout(r, 0));

describe('Claude account state', () => {
  it('reads plan and account from Claude Code\'s files, never the tokens', async () => {
    const a = await claudeAccount(signedIn() as any);
    expect(a).toEqual({ signedIn: true, plan: 'max', email: 'ada@example.com', organization: 'Example' });
    expect(JSON.stringify(a)).not.toContain('SECRET');
    expect(await claudeAccount(memFs() as any)).toEqual({ signedIn: false });
    expect(await claudeAccount(memFs({ [CLAUDE_CREDENTIALS_PATH]: '{"claudeAiOauth":{}}' }) as any)).toEqual({ signedIn: false });
    expect(await claudeAccount(memFs({ [CLAUDE_CREDENTIALS_PATH]: 'not json' }) as any)).toEqual({ signedIn: false });
  });

  it('signing out removes the credentials file (and is quiet when there is none)', async () => {
    const fs = signedIn();
    await signOutClaude(fs as any);
    expect(fs.files.has(CLAUDE_CREDENTIALS_PATH)).toBe(false);
    expect(fs.files.has('/home/user/.claude.json')).toBe(true);
    await signOutClaude(fs as any);
  });

  it('the copy names the brand, not Shiro', () => {
    expect(claudeSignInSubtitle()).toBe(`Use your Claude account for Claude Code in ${BRAND.name}.`);
    expect(claudeSignInSubtitle()).not.toMatch(/shiro/i);
  });

  it('a registered UI (the desktop sheet) replaces the floating panel', async () => {
    const seen: unknown[] = [];
    setClaudeSignInUI(async (o) => { seen.push(o); return true; });
    expect(await openClaudeSignIn({ fs: memFs() as any, cwd: '/home/user/p', subtitle: 'why' })).toBe(true);
    expect(seen).toEqual([{ subtitle: 'why', cwd: '/home/user/p' }]);
    setClaudeSignInUI(null);
  });
});

describe('Accounts rows', () => {
  beforeEach(() => { document.body.innerHTML = ''; localStorage.removeItem('tabcomputer_github_token'); });

  it('names the plan and account; Sign out asks in the page first', async () => {
    const { renderAccounts, claudeStateText, planName } = await import('@shiro/desktop/accounts');
    expect(planName('max')).toBe('Claude Max');
    expect(planName('enterprise')).toBe('Claude Enterprise');
    expect(planName(undefined)).toBeNull();
    expect(claudeStateText({ signedIn: true, plan: 'pro', email: 'ada@example.com' })).toBe('Signed in as ada@example.com · Claude Pro');
    expect(claudeStateText({ signedIn: true })).toBe('Signed in');

    const fs = signedIn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const off = renderAccounts(host, { wm: { root: document.body } as any, fs: fs as any });
    await tick(); await tick();
    const claude = () => host.querySelector('[data-acct=claude]')!;
    expect(claude().textContent).toContain('ada@example.com · Claude Max');
    expect(host.innerHTML).not.toContain('SECRET');
    expect(host.querySelector('[data-acct=github] [data-act=github-signin]')).not.toBeNull();

    // Sign Out… asks; Cancel keeps the file
    (claude().querySelector('[data-act=claude-signout]') as HTMLElement).click();
    expect(host.querySelector('.sd-acct-confirm')?.textContent).toContain('Sign out of Claude?');
    (host.querySelector('.sd-acct-confirm [data-act=cancel]') as HTMLElement).click();
    expect(host.querySelector('.sd-acct-confirm')).toBeNull();
    expect(fs.files.has(CLAUDE_CREDENTIALS_PATH)).toBe(true);

    // Confirm removes it, and the row says so
    (claude().querySelector('[data-act=claude-signout]') as HTMLElement).click();
    (host.querySelector('.sd-acct-confirm [data-act=claude-confirm]') as HTMLElement).click();
    await tick(); await tick(); await tick();
    expect(fs.files.has(CLAUDE_CREDENTIALS_PATH)).toBe(false);
    expect(claude().textContent).toContain('Not signed in');
    expect(claude().querySelector('[data-act=claude-signin]')).not.toBeNull();

    // Signing in from elsewhere (the terminal's claude) shows up here
    await fs.writeFile(CLAUDE_CREDENTIALS_PATH, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, subscriptionType: 'pro' } }));
    await tick(); await tick(); await tick();
    expect(claude().textContent).toContain('Claude Pro');
    off();
  });
});
