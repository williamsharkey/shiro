import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
import { githubAuth } from '@shiro/commands/git';

describe('githubAuth', () => {
  it('sends the token up front for github.com remotes only', () => {
    const auth = githubAuth('tok123', 'https://github.com/o/r.git');
    expect(auth.headers.Authorization).toBe('Basic ' + btoa('x-access-token:tok123'));
    expect(auth.onAuth()).toEqual({ username: 'x-access-token', password: 'tok123' });
    expect(auth.onAuthFailure()).toEqual({ cancel: true });
    expect(githubAuth('tok123', 'https://gitlab.com/o/r.git')).toEqual({});
    expect(githubAuth('tok123', 'https://github.com.evil.example/o/r.git')).toEqual({});
    expect(githubAuth('', 'https://github.com/o/r.git')).toEqual({});
  });
});

describe('git config', () => {
  it('sets and reads global values in ~/.gitconfig', async () => {
    const { shell, fs } = await createTestShell();
    try { await fs.unlink('/home/user/.gitconfig'); } catch {}
    await run(shell, 'git config --global user.name "Test Person"');
    await run(shell, 'git config --global user.email test@example.com');
    expect((await run(shell, 'git config --global user.name')).output).toContain('Test Person');
    expect((await run(shell, 'git config --global --list')).output).toContain('user.email=test@example.com');
    expect(await fs.readFile('/home/user/.gitconfig', 'utf8')).toContain('[user]');
  });

  it('commits use repo config over global config', async () => {
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/home/user/.gitconfig', '[user]\n\tname = Global Name\n\temail = global@example.com\n');
    await run(shell, 'rm -rf /tmp/cfgrepo; mkdir -p /tmp/cfgrepo');
    await run(shell, 'cd /tmp/cfgrepo && git init && echo hi > a.txt && git add a.txt && git commit -m one');
    expect((await run(shell, 'cd /tmp/cfgrepo && git log')).output).toContain('Global Name <global@example.com>');
    await run(shell, 'cd /tmp/cfgrepo && git config user.name "Repo Name" && echo more >> a.txt && git add a.txt && git commit -m two');
    expect((await run(shell, 'cd /tmp/cfgrepo && git log')).output).toContain('Repo Name <global@example.com>');
    expect((await run(shell, 'cd /tmp/cfgrepo && git config user.name')).output).toContain('Repo Name');
  });

  it('git init starts on main', async () => {
    const { shell } = await createTestShell();
    await run(shell, 'rm -rf /tmp/initrepo; mkdir -p /tmp/initrepo');
    await run(shell, 'cd /tmp/initrepo && git init && echo x > f && git add f && git commit -m c');
    expect((await run(shell, 'cd /tmp/initrepo && git branch')).output).toContain('main');
  });
});
