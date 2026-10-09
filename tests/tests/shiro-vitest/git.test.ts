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

});
