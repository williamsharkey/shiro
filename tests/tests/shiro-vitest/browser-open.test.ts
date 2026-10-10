/**
 * What native Claude Code's own sign-in needs from tabcomputer: xdg-open
 * opening the manual sign-in page in a real tab (or offering it when the
 * browser blocks the tab), and xclip/xsel on the browser clipboard so it
 * never reaches its native clipboard addon, which hangs under Blink.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import { manualSignInUrl, openUrl, CLAUDE_MANUAL_REDIRECT } from '@shiro/open-url';
import { openCmd } from '@shiro/commands/shiro-cmds';
import { xclipCmd, xselCmd, pbpasteCmd } from '@shiro/commands/pbcopy';
import { installAlwaysShims, ALWAYS_SHIMS } from '@shiro/path-shims';
import { loginArgs } from '@shiro/commands/claude';

const AUTO = 'https://claude.com/cai/oauth/authorize?client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code'
  + '&redirect_uri=http%3A%2F%2Flocalhost%3A40123%2Fcallback&scope=user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=xyz';

describe('manualSignInUrl', () => {
  it("sends Claude Code's localhost sign-in to the manual code page", () => {
    const u = new URL(manualSignInUrl(AUTO));
    expect(u.searchParams.get('redirect_uri')).toBe(CLAUDE_MANUAL_REDIRECT);
    expect(u.searchParams.get('code')).toBe('true');
    expect(u.searchParams.get('state')).toBe('xyz');
    expect(u.searchParams.get('code_challenge')).toBe('abc');
  });

  it('leaves other URLs alone', () => {
    const manual = manualSignInUrl(AUTO);
    expect(manualSignInUrl(manual)).toBe(manual);
    expect(manualSignInUrl('https://example.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2F')).toBe('https://example.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2F');
    expect(manualSignInUrl('not a url')).toBe('not a url');
  });
});

describe('opening a page', () => {
  let shell: Shell;
  const realOpen = window.open;
  beforeEach(async () => {
    shell = (await createTestShell()).shell;
    shell.commands.register(openCmd);
    shell.commands.register({ name: 'xdg-open', description: '', exec: (ctx) => openCmd.exec(ctx) });
    document.getElementById('tabcomputer-open-offer')?.remove();
  });
  afterEach(() => { window.open = realOpen; });

  it('opens a new tab when the browser allows it', () => {
    const opened: string[] = [];
    window.open = ((u: string) => { opened.push(u); return {} as Window; }) as typeof window.open;
    expect(openUrl('https://example.com/')).toBe('opened');
    expect(opened).toEqual(['https://example.com/']);
    expect(document.getElementById('tabcomputer-open-offer')).toBeNull();
  });

  it('offers a link to click when the browser blocks the tab', () => {
    window.open = (() => null) as typeof window.open;
    expect(openUrl('https://example.com/page')).toBe('offered');
    const card = document.getElementById('tabcomputer-open-offer')!;
    expect(card.textContent).toContain('example.com');
    expect(card.querySelector('a')!.getAttribute('href')).toBe('https://example.com/page');
  });

  it('xdg-open returns at once with the manual sign-in URL', async () => {
    const opened: string[] = [];
    window.open = ((u: string) => { opened.push(u); return {} as Window; }) as typeof window.open;
    const { exitCode } = await run(shell, `xdg-open '${AUTO}'`);
    expect(exitCode).toBe(0);
    expect(opened).toEqual([manualSignInUrl(AUTO)]);
  });
});

describe('the clipboard tools', () => {
  let shell: Shell;
  let fs: FileSystem;
  let clip = '';
  const nav = navigator as any;
  const realClipboard = nav.clipboard;
  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    for (const c of [xclipCmd, xselCmd, pbpasteCmd]) shell.commands.register(c);
    clip = 'from the browser';
    Object.defineProperty(nav, 'clipboard', { configurable: true, value: { readText: async () => clip, writeText: async (t: string) => { clip = t; } } });
  });
  afterEach(() => { Object.defineProperty(nav, 'clipboard', { configurable: true, value: realClipboard }); });

  it('xclip copies and pastes text', async () => {
    expect((await run(shell, 'xclip -selection clipboard -o')).output).toBe('from the browser');
    await run(shell, 'echo -n copied | xclip -selection clipboard');
    await vi.waitFor(() => expect(clip).toBe('copied'));
    expect((await run(shell, 'pbpaste')).output).toBe('copied');
  });

  it('xclip lists only text targets, so a caller finds no image and moves on', async () => {
    const t = await run(shell, 'xclip -selection clipboard -t TARGETS -o');
    expect(t.exitCode).toBe(0);
    expect(t.output).toContain('UTF8_STRING');
    expect(t.output).not.toMatch(/image\//);
    expect((await run(shell, 'xclip -selection clipboard -t image/png -o')).exitCode).toBe(1);
  });

  it('a refused read is empty, not an error', async () => {
    nav.clipboard.readText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
    const r = await run(shell, 'xsel --clipboard --output');
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('');
  });

  it('xsel copies with --input', async () => {
    await run(shell, 'echo -n via-xsel | xsel --clipboard --input');
    await vi.waitFor(() => expect(clip).toBe('via-xsel'));
  });

  it('programs find them on PATH, and running that path runs the builtin', async () => {
    await installAlwaysShims(fs);
    for (const c of ALWAYS_SHIMS) expect((await fs.stat(`/usr/local/bin/${c}`)).mode & 0o111).toBeTruthy();
    expect((await run(shell, '/usr/local/bin/xclip -o')).output).toBe('from the browser');
    // A program someone put there is kept
    await fs.writeFile('/usr/local/bin/xsel', '#!/bin/sh\necho mine\n', { mode: 0o755 });
    await installAlwaysShims(fs);
    expect(await fs.readFile('/usr/local/bin/xsel', 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });
});

describe('claude login', () => {
  it("is Claude Code's own auth login", () => {
    expect(loginArgs(['login'])).toEqual(['auth', 'login']);
    expect(loginArgs(['/login', '--console'])).toEqual(['auth', 'login', '--console']);
    expect(loginArgs(['-p', 'hi'])).toEqual(['-p', 'hi']);
    // the npm build's auth login has no paste prompt; its in-session /login does
    expect(loginArgs(['login'], 'npm')).toEqual(['/login']);
  });
});

describe('the native build version', () => {
  it('reads Claude Code\'s own VERSION constant from the binary, and records it', async () => {
    const { versionInBinary, nativeClaudeVersion, recordNativeVersion } = await import('@shiro/commands/claude-native');
    const enc = new TextEncoder();
    const bin = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, ...enc.encode('xxVERSION:"9.9.9" junk ...README_URL:"https://x",VERSION:"2.1.295",FEEDBACK')]);
    expect(versionInBinary(bin)).toBe('2.1.295');
    expect(versionInBinary(enc.encode('no version here'))).toBe(null);
    const { fs } = await createTestShell();
    await fs.mkdir('/home/user/.local/bin', { recursive: true });
    await fs.writeFile('/home/user/.local/bin/claude', bin, { mode: 0o755 });
    expect(await nativeClaudeVersion(fs, '/home/user/.local/bin/claude', bin)).toBe('2.1.295');
    // recorded: no bytes needed the next time
    expect(await nativeClaudeVersion(fs, '/home/user/.local/bin/claude')).toBe('2.1.295');
    await recordNativeVersion(fs, '/home/user/.local/bin/claude', '2.1.300');
    expect(await nativeClaudeVersion(fs, '/home/user/.local/bin/claude')).toBe('2.1.300');
    // a replaced binary isn't trusted to the record
    await fs.writeFile('/home/user/.local/bin/claude', new Uint8Array([1, 2, 3]), { mode: 0o755 });
    expect(await nativeClaudeVersion(fs, '/home/user/.local/bin/claude')).toBe(null);
  });
});
