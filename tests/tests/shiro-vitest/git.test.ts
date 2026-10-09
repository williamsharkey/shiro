import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { Shell } from '@shiro/shell';
import { CommandRegistry } from '@shiro/commands/index';
import { gitCmd } from '@shiro/commands/git';
import { createTestShell } from './helpers';

describe('git commands', () => {
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
});
