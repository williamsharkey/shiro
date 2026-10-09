/**
 * Base commands agents and scripts expect (williamsharkey/tabcomputer#9):
 * envsubst, groups, id, locale, getent, nslookup, dig, flock, ping, strace,
 * and the package/tmux/alternatives fixes from the same audit.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import * as base from '@shiro/commands/base-utils';
import { netStackOf, netStack } from '@shiro/kernel/net';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';

let fs: FileSystem;
let shell: Shell;

/** A DNS-over-HTTPS answer for example.test only */
const dohFetch = (async (url: string) => {
  const u = new URL(url);
  const name = u.searchParams.get('name');
  const type = u.searchParams.get('type');
  const Answer = name === 'example.test'
    ? (type === 'A' ? [{ type: 1, data: '93.184.215.14' }] : [{ type: 28, data: '2606:2800:21f:cb07::1' }])
    : [];
  return new Response(JSON.stringify({ Status: Answer.length ? 0 : 3, Answer }));
}) as typeof fetch;

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  shell.commands.registerAll([base.envsubstCmd, base.groupsCmd, base.localeCmd, base.getentCmd, base.nslookupCmd, base.digCmd, base.flockCmd, base.pingCmd, base.straceCmd]);
  const stack = netStackOf(kernelForContext({ fs, shell } as unknown as CommandContext)) ?? netStack;
  stack.configure({ relayUrl: null, dohUrl: 'https://doh.test/dns-query', fetch: dohFetch });
});

async function sh(cmd: string) {
  let out = '';
  let err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

describe('envsubst', () => {
  it('substitutes exported variables; SHELL-FORMAT limits which; -v lists them', async () => {
    expect((await sh("export A=1 C=3; L=local; echo 'a=$A b=${C} u=$UNSET l=$L' | envsubst")).out).toBe('a=1 b=3 u= l=\n');
    expect((await sh("export A=1; echo '$A $HOME' | envsubst '$A'")).out).toBe('1 $HOME\n');
    expect((await sh("envsubst -v 'x $A ${B}'")).out).toBe('A\nB\n');
  });
});

describe('users and groups', () => {
  it('groups and id agree with /etc/passwd and /etc/group', async () => {
    expect((await sh('groups')).out).toBe('user tty\n');
    expect((await sh('groups root')).out).toBe('root : root\n');
    expect((await sh('id')).out).toBe('uid=1000(user) gid=1000(user) groups=1000(user),5(tty)\n');
    expect((await sh('id -Gn')).out).toBe('user tty\n');
    expect((await sh('id nobody-here')).code).toBe(1);
  });
  it('getent passwd, group (by name or number), and 2 for a missing key', async () => {
    expect((await sh('getent passwd user')).out).toMatch(/^user:x:1000:1000:.*:\/home\/user:\/bin\/sh\n$/);
    expect((await sh('getent group 5')).out).toBe('tty:x:5:user\n');
    expect((await sh('getent passwd nosuch; echo "rc=$?"')).out).toBe('rc=2\n');
    expect((await sh('getent frob x; echo "rc=$?"')).out).toMatch(/rc=1/);
  });
});

describe('locale', () => {
  it('reports C.UTF-8 and lists the locales', async () => {
    const r = await sh('LANG=C.UTF-8 locale');
    expect(r.out).toContain('LANG=C.UTF-8\n');
    expect(r.out).toContain('LC_CTYPE="C.UTF-8"\n');
    expect((await sh('locale -a')).out).toBe('C\nC.utf8\nPOSIX\n');
    expect((await sh('locale charmap')).out).toBe('UTF-8\n');
  });
});

describe('name resolution through the resolver (DoH stubbed)', () => {
  it('getent hosts: /etc/hosts first, then the resolver; 2 when not found', async () => {
    expect((await sh('getent hosts localhost')).out).toMatch(/^127\.0\.0\.1\s+localhost\n$/);
    expect((await sh('getent hosts example.test')).out).toMatch(/^93\.184\.215\.14\s+example\.test\n$/);
    expect((await sh('getent ahostsv6 example.test')).out).toContain('2606:2800:21f:cb07::1');
    expect((await sh('getent hosts nx.test; echo "rc=$?"')).out).toBe('rc=2\n');
  });
  it('nslookup and dig', async () => {
    expect((await sh('nslookup example.test')).out).toContain('Name:\texample.test\nAddress: 93.184.215.14\n');
    expect((await sh('nslookup nx.test; echo "rc=$?"')).out).toMatch(/can't find nx\.test: NXDOMAIN\nrc=1\n$/);
    expect((await sh('dig +short example.test')).out).toBe('93.184.215.14\n');
    expect((await sh('dig +short AAAA example.test')).out).toBe('2606:2800:21f:cb07::1\n');
    expect((await sh('dig example.test')).out).toMatch(/ANSWER SECTION:\nexample\.test\.\t\t300\tIN\tA\t93\.184\.215\.14/);
  });
});

describe('flock', () => {
  it('runs the command holding the lock; -n fails with 1 while another holds it', async () => {
    expect((await sh("flock /tmp/l.lock -c 'echo inside'")).out).toBe('inside\n');
    const r = await sh('flock /tmp/l.lock sleep 0.4 & sleep 0.1; flock -n /tmp/l.lock true; echo "busy=$?"; wait; flock -n /tmp/l.lock true; echo "free=$?"');
    expect(r.out.replace(/^\[1\] \d+\n/, '')).toBe('busy=1\nfree=0\n');
  });
  it('flock FD locks the file the fd has open until flock -u FD', async () => {
    const r = await sh('exec 9>/tmp/fd.lock; flock 9; flock -n /tmp/fd.lock true; echo "held=$?"; flock -u 9; flock -n /tmp/fd.lock true; echo "after=$?"');
    expect(r.out).toBe('held=1\nafter=0\n');
  });
});

describe('ping and strace', () => {
  it('ping explains that ICMP is unavailable and suggests curl', async () => {
    const r = await sh('ping -c 1 example.com');
    expect(r.code).toBe(2);
    expect(r.err).toContain("ICMP isn't available in the browser");
    expect(r.err).toContain('curl');
  });
  it('strace traces an x86 program, and explains a builtin', async () => {
    await fs.mkdir('/usr/local/bin', { recursive: true });
    await fs.writeFile('/usr/local/bin/hello', new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', 'hello-musl'))), { mode: 0o755 });
    let r = await sh('strace hello');
    expect(r.out).toBe('Hello, world!\n');
    expect(r.err).toMatch(/write\(1, .*\) = 14\n/);
    expect(r.err).toMatch(/\+\+\+ exited with 0 \+\+\+\n$/);
    r = await sh('strace echo hi');
    expect(r.err).toContain('made no system calls: it is a tabcomputer builtin');
  }, 60_000);
});

describe('pkg, tmux, alternatives', () => {
  it('an x86 package is installable whatever the WASM mode (perl in JSPI mode)', async () => {
    const pm = await import('@shiro/pkg-manager');
    const { forceWasmProcessMode } = await import('@shiro/wasi/host');
    forceWasmProcessMode('jspi');
    try {
      await pm.refreshRuntimeMode();
      const perl = pm.builtinIndex().packages.find((p) => p.name === 'perl')!;
      expect(perl.needs).toContain('threads');
      expect(pm.missingFeatures(perl)).toEqual([]);
      // a WASM package that needs threads is still blocked in JSPI mode
      expect(pm.missingFeatures({ ...perl, abi: 'wasix' } as any)).toEqual(['threads']);
    } finally {
      forceWasmProcessMode(null);
      await pm.refreshRuntimeMode();
    }
  });
  it('tmux -V answers without a terminal', async () => {
    const { tmuxCmd } = await import('@shiro/commands/tmux');
    shell.commands.register(tmuxCmd);
    const r = await sh('tmux -V');
    expect(r.out).toMatch(/^tmux \d/);
    expect(r.code).toBe(0);
  });
  it('tabcomputer-alternatives --list says Debian is not installed instead of listing "debian"', async () => {
    const r = await sh('tabcomputer-alternatives --list');
    expect(r.out.split('\n')[0]).toContain('Debian is not installed');
    expect(r.out).not.toMatch(/\tdebian\t/);
  });
});
