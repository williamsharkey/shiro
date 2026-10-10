/**
 * Developer tools on the desktop (docs/DESKTOP.md "Developer tools", "Git"):
 * the Developer and AI agents catalog and its install-on-first-use scripts,
 * the clone and branch-folder commands, and the git state Files and the Git
 * app read (on a real repository made by the builtin git).
 */
import { describe, expect, it } from 'vitest';
import { DEV_GROUPS, DEV_TOOLS, launchScript, shq } from '@shiro/desktop/devtools';
import { glyphFor } from '@shiro/desktop/iconsets';
import { branchFolder, dirStatus, findRepo, headBranch, parseRepoSpec, upstreamOf, validBranch } from '@shiro/desktop/gitstatus';
import { cloneScript, mainRoot, worktreeScript } from '@shiro/desktop/gitsheets';
import { kindsOf } from '@shiro/desktop/apps/git';
import { createTestShell, run } from './helpers';

describe('Developer and AI agents stacks', () => {
  it('lists the tools from the research, each with a glyph', () => {
    expect(DEV_TOOLS.filter(t => t.group === 'developer').map(t => t.id)).toEqual(['nano', 'vim', 'code', 'git', 'neovim', 'emacs', 'geany', 'tmux']);
    expect(DEV_TOOLS.filter(t => t.group === 'agents').map(t => t.id)).toEqual(['claude', 'gemini', 'codex', 'grok', 'agy', 'aider']);
    for (const t of DEV_TOOLS) expect(glyphFor(t.id), t.id).toMatch(/^M/);
    for (const g of DEV_GROUPS) for (const id of g.loose) expect(DEV_TOOLS.some(t => t.id === id && t.group === g.id), id).toBe(true);
  });

  it('installs on first use: checks PATH, says what and how long, then runs it', () => {
    const neovim = DEV_TOOLS.find(t => t.id === 'neovim')!;
    const s = launchScript(neovim);
    expect(s).toMatch(/^if ! command -v nvim >\/dev\/null 2>&1; then /);
    expect(s).toContain("'Neovim isn'\\''t installed yet: pkg install neovim (about 2 s, first start 7 s)'");
    expect(s).toContain('pkg install neovim ||');
    expect(s.endsWith('fi && nvim')).toBe(true);
    // Notes come first; builtins just run
    expect(launchScript(DEV_TOOLS.find(t => t.id === 'claude')!)).toMatch(/^printf '%s\\n' 'Sign in with your Claude account.*'; claude$/);
    expect(launchScript(DEV_TOOLS.find(t => t.id === 'codex')!)).toContain('codex --sandbox danger-full-access');
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  it('the install script runs in the shell: a present tool is not reinstalled', async () => {
    const { shell } = await createTestShell();
    const fake = { id: 'x', name: 'X', group: 'developer' as const, order: 1, bins: ['ls'], install: 'echo INSTALLING', run: 'echo RAN' };
    const r = await run(shell, launchScript(fake));
    expect(r.output).toContain('RAN');
    expect(r.output).not.toContain('INSTALLING');
    const missing = { ...fake, bins: ['no-such-tool-xyz'] };
    const r2 = await run(shell, launchScript(missing));
    expect(r2.output).toContain("X isn't installed yet: echo INSTALLING");
    expect(r2.output).toContain('INSTALLING');
    expect(r2.output).toContain('RAN');
  });
});

describe('Clone and branch folders', () => {
  it('reads owner/repo, GitHub URLs and SSH remotes', () => {
    const want = { owner: 'octocat', repo: 'Hello-World', url: 'https://github.com/octocat/Hello-World' };
    for (const s of ['octocat/Hello-World', 'https://github.com/octocat/Hello-World', 'github.com/octocat/Hello-World.git', 'git@github.com:octocat/Hello-World.git', ' https://github.com/octocat/Hello-World/ ']) {
      expect(parseRepoSpec(s), s).toEqual(want);
    }
    for (const s of ['', 'octocat', 'a/b/c', '../x', 'https://gitlab.com/a/b', 'a b/c']) expect(parseRepoSpec(s), s).toBeNull();
  });

  it('clones partially with real git when signed in, shallow with the builtin otherwise', () => {
    const spec = parseRepoSpec('octocat/Hello-World')!;
    const signed = cloneScript(spec, true);
    expect(signed).toContain('mkdir -p ~/src/octocat && cd ~/src/octocat');
    expect(signed).toContain('pkg install git');
    expect(signed).toContain("git clone --filter=blob:none --progress 'https://github.com/octocat/Hello-World' 'Hello-World'");
    // The sign-in reaches git through the environment, never the command line or .git/config
    expect(signed).toContain('GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf \'x-access-token:%s\' "$GITHUB_TOKEN" | base64 -w0)"');
    expect(signed).not.toMatch(/gh[op]_[A-Za-z0-9]/);
    const anon = cloneScript(spec, false);
    expect(anon).toContain("git clone --depth 1 'https://github.com/octocat/Hello-World' 'Hello-World'");
    expect(anon).not.toContain('GITHUB_TOKEN');
  });

  it('a branch gets a folder beside the repository', () => {
    expect(branchFolder('/home/user/src/o/r', 'feature/json')).toBe('/home/user/src/o/r@feature-json');
    expect(validBranch('feature/json')).toBe(true);
    for (const b of ['', 'a b', 'a..b', '-x', 'x/', 'x.lock', 'a~1', '@']) expect(validBranch(b), b).toBe(false);
    const s = worktreeScript('/home/user/src/o/r', 'feature/json');
    expect(s).toContain("cd '/home/user/src/o/r'");
    expect(s).toContain("if git show-ref --verify --quiet 'refs/heads/feature/json'; then git worktree add '/home/user/src/o/r@feature-json' 'feature/json'; else git worktree add -b 'feature/json' '/home/user/src/o/r@feature-json'; fi");
    expect(mainRoot({ root: '/home/user/src/o/r@x', gitdir: '/home/user/src/o/r/.git/worktrees/r@x', worktree: true })).toBe('/home/user/src/o/r');
  });
});

describe('Git state (Files badges, the Git app)', () => {
  it('finds the repository, its branch, each entry\'s status and ahead/behind', async () => {
    const { shell, fs } = await createTestShell();
    const sh = async (c: string) => { const r = await run(shell, c); expect(r.exitCode, `${c}\n${r.output}`).toBe(0); return r.output; };
    await sh('mkdir -p /home/user/src/demo/hello && cd /home/user/src/demo/hello && git init');
    await sh('cd /home/user/src/demo/hello && echo one > a.txt && mkdir -p lib && echo x > lib/m.py && git add . && git commit -m first');
    const first = (await fs.readFile('/home/user/src/demo/hello/.git/refs/heads/main', 'utf8') as string).trim();
    await sh('cd /home/user/src/demo/hello && echo two >> a.txt && git add . && git commit -m second');
    // An upstream one commit behind
    await fs.mkdir('/home/user/src/demo/hello/.git/refs/remotes/origin', { recursive: true });
    await fs.writeFile('/home/user/src/demo/hello/.git/refs/remotes/origin/main', first + '\n');
    await sh('cd /home/user/src/demo/hello && echo three >> a.txt && echo new > b.txt && echo y > lib/n.py && git add lib/n.py');

    const repo = (await findRepo(fs, '/home/user/src/demo/hello/lib'))!;
    expect(repo).toEqual({ root: '/home/user/src/demo/hello', gitdir: '/home/user/src/demo/hello/.git', worktree: false });
    expect(await findRepo(fs, '/tmp')).toBeNull();
    expect(await headBranch(fs, repo)).toBe('main');
    const top = await dirStatus(fs, repo, repo.root);
    expect(Object.fromEntries(top!)).toEqual({ 'a.txt': 'M', 'b.txt': '?', lib: 'M' });
    expect(Object.fromEntries((await dirStatus(fs, repo, '/home/user/src/demo/hello/lib'))!)).toEqual({ 'n.py': 'A' });
    expect(await upstreamOf(fs, repo)).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0 });

    // A worktree's .git file points into the main repository
    await fs.mkdir('/home/user/src/demo/hello@x', { recursive: true });
    await fs.writeFile('/home/user/src/demo/hello@x/.git', 'gitdir: /home/user/src/demo/hello/.git/worktrees/hello@x\n');
    await fs.mkdir('/home/user/src/demo/hello/.git/worktrees/hello@x', { recursive: true });
    await fs.writeFile('/home/user/src/demo/hello/.git/worktrees/hello@x/HEAD', 'ref: refs/heads/x\n');
    const wt = (await findRepo(fs, '/home/user/src/demo/hello@x'))!;
    expect(wt.worktree).toBe(true);
    expect(await headBranch(fs, wt)).toBe('x');
    expect(await dirStatus(fs, wt, wt.root)).toBeNull();
  });

  it('the Git app sorts statusMatrix rows into staged, changed and untracked', () => {
    const k = (head: number, work: number, stage: number) => kindsOf({ path: 'f', head, work, stage });
    expect(k(1, 1, 1)).toEqual([]);
    expect(k(0, 2, 0)).toEqual(['untracked']);
    expect(k(0, 2, 2)).toEqual(['staged']);        // new, staged
    expect(k(1, 2, 1)).toEqual(['changed']);       // modified, not staged
    expect(k(1, 2, 2)).toEqual(['staged']);        // modified, staged
    expect(k(1, 2, 3)).toEqual(['staged', 'changed']); // staged, then changed again
    expect(k(1, 0, 1)).toEqual(['changed']);       // deleted, not staged
    expect(k(1, 0, 0)).toEqual(['staged']);        // deletion staged
  });
});
