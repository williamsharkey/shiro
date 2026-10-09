/**
 * shiro-apt (src/debian/apt-guard.ts): Debian's apt-get with recovery in
 * front, against a mock kernel whose "dpkg" and "apt-get.debian" edit a fake
 * /var/lib/dpkg the way an interrupted run leaves it.
 */
import { describe, it, expect } from 'vitest';
import { aptGuardProgram, aptSubcommand, brokenPackages } from '@shiro/debian/apt-guard';

const STATUS_OK = 'Package: jq\nStatus: install ok installed\nVersion: 1.7\n\nPackage: libjq1\nStatus: install ok installed\n';
const STATUS_BROKEN = 'Package: jq\nStatus: install reinstreq half-installed\n\nPackage: libonig5\nStatus: install ok unpacked\n\nPackage: hello\nStatus: install ok installed\n';

function machine(opts: { status: string; updates?: string[]; uid?: number; behave: (argv: string[], m: any) => number }) {
  const calls: string[] = [];
  const m: any = { status: opts.status, updates: opts.updates ?? [], stderr: '' };
  const proc: any = {
    argv: ['/usr/bin/shiro-apt', '/usr/bin/apt-get', 'install', '-y', 'jq'], env: {}, cwd: '/root', uid: opts.uid ?? 0,
    fds: new Map([[2, { write: async (b: Uint8Array) => { m.stderr += new TextDecoder().decode(b); return b.length; } }]]),
  };
  let next = 100;
  const exits = new Map<number, number>();
  const kernel: any = {
    fs: {
      readdir: async (p: string) => { if (p === '/var/lib/dpkg/updates') return m.updates; throw new Error('ENOENT'); },
      readFile: async (p: string) => { if (p === '/var/lib/dpkg/status') return m.status; throw new Error('ENOENT'); },
    },
    spawn: (o: any) => { calls.push([o.path, ...o.argv.slice(1)].join(' ')); const pid = next++; exits.set(pid, opts.behave([o.path, ...o.argv.slice(1)], m)); return { pid }; },
    waitpid: async (pid: number) => ({ pid, status: (exits.get(pid) ?? 0) << 8 }),
  };
  return { proc, kernel, calls, m };
}

describe('shiro-apt (apt recovery)', () => {
  it('finds the subcommand past options and their values', () => {
    expect(aptSubcommand(['-y', '-o', 'Dpkg::Use-Pty=0', 'install', 'jq'])).toBe('install');
    expect(aptSubcommand(['--option', 'install', 'update'])).toBe('update');
    expect(aptSubcommand(['-qq'])).toBeUndefined();
  });

  it('lists the packages dpkg left part-way', () => {
    expect(brokenPackages(STATUS_OK)).toEqual([]);
    expect(brokenPackages(STATUS_BROKEN)).toEqual(['jq', 'libonig5']);
  });

  it('a healthy system runs Debian\'s apt-get once, with the same arguments', async () => {
    const { proc, kernel, calls, m } = machine({ status: STATUS_OK, behave: () => 0 });
    expect(await aptGuardProgram(proc, kernel)).toBe(0);
    expect(calls).toEqual(['/usr/bin/apt-get.debian install -y jq']);
    expect(m.stderr).toBe('');
  });

  it('an interrupted dpkg and half-installed packages are recovered before the install', async () => {
    const { proc, kernel, calls, m } = machine({
      status: STATUS_BROKEN, updates: ['0001'],
      behave: (argv, m) => {
        if (argv[1] === '--configure') m.updates = [];
        if (argv.includes('-f')) m.status = STATUS_OK;
        return 0;
      },
    });
    expect(await aptGuardProgram(proc, kernel)).toBe(0);
    expect(calls).toEqual(['/usr/bin/dpkg --configure -a', '/usr/bin/apt-get.debian -f install -y', '/usr/bin/apt-get.debian install -y jq']);
    expect(m.stderr).toMatch(/^tabcomputer: dpkg was interrupted/);
    expect(m.stderr).toMatch(/jq, libonig5/);
  });

  it('an install that fails part-way is recovered and retried once', async () => {
    let installs = 0;
    const { proc, kernel, calls, m } = machine({
      status: STATUS_OK,
      behave: (argv, m) => {
        if (argv.includes('-f')) { m.status = STATUS_OK; return 0; }
        if (argv.includes('jq') && ++installs === 1) { m.status = STATUS_BROKEN; return 100; } // unpack failed
        return 0;
      },
    });
    expect(await aptGuardProgram(proc, kernel)).toBe(0);
    expect(calls).toEqual(['/usr/bin/apt-get.debian install -y jq', '/usr/bin/apt-get.debian -f install -y', '/usr/bin/apt-get.debian install -y jq']);
    expect(m.stderr).toMatch(/trying once more/);
  });

  it('a clean failure (nothing left part-way) is not retried; read-only, simulated and non-root runs go straight through', async () => {
    const fail = machine({ status: STATUS_OK, behave: () => 100 });
    expect(await aptGuardProgram(fail.proc, fail.kernel)).toBe(100);
    expect(fail.calls).toHaveLength(1);
    for (const [argv, uid] of [[['update'], 0], [['install', '-s', 'jq'], 0], [['install', 'jq'], 1000]] as const) {
      const { proc, kernel, calls } = machine({ status: STATUS_BROKEN, updates: ['0001'], uid, behave: () => 0 });
      proc.argv = ['/usr/bin/shiro-apt', '/usr/bin/apt', ...argv];
      expect(await aptGuardProgram(proc, kernel)).toBe(0);
      expect(calls).toEqual([`/usr/bin/apt.debian ${argv.join(' ')}`]);
    }
  });
});
