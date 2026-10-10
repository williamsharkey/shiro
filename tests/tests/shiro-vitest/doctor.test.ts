/**
 * doctor / tabinfo: one OK/WARN/FAIL line per check, for a bug report;
 * never prints a token.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import { doctorCmd, tabinfoCmd } from '@shiro/commands/doctor';

const SECRET = 'ghp_doNotPrintThisToken123';

afterEach(() => { vi.unstubAllGlobals(); });

async function doctor(name = 'doctor', fetchImpl?: (url: string, init?: any) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl ?? (async (url: string) => {
    const u = String(url);
    if (u.endsWith('/deployed.txt')) return new Response('0123456789abcdef0123456789abcdef01234567\n');
    if (u.endsWith('/api/github/user')) return new Response(JSON.stringify({ login: 'octocat' }), { headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/tcp/token')) return new Response(JSON.stringify({ token: 't' }));
    if (u.endsWith('blink.wasm')) return new Response(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    return new Response('', { status: 404 });
  })));
  const { fs, shell } = await createTestShell();
  shell.commands.register(doctorCmd);
  shell.commands.register(tabinfoCmd);
  shell.env.GITHUB_TOKEN = SECRET;
  await fs.mkdir('/var/lib/shiro', { recursive: true });
  await fs.writeFile('/var/lib/shiro/rootfs.json', JSON.stringify({ version: '13.1', suite: 'trixie', snapshot: '20261001T000000Z', installedAt: Date.UTC(2026, 9, 1) }));
  let out = '';
  const code = await shell.execute(name, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('doctor', () => {
  it('warns when this tab was built from another commit than the server deployed (reload)', async () => {
    vi.stubGlobal('__BUILD_SHA__', 'fedcba9876543210fedcba9876543210fedcba98');
    const { out } = await doctor();
    expect(out).toMatch(/^WARN\s+build\s+#\d+ · this tab fedcba987654, server 0123456789ab \(reload to update\)/m);
  });

  it('prints one status line per check, never a token', async () => {
    const { out } = await doctor();
    const lines = out.trim().split('\n');
    for (const l of lines) expect(l).toMatch(/^(OK|WARN|FAIL|INFO)\s+\S/);
    const label = (name: string) => lines.find((l) => new RegExp(`^\\S+\\s+${name}\\s`).test(l)) ?? '';
    expect(label('build')).toMatch(/^OK\s+build\s+#\d+ · deploy 0123456789ab/);
    expect(label('x86 engine')).toMatch(/blink\.wasm .* sha256 [0-9a-f]{12} · same-instance fork on \(default\)/);
    expect(label('relay token')).toMatch(/^OK .*→ 200/);
    expect(label('tcp connect')).toMatch(/example\.com:443/);
    expect(label('github')).toMatch(/^OK\s+github\s+gh: logged in to github\.com as octocat/);
    expect(label('claude')).toMatch(/not signed in/);
    expect(label('debian')).toMatch(/^OK\s+debian\s+Debian 13\.1 \(trixie/);
    expect(label('kernel')).toMatch(/\d+ process(es)?\b/);
    // Installed prebuilt packages against the local index (pkg-outdated.test.ts covers the WARN case)
    expect(label('packages')).toMatch(/^(OK|INFO|WARN)\s+packages\s+(no prebuilt packages installed|\d+ installed, all at the index versions|\d+ upgradable)/);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('ghp_');
  });

  it('a rejected token, an unreachable deploy file and no Debian are WARN/FAIL/INFO lines, not errors; tabinfo is the same', async () => {
    const { out, code } = await doctor('tabinfo', async (url) => {
      if (String(url).endsWith('/api/github/user')) return new Response('{}', { status: 401 });
      throw new Error('offline');
    });
    expect(out).toMatch(/^WARN\s+build\s+.*\/deployed\.txt unreachable/m);
    expect(out).toMatch(/^FAIL\s+github\s+gh: token rejected \(HTTP 401\)/m);
    expect(out).toMatch(/^FAIL\s+relay token\s+request failed: offline/m);
    expect(code).toBe(1);
    expect(out).not.toContain(SECRET);
  });
});
