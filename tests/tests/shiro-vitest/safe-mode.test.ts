import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  safeModeReason, bootStarted, bootFinished, bootStep, bootProblems, normalUrl, safeModeBanner,
  UNFINISHED_KEY, UNFINISHED_LIMIT, RESTORED_STATE_KEYS,
} from '@shiro/safe-mode';
import { safeModeCmd } from '@shiro/commands/safe-mode';
import { createTestShell } from './helpers';

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    map: m,
  };
}
const loc = (search = '', hash = '') => ({ search, hash });

describe('safe mode', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('is on when asked for in the address, and not otherwise', () => {
    const none = memoryStore();
    expect(safeModeReason(loc(''), none)).toBeNull();
    expect(safeModeReason(loc('?safe=1'), none)).toContain('asked for');
    expect(safeModeReason(loc('?safe'), none)).toContain('asked for');
    expect(safeModeReason(loc('?ui=terminal&safe=1'), none)).toContain('asked for');
    expect(safeModeReason(loc('?safe=0'), none)).toBeNull();
    expect(safeModeReason(loc('', '#safe'), none)).toContain('asked for');
    expect(safeModeReason(loc('', '#safety'), none)).toBeNull();
  });

  it("turns itself on after loads that never reached the prompt (sessionStorage, not localStorage)", () => {
    const session = memoryStore();
    for (let i = 0; i < UNFINISHED_LIMIT; i++) {
      expect(safeModeReason(loc(''), session)).toBeNull();
      bootStarted(session); // ... and the page froze before the prompt
    }
    expect(safeModeReason(loc(''), session)).toContain(`last ${UNFINISHED_LIMIT} loads`);
    // a load that gets to the prompt resets it
    bootStarted(session);
    bootFinished(session);
    expect(session.map.has(UNFINISHED_KEY)).toBe(false);
    expect(safeModeReason(loc(''), session)).toBeNull();
    // no storage at all: never on by itself
    expect(safeModeReason(loc(''), null)).toBeNull();
  });

  it('bootStep: a step that throws or hangs is logged and the boot goes on', async () => {
    bootProblems.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await bootStep('fine', () => 42)).toBe(42);
    expect(await bootStep('async fine', async () => 'x')).toBe('x');
    expect(await bootStep('throws', () => { throw new Error('boom'); })).toBeUndefined();
    vi.useFakeTimers();
    const hung = bootStep('hangs', () => new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await hung).toBeUndefined();
    expect(bootProblems).toEqual(['throws: boom', 'hangs: still running after 1 s (boot went on without it)']);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(['[boot] throws failed:', '[boot] hangs: still running after 1 s; going on without it']);
    warn.mockRestore();
  });

  it('the banner says how to leave it; the normal address drops only the safe switches', () => {
    expect(normalUrl('https://tabcomputer.com/?safe=1')).toBe('https://tabcomputer.com/');
    expect(normalUrl('https://grok.tabcomputer.com/?ui=terminal&safe=1#safe')).toBe('https://grok.tabcomputer.com/?ui=terminal');
    const banner = safeModeBanner('asked for (?safe=1)', 'https://tabcomputer.com/?safe=1').join('\n');
    expect(banner).toContain('Safe mode');
    expect(banner).toContain('~/.profile');
    expect(banner).toContain('safe-mode exit');
    expect(banner).toContain('reload https://tabcomputer.com/)');
  });

  it('safe-mode reset-layout clears only restored-state keys; disable-profile renames ~/.profile, never over a file', async () => {
    const ls = memoryStore({ 'tabcomputer-desktop-session': '{}', 'tabcomputer-panes': '{}', 'tabcomputer-console-log': '{}', tabcomputer_github_token: 'keep' });
    vi.stubGlobal('localStorage', ls);
    const { fs, shell } = await createTestShell();
    shell.commands.register(safeModeCmd);
    const run = async (cmd: string) => {
      let out = '';
      const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
      return { code, out: out.replace(/\r\n/g, '\n') };
    };
    const reset = await run('safe-mode reset-layout');
    expect(reset.code).toBe(0);
    expect(reset.out).toContain('tabcomputer-desktop-session');
    expect([...ls.map.keys()]).toEqual(['tabcomputer_github_token']);
    expect(RESTORED_STATE_KEYS).not.toContain('tabcomputer_github_token');
    expect((await run('safe-mode reset-layout')).out).toContain('No saved layout');

    await fs.writeFile('/home/user/.profile', 'claude\n');
    await fs.writeFile('/home/user/.profile.disabled', 'an older one\n');
    const dis = await run('safe-mode disable-profile');
    expect(dis.code).toBe(0);
    expect(await fs.exists('/home/user/.profile')).toBe(false);
    expect(await fs.readFile('/home/user/.profile.disabled', 'utf8')).toBe('an older one\n');
    expect(await fs.readFile('/home/user/.profile.disabled.2', 'utf8')).toBe('claude\n');
    expect((await run('safe-mode disable-profile')).out).toContain('no ~/.profile');
    expect((await run('safe-mode')).out).toContain('Safe mode is off');
    expect((await run('safe-mode bogus')).code).toBe(2);
  });
});
