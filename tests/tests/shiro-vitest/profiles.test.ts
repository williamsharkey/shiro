/**
 * Product profiles (profiles/<id>/profile.json, src/profile.ts,
 * docs/PROFILES.md): which profile a host gets, the ?profile= override, that
 * server.mjs agrees with the page, and that each shim a profile turns off is off.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { PROFILES, selectProfile, setActiveProfile, activeProfile, PROFILE_KEY, type Profile } from '@shiro/profile';
import { pickProfile } from '../../../profiles/select.mjs';
import { uiMode } from '@shiro/ui-mode';
import { createTestShell, run } from './helpers';

// Node has no localStorage; ?profile= and ?ui= are remembered there
if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

const loc = (search: string, hostname: string) => ({ search, hostname });
const HOSTS = ['shiro.computer', 'music.shiro.computer', 'tabcomputer.com', 'www.tabcomputer.com', 'x.tabcomputer.com', 'localhost', 'unix.computer', 'shiro.computer.evil.com', ''];

/** A copy of a profile with some shims changed, made active. */
function withShims(shims: Partial<Profile['shims']>): Profile {
  const base = PROFILES.find((p) => p.id === 'tabcomputer')!;
  const p = { ...base, id: 'test', shims: { ...base.shims, ...shims } };
  setActiveProfile(p);
  return p;
}

beforeEach(() => { localStorage.removeItem(PROFILE_KEY); localStorage.removeItem('tabcomputer-ui'); });
afterEach(() => { setActiveProfile(null); vi.unstubAllGlobals(); });

describe('profile selection', () => {
  it('picks by host: shiro.computer and its subdomains are shiro, every other host tabcomputer', () => {
    const ids = HOSTS.map((h) => selectProfile(loc('', h)).id);
    expect(ids).toEqual(['shiro', 'shiro', 'tabcomputer', 'tabcomputer', 'tabcomputer', 'tabcomputer', 'tabcomputer', 'tabcomputer', 'tabcomputer']);
  });

  it('?profile= overrides and is remembered; an empty or unknown one forgets', () => {
    expect(selectProfile(loc('?profile=shiro', 'tabcomputer.com')).id).toBe('shiro');
    expect(selectProfile(loc('', 'tabcomputer.com')).id).toBe('shiro');
    expect(selectProfile(loc('?profile=', 'tabcomputer.com')).id).toBe('tabcomputer');
    expect(selectProfile(loc('?profile=nope', 'shiro.computer')).id).toBe('shiro');
    expect(localStorage.getItem(PROFILE_KEY)).toBe(null);
  });

  it('the UI mode follows the profile unless ?ui= says otherwise', () => {
    expect(uiMode(loc('', 'shiro.computer'), false)).toBe('terminal');
    expect(uiMode(loc('?profile=tabcomputer', 'shiro.computer'), false)).toBe('desktop');
    localStorage.removeItem(PROFILE_KEY);
    expect(uiMode(loc('?ui=terminal', 'tabcomputer.com'), false)).toBe('terminal');
  });

  it('server.mjs picks the same profile and brands only branded ones', async () => {
    const { execFileSync } = await import('node:child_process');
    const server = new URL('../../../server.mjs', import.meta.url).href;
    const out = execFileSync('node', ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(server)}); const h = '<head><title>shiro</title></head>';
       console.log(JSON.stringify({ ids: ${JSON.stringify(HOSTS)}.map((x) => m.profileFor(x)?.id),
         override: m.profileFor('tabcomputer.com', 'shiro').id,
         shiroOnTab: m.brandAppShell(h, 'tabcomputer.com', m.profileFor('tabcomputer.com', 'shiro').brand),
         tab: m.brandAppShell(h, 'tabcomputer.com:443') })); process.exit(0);`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r.ids).toEqual(HOSTS.map((h) => pickProfile([...PROFILES], h).id));
    expect(r.override).toBe('shiro');
    expect(r.shiroOnTab).toBe('<head><title>shiro</title></head>');
    expect(r.tab).toContain('<title>tabcomputer</title>');
  });

  it('every profile declares every field', () => {
    for (const p of PROFILES) {
      expect(['desktop', 'terminal']).toContain(p.ui);
      expect(['hud', 'desktop']).toContain(p.banner);
      expect(Object.keys(p.shims).sort()).toEqual(['binCommandStat', 'claude', 'claudeInstallSh', 'debianOverlay', 'python', 'tabSsh']);
    }
    expect(PROFILES.filter((p) => p.default)).toHaveLength(1);
  });

  it('tests run as the default profile, with every shim on', () => {
    expect(activeProfile().id).toBe('tabcomputer');
    expect(Object.values(activeProfile().shims)).toEqual(['npm', true, true, true, true, 'pyodide']);
  });
});

describe('shims a profile turns off', () => {
  it('claudeInstallSh off: curl of claude.ai/install.sh fetches the real script', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => { fetched.push(String(u)); return new Response('#!/bin/sh\necho real installer\n'); });
    const { shell } = await createTestShell();
    expect((await run(shell, 'curl -fsSL https://claude.ai/install.sh')).output).toContain('npm install -g');
    withShims({ claudeInstallSh: false });
    expect((await run(shell, 'curl -fsSL https://claude.ai/install.sh')).output).toContain('real installer');
    expect(fetched).toEqual(['https://claude.ai/install.sh']);
  });

  it('tabSsh off: ssh CODE is OpenSSH usage (the install hint without OpenSSH)', async () => {
    const { sshCmd } = await import('@shiro/commands/ssh');
    const { shell } = await createTestShell();
    shell.commands.register(sshCmd);
    withShims({ tabSsh: false });
    const r = await run(shell, 'ssh fluffy-cloud-shimutako');
    expect(r.exitCode).toBe(255);
    expect(r.output).toContain('pkg install openssh');
  });

  it("claude 'native': plain claude runs the native binary; --npm and CLAUDE_NATIVE=0 still pick npm", async () => {
    const { claudeCmd } = await import('@shiro/commands/claude');
    const { shell } = await createTestShell();
    shell.commands.register(claudeCmd);
    withShims({ claude: 'native' });
    const r = await run(shell, 'CLAUDE_NATIVE_PATH=/nowhere/claude claude --version');
    expect(r.output).toContain('no native Claude Code binary at /nowhere/claude');
    const ctx: any = { args: ['--npm', 'update'], env: {}, stdout: '', stderr: '', fs: null, shell };
    expect(await claudeCmd.exec(ctx)).toBe(0);
    expect(ctx.stdout).toContain('pinned');
  });

  it('debianOverlay off: the overlay defaults keep Debian\'s programs', async () => {
    const ov = await import('@shiro/debian/overlay');
    const { fs } = await createTestShell();
    const path = Object.entries(ov.POLICY).find(([, p]) => p.default === 'shiro')![0];
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, '#!/bin/sh\necho debian\n', { mode: 0o755 });
    withShims({ debianOverlay: false });
    await ov.applyDefaults(fs, [path]);
    expect((await ov.programState(fs, path)).current).toBe('debian');
  });
});
