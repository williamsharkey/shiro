import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { DEFAULT_MIRROR } from '@shiro/pkg-manager';
import { FileSystem } from '@shiro/filesystem';
import { Shell } from '@shiro/shell';
import { CommandRegistry } from '@shiro/commands/index';
import { gitCmd } from '@shiro/commands/git';
import { createTestShell, run } from './helpers';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

describe('git commands', () => {
  // These cover the built-in git on its own: keep the package mirror
  // unreachable so commands it hands to the full git package don't fetch it.
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).startsWith(DEFAULT_MIRROR + '/pkg/')) throw new TypeError('fetch failed (offline in this test)');
      return realFetch(input, init);
    }) as typeof fetch;
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  let fs: FileSystem;
  let shell: Shell;
  let commands: CommandRegistry;

  beforeEach(async () => {
    fs = new FileSystem();
    await fs.init();
    commands = new CommandRegistry();
    commands.register(gitCmd);
    shell = new Shell(fs, commands);
  });

  it('should initialize a git repository in current directory', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await shell.execute('git init', (s) => { stdout += s; }, (e) => { stderr += e; });

    expect(stderr).toBe('');
    expect(stdout).toContain('Initialized empty Git repository');
    expect(exitCode).toBe(0);

    const gitExists = await fs.exists('/home/user/.git');
    expect(gitExists).toBe(true);

    const configExists = await fs.exists('/home/user/.git/config');
    expect(configExists).toBe(true);
  });

  it('should initialize a git repository in specified directory', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await shell.execute('git init test-repo', (s) => { stdout += s; }, (e) => { stderr += e; });

    expect(stderr).toBe('');
    expect(stdout).toContain('Initialized empty Git repository');
    expect(exitCode).toBe(0);

    const repoExists = await fs.exists('/home/user/test-repo');
    expect(repoExists).toBe(true);

    const gitExists = await fs.exists('/home/user/test-repo/.git');
    expect(gitExists).toBe(true);

    const configExists = await fs.exists('/home/user/test-repo/.git/config');
    expect(configExists).toBe(true);
  });

  it('should support git remote set-url', async () => {
    let stdout = '';
    let stderr = '';

    // Init repo in default cwd
    await shell.execute('git init', (s) => { stdout += s; }, (e) => { stderr += e; });
    expect(stderr).toBe('');

    // Add a remote
    stdout = ''; stderr = '';
    await shell.execute('git remote add origin https://github.com/old/repo.git', (s) => { stdout += s; }, (e) => { stderr += e; });
    expect(stderr).toBe('');

    // Verify remote exists
    stdout = ''; stderr = '';
    await shell.execute('git remote -v', (s) => { stdout += s; }, (e) => { stderr += e; });
    expect(stdout).toContain('https://github.com/old/repo.git');

    // Set new URL
    stdout = ''; stderr = '';
    const exitCode = await shell.execute('git remote set-url origin https://github.com/new/repo.git', (s) => { stdout += s; }, (e) => { stderr += e; });
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    // Verify URL changed
    stdout = ''; stderr = '';
    await shell.execute('git remote -v', (s) => { stdout += s; }, (e) => { stderr += e; });
    expect(stdout).toContain('https://github.com/new/repo.git');
    expect(stdout).not.toContain('https://github.com/old/repo.git');
  });

  const sh = async (cmd: string) => {
    let out = '', err = '';
    if (!full) ({ fs, shell } = full = await createTestShell());
    const code = await shell.execute(cmd, (s) => { out += s; }, (e) => { err += e; });
    return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
  };

  let full: { fs: FileSystem; shell: Shell } | null = null;
  beforeEach(() => { full = null; });

  it('outside a repository: "not a git repository", not a crash', async () => {
    await sh('true');
    await fs.mkdir('/tmp/norepo', { recursive: true });
    const r = await sh('cd /tmp/norepo && git commit -m x');
    expect(r.code).toBe(128);
    expect(r.err).toContain('fatal: not a git repository');
  });

  it('works from a subdirectory: the repository is the nearest .git up, paths are relative to here', async () => {
    await sh('true');
    await sh('mkdir -p /tmp/repo/src && cd /tmp/repo && git init -q && git config user.name a && git config user.email a@b');
    await fs.writeFile('/tmp/repo/src/a.txt', 'a');
    await fs.writeFile('/tmp/repo/top.txt', 't');
    const r = await sh('cd /tmp/repo/src && git add a.txt && git commit -m "from src" && git log --oneline');
    expect(r.code).toBe(0);
    expect(r.out).toContain('from src');
    const st = await sh('cd /tmp/repo/src && git status');
    expect(st.out).toContain('top.txt'); // still untracked: only src/a.txt was added
  });

  it('clone refuses a non-empty destination and leaves nothing behind when it fails', async () => {
    await sh('true');
    await fs.mkdir('/tmp/c/full', { recursive: true });
    await fs.writeFile('/tmp/c/full/x', 'x');
    const r = await sh('cd /tmp/c && git clone https://example.invalid/r.git full');
    expect(r.code).toBe(128);
    expect(r.err).toContain("destination path 'full' already exists and is not an empty directory");
    const g = await sh('cd /tmp/c && GIT_CORS_PROXY=http://127.0.0.1:9/nope git clone https://example.invalid/gone.git');
    expect(g.code).toBe(128);
    expect(g.err).toContain("Cloning into 'gone'");
    expect(await fs.exists('/tmp/c/gone')).toBe(false);
  });

  describe('plumbing that git UIs (tig, lazygit) and agents call', () => {
    const setup = async () => {
      await sh('rm -rf /tmp/p && mkdir -p /tmp/p/sub && cd /tmp/p && git init -q && git config user.name Ann && git config user.email ann@x.org'
        + ' && echo one > a.txt && echo s > sub/s.txt && git add . && git commit -q -m first'
        + ' && git checkout -q -b feat && echo two >> a.txt && git commit -qam second && git checkout -q main');
      return (await sh('cd /tmp/p && git rev-parse HEAD feat')).out.trim().split('\n');
    };

    it('rev-parse', async () => {
      const [main, feat] = await setup();
      expect(main).toMatch(/^[0-9a-f]{40}$/);
      expect(feat).toMatch(/^[0-9a-f]{40}$/);
      expect((await sh('cd /tmp/p/sub && git rev-parse --show-toplevel --git-dir --is-inside-work-tree --show-cdup --show-prefix')).out)
        .toBe('/tmp/p\n/tmp/p/.git\ntrue\n../\nsub/\n');
      expect((await sh('cd /tmp/p && git rev-parse --git-dir')).out).toBe('.git\n');
      expect((await sh('cd /tmp/p && git rev-parse --abbrev-ref HEAD')).out).toBe('main\n');
      expect((await sh('cd /tmp/p && git rev-parse --symbolic-full-name HEAD')).out).toBe('refs/heads/main\n');
      expect((await sh('cd /tmp/p && git rev-parse --verify feat~1')).out).toBe(main + '\n');
      expect((await sh('cd /tmp/p && git rev-parse --short HEAD')).out).toBe(main.slice(0, 7) + '\n');
      const bad = await sh('cd /tmp/p && git rev-parse --verify --quiet nope');
      expect([bad.code, bad.out, bad.err]).toEqual([1, '', '']);
      const up = await sh('cd /tmp/p && git rev-parse --symbolic-full-name main@{u}');
      expect(up.code).toBe(128);
      expect(up.err).toContain("no upstream configured for branch 'main'");
    });

    it('status --porcelain v1/v2, -z, -b', async () => {
      await setup();
      await sh('cd /tmp/p && echo x >> a.txt && echo n > new.txt && echo st > sub/st.txt && git add sub/st.txt');
      expect((await sh('cd /tmp/p && git status --porcelain')).out).toBe(' M a.txt\n?? new.txt\nA  sub/st.txt\n');
      expect((await sh('cd /tmp/p && git status --porcelain=v1 -z')).out).toBe(' M a.txt\0?? new.txt\0A  sub/st.txt\0');
      expect((await sh('cd /tmp/p && git status -sb')).out.split('\n')[0]).toBe('## main');
      const v2 = (await sh('cd /tmp/p && git status --porcelain=v2 --branch')).out;
      expect(v2).toMatch(/^# branch\.oid [0-9a-f]{40}\n# branch\.head main\n/);
      expect(v2).toMatch(/\n1 \.M N\.\.\. 100644 100644 100644 [0-9a-f]{40} [0-9a-f]{40} a\.txt\n/);
      expect(v2).toMatch(/\n1 A\. N\.\.\. 000000 100644 100644 0{40} [0-9a-f]{40} sub\/st\.txt\n/);
      expect(v2).toContain('\n? new.txt\n');
    });

    it('log and show formats, -z, decorations', async () => {
      const [main, feat] = await setup();
      const log = (await sh("cd /tmp/p && git log --format='%H|%h|%s|%an|%ae|%P' feat")).out.split('\n');
      expect(log[0]).toBe(`${feat}|${feat.slice(0, 7)}|second|Ann|ann@x.org|${main}`);
      expect(log[1]).toBe(`${main}|${main.slice(0, 7)}|first|Ann|ann@x.org|`);
      expect((await sh("cd /tmp/p && git log --format=%ad -1")).out).toMatch(/^\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d \d{4} [+-]\d{4}\n$/);
      expect((await sh("cd /tmp/p && git log -z --format=%s --all")).out).toBe('second\0first\0');
      expect((await sh('cd /tmp/p && git log --oneline --decorate --all')).out)
        .toBe(`${feat.slice(0, 7)} (feat) second\n${main.slice(0, 7)} (HEAD -> main) first\n`);
      expect((await sh('cd /tmp/p && git log --format=%s main..feat')).out).toBe('second\n');
      expect((await sh('cd /tmp/p && git show --name-status --format=%s feat')).out).toBe('second\n\nM\ta.txt\n');
      expect((await sh('cd /tmp/p && git log -g')).out).toBe(''); // no reflog kept
    });

    it('diff: patch, --cached, --name-status, --numstat, --stat, --quiet', async () => {
      await setup();
      await sh('cd /tmp/p && echo x >> a.txt && echo n > new.txt && echo st > sub/st.txt && git add sub/st.txt');
      expect((await sh('cd /tmp/p && git diff --name-status')).out).toBe('M\ta.txt\n'); // not the untracked file
      expect((await sh('cd /tmp/p && git diff --numstat')).out).toBe('1\t0\ta.txt\n');
      expect((await sh('cd /tmp/p && git diff --cached --name-only')).out).toBe('sub/st.txt\n');
      expect((await sh('cd /tmp/p && git diff --stat main feat')).out).toBe(' a.txt | 1 +\n 1 file changed, 1 insertion(+)\n'.replace('| 1', '|   1'));
      const patch = (await sh('cd /tmp/p && git diff --no-ext-diff --color=always -- a.txt')).out;
      expect(patch).toMatch(/^diff --git a\/a\.txt b\/a\.txt\nindex [0-9a-f]{7}\.\.[0-9a-f]{7} 100644\n--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1 \+1,2 @@\n one\n\+x\n$/);
      expect((await sh('cd /tmp/p && git diff --cached -- sub/st.txt')).out).toContain('new file mode 100644\nindex 0000000..');
      expect((await sh('cd /tmp/p && git diff --quiet')).code).toBe(1);
    });

    it('diff-files, diff-index, update-index, ls-files --others (tig status and stage views)', async () => {
      const [main] = await setup();
      await sh('cd /tmp/p && echo x >> a.txt && echo n > new.txt');
      expect((await sh('cd /tmp/p && git diff-files')).out).toMatch(/^:100644 100644 [0-9a-f]{40} 0{40} M\ta\.txt\n$/);
      expect((await sh('cd /tmp/p && git diff-files -z')).out).toMatch(/^:100644 100644 [0-9a-f]{40} 0{40} M\0a\.txt\0$/);
      expect((await sh('cd /tmp/p && git diff-files --patch-with-stat')).out).toMatch(/^ a\.txt \|\s+1 \+\n 1 file changed, 1 insertion\(\+\)\n\ndiff --git a\/a\.txt b\/a\.txt\n/);
      expect((await sh('cd /tmp/p && git ls-files -z --others --exclude-standard')).out).toBe('new.txt\0');
      expect((await sh('cd /tmp/p && git diff-index --cached HEAD')).out).toBe('');
      await sh('cd /tmp/p && printf "a.txt\\0new.txt\\0" | git update-index --add --remove -z --stdin');
      expect((await sh(`cd /tmp/p && git diff-index --cached --name-status ${main}`)).out).toBe('M\ta.txt\nA\tnew.txt\n');
      await sh('cd /tmp/p && rm new.txt && git update-index --remove -- new.txt');
      expect((await sh('cd /tmp/p && git diff-index --cached --name-only HEAD')).out).toBe('a.txt\n');
    });

    it('for-each-ref, show-ref, symbolic-ref, branch -vv, cat-file, ls-files, worktree, merge-base, rev-list', async () => {
      const [main, feat] = await setup();
      expect((await sh("cd /tmp/p && git for-each-ref --format='%(HEAD)%(refname:short) %(objectname:short) %(subject)' refs/heads")).out)
        .toBe(` feat ${feat.slice(0, 7)} second\n*main ${main.slice(0, 7)} first\n`);
      expect((await sh('cd /tmp/p && git show-ref')).out).toBe(`${feat} refs/heads/feat\n${main} refs/heads/main\n`);
      expect((await sh('cd /tmp/p && git symbolic-ref --short HEAD')).out).toBe('main\n');
      expect((await sh('cd /tmp/p && git branch -vv')).out).toBe(`  feat ${feat.slice(0, 7)} second\n* main ${main.slice(0, 7)} first\n`);
      expect((await sh('cd /tmp/p && git branch --show-current')).out).toBe('main\n');
      expect((await sh('cd /tmp/p && git cat-file -t HEAD')).out).toBe('commit\n');
      expect((await sh('cd /tmp/p && git cat-file -p feat:a.txt')).out).toBe('one\ntwo\n');
      expect((await sh('cd /tmp/p && git cat-file -p HEAD')).out).toMatch(/^tree [0-9a-f]{40}\nauthor Ann <ann@x\.org> \d+ [+-]\d{4}\ncommitter .*\n\nfirst\n$/);
      expect((await sh('cd /tmp/p && git ls-files')).out).toBe('a.txt\nsub/s.txt\n');
      expect((await sh('cd /tmp/p/sub && git ls-files')).out).toBe('s.txt\n');
      expect((await sh('cd /tmp/p && git worktree list --porcelain')).out).toBe(`worktree /tmp/p\nHEAD ${main}\nbranch refs/heads/main\n\n`);
      expect((await sh('cd /tmp/p && git merge-base main feat')).out).toBe(main + '\n');
      expect((await sh('cd /tmp/p && git rev-list --left-right --count main...feat')).out).toBe('0\t1\n');
    });

    it('config --get/--list/--get-regexp/-z, global options, commit -am, checkout -q -b, stash list formats', async () => {
      await setup();
      expect((await sh('cd /tmp/p/sub && git config --get user.name')).out).toBe('Ann\n');
      expect((await sh("cd /tmp/p/sub && git config --get-regexp '^user\\.'")).out).toBe('user.email ann@x.org\nuser.name Ann\n');
      expect((await sh('cd /tmp/p && git config --get --null user.name')).out).toBe('Ann\0');
      expect((await sh('cd /tmp/p && git config --list')).out).toContain('user.name=Ann\n');
      const missing = await sh('cd /tmp/p && git config --get no.such');
      expect([missing.code, missing.out]).toEqual([1, '']);
      expect((await sh('cd / && git -C /tmp/p -c color.ui=never --no-pager --no-optional-locks config --get color.ui')).out).toBe('never\n');
      expect((await sh('cd / && git --no-pager -C /tmp/p rev-parse --abbrev-ref HEAD')).out).toBe('main\n');
      const c = await sh('cd /tmp/p && git checkout -q -b topic && echo t >> a.txt && git rm -q sub/s.txt 2>/dev/null; rm -f sub/s.txt; git commit -qam "topic work" && git log --format=%s -1 && git show --name-status --format= HEAD');
      expect(c.out).toBe('topic work\nM\ta.txt\nD\tsub/s.txt\n');
      expect((await sh('cd /tmp/p && git rev-parse --abbrev-ref HEAD')).out).toBe('topic\n');
      await sh('cd /tmp/p && echo dirty >> a.txt && git stash -q && git stash push -q -m mine && echo d2 >> a.txt && git stash -q -m mine');
      const list = (await sh('cd /tmp/p && git stash list')).out;
      expect(list).toMatch(/^stash@\{0\}: On topic: mine\nstash@\{1\}: WIP on topic: [0-9a-f]{7} topic work\n$/);
      expect((await sh("cd /tmp/p && git stash list -z --pretty='%gd|%gs'")).out).toMatch(/^stash@\{0\}\|On topic: mine\0stash@\{1\}\|WIP on topic: [0-9a-f]{7} topic work\0$/);
      expect((await sh('cd /tmp/p && git rev-parse --abbrev-ref HEAD && git stash pop -q && git status --porcelain')).out).toBe('topic\n M a.txt\n');
    });
  });
  describe('options as git takes them (tabcomputer#4)', () => {
    const setup = async () => {
      await sh('rm -rf /tmp/o && mkdir -p /tmp/o && cd /tmp/o && git init -q && git config user.name A && git config user.email a@b.c && echo 1 > f && git add f');
    };

    it('combined short options: commit -qm, checkout -qb creates and switches', async () => {
      await setup();
      const c = await sh('cd /tmp/o && git commit -qm init');
      expect([c.code, c.out, c.err]).toEqual([0, '', '']);
      const b = await sh('cd /tmp/o && git checkout -qb feat && git rev-parse --abbrev-ref HEAD');
      expect(b.out).toBe('feat\n');
      await sh('cd /tmp/o && echo 2 >> f && git commit -qam two');
      expect((await sh('cd /tmp/o && git log --format=%s main')).out).toBe('init\n'); // not on main
      expect((await sh('cd /tmp/o && git log --format=%s feat')).out).toBe('two\ninit\n');
    });

    it('merge --no-ff -m, the work tree follows; log --graph', async () => {
      await setup();
      await sh('cd /tmp/o && git commit -qm init && git checkout -qb feat && echo 2 >> f && git commit -qam two && git checkout -q main && echo h > h && git add h && git commit -qm h');
      const m = await sh('cd /tmp/o && git merge --no-ff feat -m merged');
      expect(m.code).toBe(0);
      expect(await fs.readFile('/tmp/o/f', 'utf8')).toBe('1\n2\n');
      expect((await sh('cd /tmp/o && git status --porcelain')).out).toBe('');
      expect((await sh('cd /tmp/o && git log --graph --format=%s')).out).toBe('*   merged\n|\\  \n| * two\n* | h\n|/  \n* init\n');
      const ff = await sh('cd /tmp/o && git checkout -qb ff && echo 3 >> f && git commit -qam three && git checkout -q main && git merge -q --ff-only ff');
      expect([ff.code, ff.out]).toEqual([0, '']);
      expect((await sh('cd /tmp/o && git log --format=%s -1')).out).toBe('three\n');
    });

    it('rebase -q (the built-in without the full git)', async () => {
      await setup();
      await sh('cd /tmp/o && git commit -qm init && git checkout -qb feat && echo 2 > g && git add g && git commit -qm two && git checkout -q main && echo h > h && git add h && git commit -qm h && git checkout -q feat');
      const r = await sh('cd /tmp/o && git rebase -q main');
      expect([r.code, r.out]).toEqual([0, '']);
      expect((await sh('cd /tmp/o && git log --format=%s')).out).toBe('two\nh\ninit\n');
    });

    it('rebase goes to the full git package once it can be installed (a local stand-in for the package)', async () => {
      await setup();
      await sh('cd /tmp/o && git commit -qm init');
      // `pkg install git` puts the full git at /usr/bin/git: here a script that says how it was called
      const installs: string[] = [];
      const pkgBefore = shell.commands.get('pkg');
      try {
        shell.commands.register({
          name: 'pkg', description: 'stand-in',
          async exec(ctx) {
            installs.push(ctx.args.join(' '));
            if (ctx.args[0] !== 'install' || ctx.args[1] !== 'git') return 1;
            await ctx.fs.mkdir('/usr/bin', { recursive: true });
            await ctx.fs.writeFile('/usr/bin/git', '#!/bin/sh\necho "full git in $(pwd): $*"\n', { mode: 0o755 });
            return 0;
          },
        });
        const r = await sh('cd /tmp/o && git rebase -q main');
        expect(installs).toEqual(['install git']);
        expect(r.out).toBe('full git in /tmp/o: rebase -q main\n');
        expect(r.err).toContain('installed the full git');
        // installed: used straight away the next time, without installing again
        const again = await sh('cd /tmp/o && git cherry-pick abc');
        expect(installs).toEqual(['install git']);
        expect(again.out).toBe('full git in /tmp/o: cherry-pick abc\n');
      } finally {
        // (the next tests use the built-in alone again)
        await fs.unlink('/usr/bin/git').catch(() => {});
        shell.commands.register(pkgBefore ?? { name: 'pkg', description: 'offline', exec: async () => 1 });
      }
    });

    it('unknown options and subcommands are errors, not ignored', async () => {
      await setup();
      const u = await sh('cd /tmp/o && git commit --bogus -m x');
      expect(u.code).toBe(129);
      expect(u.err).toContain("error: unknown option `bogus'");
      const s = await sh('cd /tmp/o && git commit -Z -m x');
      expect(s.code).toBe(129);
      expect(s.err).toContain("error: unknown switch `Z'");
      expect((await sh('cd /tmp/o && git log --format=%s')).out).toBe(''); // nothing committed
      const b = await sh('cd /tmp/o && git blame f');
      expect(b.code).toBe(1);
      expect(b.err).toContain("git: 'blame' is not a git command");
      expect(b.err).toContain('pkg install git');
      const r = await sh('cd /tmp/o && git remote show origin');
      expect(r.code).toBe(129);
      const f = await sh('cd /tmp/o && git fetch -q origin');
      expect(f.code).toBe(128);
      expect(f.err).toContain("'origin' does not appear to be a git repository");
      const h = await sh('cd /tmp/o && git cherry-pick --help');
      expect(h.code).toBe(0);
      expect(h.out).toMatch(/^usage: git cherry-pick/);
    });

    it('ls-remote URL outside a repository', async () => {
      await sh('true');
      await fs.mkdir('/tmp/nr', { recursive: true });
      const r = await sh('cd /tmp/nr && GIT_CORS_PROXY=http://127.0.0.1:9/nope git ls-remote https://example.invalid/r.git');
      expect(r.code).toBe(128);
      expect(r.err).toContain("fatal: unable to access 'https://example.invalid/r.git'");
      expect(r.err).not.toContain('not a git repository');
    });
  });
});

describe('git object cache', () => {
  it('git log over a packed history reads the pack once, not once per commit', async () => {
    const { shell, fs } = await createTestShell();
    const git = (await import('isomorphic-git')).default;
    const dir = '/tmp/packlog';
    await run(shell, `rm -rf ${dir}; mkdir -p ${dir} && cd ${dir} && git init -q`);
    for (let i = 0; i < 12; i++) await run(shell, `cd ${dir} && echo ${i} > f.txt && git add f.txt && git commit -q -m c${i}`);
    // pack every object, then drop the loose ones
    const ifs = fs.toIsomorphicGitFS();
    const oids: string[] = [];
    for (const d of await fs.readdir(`${dir}/.git/objects`)) {
      if (d.length !== 2) continue;
      for (const f of await fs.readdir(`${dir}/.git/objects/${d}`)) oids.push(d + f);
    }
    const { filename } = await git.packObjects({ fs: ifs, dir, oids, write: true });
    await git.indexPack({ fs: ifs, dir, filepath: `.git/objects/pack/${filename}` });
    for (const oid of oids) await fs.unlink(`${dir}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
    const read = fs.readFile.bind(fs);
    let packReads = 0;
    fs.readFile = ((p: string, ...rest: any[]) => { if (String(p).endsWith('.pack')) packReads++; return (read as any)(p, ...rest); }) as any;
    try {
      const r = await run(shell, `cd ${dir} && git log --oneline`);
      expect(r.output.trim().split('\n')).toHaveLength(12);
      expect(r.output).toContain('c0');
    } finally {
      fs.readFile = read;
    }
    expect(packReads).toBe(1);
  });
});

// With the full git installed, `git clone` of an http(s) URL is still the built-in's,
// with the full git's defaults (git.ts builtinCloneHandles). The remote: a bare repository
// served by this machine's git (`git http-backend`), skipped without one.
const hostGit = (() => { try { nodeRequire('node:child_process').execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!hostGit)('git clone with the full git installed', () => {
  it('clones like the full git (all branches, tags, origin/HEAD, tracking), hands the rest to it, and falls back to it', async () => {
    const { execFileSync, spawn } = nodeRequire('node:child_process') as typeof import('node:child_process');
    const { mkdtempSync, writeFileSync, rmSync } = nodeRequire('node:fs') as typeof import('node:fs');
    const { tmpdir } = nodeRequire('node:os') as typeof import('node:os');
    const { join } = nodeRequire('node:path') as typeof import('node:path');
    const { createServer } = nodeRequire('node:http') as typeof import('node:http');
    const iso = (await import('isomorphic-git')).default;
    const root = mkdtempSync(join(tmpdir(), 'shiro-clone-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
    const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
    const work = join(root, 'work');
    execFileSync('mkdir', ['-p', work]);
    g(work, 'init', '-q', '-b', 'main');
    for (let i = 0; i < 3; i++) { writeFileSync(join(work, 'f.txt'), `rev ${i}\n`); g(work, 'add', '.'); g(work, 'commit', '-qm', `c${i}`); }
    g(work, 'tag', 'v1');
    g(work, 'checkout', '-qb', 'dev'); writeFileSync(join(work, 'd.txt'), 'dev\n'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'dev');
    g(work, 'checkout', '-q', 'main');
    g(root, 'clone', '-q', '--bare', work, 'repo.git');
    const server = createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      const cgi = spawn('git', ['http-backend'], { env: { ...env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname.replace(/^\/[^/]+/, ''), REQUEST_METHOD: req.method!, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '' } });
      req.pipe(cgi.stdin);
      let head = Buffer.alloc(0), sent = false;
      cgi.stdout.on('data', (d: Buffer) => {
        if (sent) { res.write(d); return; }
        head = Buffer.concat([head, d]);
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) return;
        const hdrs: Record<string, string> = {}; let status = 200;
        for (const l of head.subarray(0, i).toString().split('\r\n')) { const [k, ...v] = l.split(':'); if (k.toLowerCase() === 'status') status = parseInt(v.join(':')); else hdrs[k] = v.join(':').trim(); }
        res.writeHead(status, hdrs); sent = true; res.write(head.subarray(i + 4));
      });
      cgi.stdout.on('end', () => res.end());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const proxy = `GIT_CORS_PROXY=http://127.0.0.1:${(server.address() as any).port}`;

    const { shell, fs } = await createTestShell();
    // the full git: a script that says how it was called; `git` is now the package's
    await fs.mkdir('/usr/bin', { recursive: true });
    await fs.writeFile('/usr/bin/git', '#!/bin/sh\necho "full git: $*"\n', { mode: 0o755 });
    const { extraShadows } = await import('@shiro/pkg-manager');
    extraShadows.set(fs, new Set(['git']));
    try {
      await fs.mkdir('/tmp/cl', { recursive: true });
      const r = await run(shell, `cd /tmp/cl && ${proxy} git clone http://example.test/repo.git r`);
      expect(r.output).not.toContain('full git:');
      expect(r.exitCode).toBe(0);
      const ifs = fs.toIsomorphicGitFS(), dir = '/tmp/cl/r';
      expect((await iso.log({ fs: ifs, dir })).map((c) => c.commit.message.trim())).toEqual(['c2', 'c1', 'c0']); // all history
      expect(await iso.currentBranch({ fs: ifs, dir })).toBe('main');
      expect((await iso.listBranches({ fs: ifs, dir, remote: 'origin' })).sort()).toEqual(['HEAD', 'dev', 'main']);
      expect(await iso.listTags({ fs: ifs, dir })).toEqual(['v1']);
      const config = await fs.readFile('/tmp/cl/r/.git/config', 'utf8') as string;
      expect(config).toMatch(/\[remote "origin"\][^[]*fetch = \+refs\/heads\/\*:refs\/remotes\/origin\/\*/);
      const branchMain = /\[branch "main"\]([^[]*)/.exec(config)?.[1] ?? '';
      expect(branchMain).toMatch(/remote = origin/);
      expect(branchMain).toMatch(/merge = refs\/heads\/main/);
      expect(await fs.readFile('/tmp/cl/r/f.txt', 'utf8')).toBe('rev 2\n');
      // everything else is the full git's
      expect((await run(shell, 'cd /tmp/cl/r && git status')).output).toContain('full git: status');
      expect((await run(shell, `cd /tmp/cl && ${proxy} git clone --bare http://example.test/repo.git b`)).output).toContain('full git: clone --bare');
      // --depth: shallow and one branch, as git
      await run(shell, `cd /tmp/cl && ${proxy} git clone -q --depth 1 http://example.test/repo.git s`);
      expect((await iso.log({ fs: ifs, dir: '/tmp/cl/s' })).length).toBe(1);
      expect(await iso.listBranches({ fs: ifs, dir: '/tmp/cl/s', remote: 'origin' })).not.toContain('dev');
      // a clone the built-in can't do goes to the full git, and leaves nothing of its own behind
      const f = await run(shell, 'cd /tmp/cl && GIT_CORS_PROXY=http://127.0.0.1:9/nope git clone http://example.test/repo.git n');
      expect(f.output).toContain('full git: clone http://example.test/repo.git n');
      expect(await fs.exists('/tmp/cl/n')).toBe(false);
    } finally {
      extraShadows.delete(fs);
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('builtinCloneHandles', () => {
  it('takes http(s) clones with the options the built-in has, and its lazy stub carries it', async () => {
    const { builtinCloneHandles } = await import('@shiro/commands/git-clone-route');
    const { lazyCommand } = await import('@shiro/utils/lazy-command');
    for (const a of ['clone https://h/r.git', 'clone -q --depth 1 -b dev http://h/r.git dir', 'clone --origin=up --no-tags --single-branch https://h/r']) {
      expect(builtinCloneHandles(a.split(' '))).toBe(true);
    }
    for (const a of ['clone --bare https://h/r.git', 'clone --recurse-submodules https://h/r', 'clone git://h/r.git', 'clone ssh://h/r.git',
      'clone /tmp/r', 'clone file:///tmp/r', 'clone --filter=blob:none https://h/r', 'clone https://h/r a b', 'clone --depth', 'status']) {
      expect(builtinCloneHandles(a.split(' '))).toBe(false);
    }
    expect(lazyCommand('git', '', async () => { throw new Error('not loaded'); }, { keepOverPackage: builtinCloneHandles }).keepOverPackage).toBe(builtinCloneHandles);
  });
});
