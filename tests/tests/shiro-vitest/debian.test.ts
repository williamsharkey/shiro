/**
 * Debian mode (docs/DEBIAN.md): the streamed rootfs from public/debian,
 * Debian's own dynamically linked programs in Blink, the overlay, sudo.
 *
 * The apt end-to-end case needs the network (the mirror route of server.mjs
 * proxies deb.debian.org) and a few minutes: SHIRO_DEBIAN_NET=1 enables it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createTestShell, run } from './helpers';
import { rootfsStats } from '@shiro/debian/rootfs';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';

const ROOT = resolve(__dirname, '../../..');
const haveRootfs = existsSync(resolve(ROOT, 'public/debian/rootfs.json'));

describe.skipIf(!haveRootfs)('Debian rootfs', () => {
  let fs: FileSystem;
  let shell: Shell;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    const r = await run(shell, 'debian install');
    expect(r.exitCode).toBe(0);
  }, 60000);

  it('installs placeholders for every path without fetching file contents', async () => {
    const st = await fs.lstat('/usr/bin/dpkg');
    expect(st.isFile()).toBe(true);
    expect(st.size).toBeGreaterThan(100000);
    expect((await fs.lstat('/bin')).isSymbolicLink()).toBe(true);
    expect(await fs.readlink('/bin')).toBe('usr/bin');
    expect((await fs.readFile('/etc/debian_version', 'utf8') as string).trim()).toMatch(/^13\./);
    expect(rootfsStats.filesMaterialized).toBeGreaterThan(0);
  });

  it("runs Debian's dynamically linked programs (ld.so, glibc) in Blink", async () => {
    expect((await run(shell, '/usr/bin/bash -c \'echo "bash $BASH_VERSINFO"\'')).output).toMatch(/bash 5/);
    expect((await run(shell, 'dpkg --version')).output).toMatch(/Debian 'dpkg' package management program version 1\.22/);
    expect((await run(shell, "dpkg-query -W -f='${Status}\\n' coreutils")).output).toContain('install ok installed');
    // /bin is /usr/bin: one inode (dpkg and apt check merged-usr this way)
    const r = await run(shell, 'stat -c %i /bin/ /usr/bin/');
    const [a, b] = r.output.trim().split(/\s+/);
    expect(a).toBe(b);
  }, 120000);

  it("diverts apt's http method to Shiro's transport and keeps dpkg truthful", async () => {
    const list = (await run(shell, 'dpkg-divert --list')).output;
    expect(list).toContain('local diversion of /usr/lib/apt/methods/http to /usr/lib/apt/methods/http.debian');
    expect(await fs.readFile('/usr/lib/apt/methods/http', 'utf8')).toBe('#!/usr/bin/shiro-apt-method\n');
    expect((await fs.lstat('/usr/lib/apt/methods/http.debian')).size).toBeGreaterThan(100000);
    expect((await run(shell, 'shiro-alternatives --display /usr/lib/apt/methods/http')).output).toMatch(/shiro \(shiro-apt-method\)\s+\(auto, default shiro\)/);
  }, 60000);

  it('switches a program between Shiro and Debian with shiro-alternatives', async () => {
    expect((await run(shell, 'type -a env 2>&1; command -v env')).exitCode).toBe(0);
    let r = await run(shell, 'shiro-alternatives --set env shiro');
    expect(r.output).toContain("/usr/bin/env: now Shiro's");
    expect(await fs.exists('/usr/bin/env')).toBe(false);
    expect((await fs.lstat('/usr/bin/env.debian')).isFile()).toBe(true);
    expect((await run(shell, 'dpkg-divert --list /usr/bin/env')).output).toContain('local diversion of /usr/bin/env to /usr/bin/env.debian');
    r = await run(shell, 'shiro-alternatives --set env debian');
    expect(r.output).toContain("/usr/bin/env: now Debian's");
    expect((await fs.lstat('/usr/bin/env')).isFile()).toBe(true);
    expect((await run(shell, 'dpkg-divert --list /usr/bin/env')).output.trim()).toBe('');
  }, 120000);

  it('a PATH search in a Debian program finds an installed program, not a made-up /usr/local/bin file for the builtin', async () => {
    // As dpkg unpacks gcc: /usr/bin/gcc -> gcc-14 renamed into place before
    // gcc-14 (here with curl, a builtin of the test shell)
    const settle = () => new Promise((r) => setTimeout(r, 50));
    await fs.symlink('curl-8', '/usr/bin/curl.dpkg-new');
    await fs.rename('/usr/bin/curl.dpkg-new', '/usr/bin/curl');
    await settle();
    await fs.writeFile('/usr/bin/curl-8', '#!/bin/sh\necho "debian curl $*"\n', { mode: 0o755 });
    await settle();
    // bash, like GNU make, stats each PATH entry: Shiro's commands look like
    // files in the bin directories, but not one an installed program replaces
    // (make ran the made-up /usr/local/bin/cc and failed)
    expect((await run(shell, '/usr/bin/bash -c "type -P curl; type -P ls"')).output.replace(/\r\n/g, '\n')).toMatch(/^\/usr\/bin\/curl\n\/(usr\/)?(local\/)?bin\/ls\n$/);
    expect((await run(shell, '/usr/bin/bash -c "curl -V"')).output).toContain('debian curl -V');
    await fs.unlink('/usr/bin/curl');
    await fs.unlink('/usr/bin/curl-8');
  });

  it('sudo runs kernel programs as uid 0', async () => {
    expect((await run(shell, '/usr/bin/id -u')).output.trim()).toBe('1000');
    expect((await run(shell, 'sudo /usr/bin/id -u')).output.trim()).toBe('0');
    expect((await run(shell, 'sudo /usr/bin/id -g')).output.trim()).toBe('0');
  }, 60000);

  it('runs #!/bin/sh scripts under Debian\'s dash, and link() copies', async () => {
    await fs.writeFile('/tmp/s.sh', '#!/bin/sh\nreadlink /proc/$$/exe 2>/dev/null || echo nolink\necho "args: $*"\n', { mode: 0o755 });
    const r = await run(shell, '/usr/bin/env /tmp/s.sh a b');
    expect(r.output).toContain('args: a b');
    await fs.writeFile('/tmp/linksrc', 'hello');
    expect((await run(shell, '/usr/bin/ln /tmp/linksrc /tmp/linkdst && /usr/bin/cat /tmp/linkdst')).output).toContain('hello');
  }, 60000);

  it('keeps English man pages of packages installed later (dpkg path-include)', async () => {
    const cfg = await fs.readFile('/etc/dpkg/dpkg.cfg.d/90shiro-slim', 'utf8') as string;
    expect(cfg).toMatch(/path-exclude \/usr\/share\/man\/\*\npath-include \/usr\/share\/man\/man\[1-9\]\*\/\*\n/);
    expect(cfg).toContain('path-exclude /usr/share/doc/*');
    expect(await fs.exists('/etc/apt/apt.conf.d/91shiro-engine')).toBe(false);
    // Maintainer scripts don't start services (invoke-rc.d asks policy-rc.d)
    expect((await run(shell, '/usr/sbin/policy-rc.d ssh start; echo "rc=$?"')).output).toContain('rc=101');
  });

  it("a Debian program replaces the builtin of its name, for type too; commands wait for the boot gate", async () => {
    expect(shell.commands.get('jq')).toBeTruthy();
    await fs.writeFile('/usr/bin/jq', '#!/bin/sh\necho debian-jq\n', { mode: 0o755 });
    await new Promise((r) => setTimeout(r, 50)); // the overlay hears the write
    expect((await run(shell, 'type jq')).output).toContain('/usr/bin/jq');
    expect((await run(shell, 'jq')).output).toContain('debian-jq');
    await fs.unlink('/usr/bin/jq');
    // A command typed before the overlay is up waits for it (python3 right after load)
    let release!: () => void;
    const order: string[] = [];
    shell.bootGate = new Promise<void>((r) => { release = r; }).then(() => { order.push('boot'); });
    const pending = run(shell, 'echo cmd').then((r) => { order.push('cmd'); return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    expect((await pending).output).toContain('cmd');
    expect(order).toEqual(['boot', 'cmd']);
  }, 60000);

  it("bash's PATH search finds builtins and Debian's programs (no phantom /usr/local/sbin/NAME)", async () => {
    // id: Debian's file in /usr/bin; tail: diverted to Shiro's (no file); /usr/local/sbin comes first
    const r = await run(shell, `sudo /usr/bin/bash -c 'type -p id tail; id -u; printf "a\\nb\\n" | tail -1'`);
    expect(r.output).not.toContain('/usr/local/');
    expect(r.output).toMatch(/^0$/m);
    expect(r.output).toMatch(/^b$/m);
  }, 60000);

  it('runs an executable without #! under /bin/sh, as execvp does (an empty debconf config)', async () => {
    await fs.writeFile('/tmp/empty.cfg', '', { mode: 0o755 });
    await fs.writeFile('/tmp/nosb.cfg', 'echo "nosb $1 [$2]"\n', { mode: 0o755 });
    // debconf's open2: the child's stdin is a pipe the parent keeps open while it reads
    const perl = `/usr/bin/perl -e 'use IPC::Open2; for my $f ("/tmp/empty.cfg", "/tmp/nosb.cfg") { my $p = open2(my $o, my $i, $f, "configure", ""); my @l = <$o>; waitpid $p, 0; print "$f: @l status=$?\\n" }'`;
    const r = await run(shell, `/usr/bin/timeout 60 ${perl}`);
    expect(r.output).toContain('/tmp/empty.cfg:  status=0');
    expect(r.output).toContain('/tmp/nosb.cfg: nosb configure []');
  }, 120000);
});

const net = process.env.SHIRO_DEBIAN_NET === '1';

describe.skipIf(!haveRootfs || !net)('Debian apt end to end (SHIRO_DEBIAN_NET=1)', () => {
  let srv: ChildProcess;
  const PORT = 5393;
  beforeAll(async () => {
    srv = spawn('node', ['server.mjs'], {
      cwd: ROOT, stdio: 'ignore',
      env: { ...process.env, PORT: String(PORT), STATIC_DIR: resolve(ROOT, 'public'), SHIRO_DEBIAN_CACHE: resolve(ROOT, '.debian-build/mirror-cache') },
    });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    process.env.SHIRO_DEBIAN_MIRROR = `http://127.0.0.1:${PORT}/debian/mirror/`;
  });
  afterAll(() => { srv?.kill(); delete process.env.SHIRO_DEBIAN_MIRROR; });

  it('sudo apt update && sudo apt install hello jq', async () => {
    const { shell } = await createTestShell();
    expect((await run(shell, 'debian install')).exitCode).toBe(0);
    const upd = await run(shell, 'sudo apt-get update 2>&1');
    expect(upd.output).toMatch(/Get:\d+ http:\/\/deb\.debian\.org\/debian trixie\/main amd64 Packages/);
    expect(upd.exitCode).toBe(0);
    const inst = await run(shell, 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y hello jq 2>&1');
    expect(inst.output).toContain('Setting up hello');
    expect(inst.exitCode).toBe(0);
    expect((await run(shell, 'hello')).output).toContain('Hello, world!');
    expect((await run(shell, `echo '{"a":[1,2]}' | /usr/bin/jq -c .a`)).output.trim()).toBe('[1,2]');
    expect((await run(shell, "dpkg-query -W -f='${Status}' hello")).output).toBe('install ok installed');
  }, 1800000);
});
