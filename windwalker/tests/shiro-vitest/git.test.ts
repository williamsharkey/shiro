import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { Shell } from '@shiro/shell';
import { CommandRegistry } from '@shiro/commands/index';
import { gitCmd } from '@shiro/commands/git';

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

  it.skip('should clone a repository', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await shell.execute('git clone https://github.com/octocat/Hello-World test-clone', (s) => { stdout += s; }, (e) => { stderr += e; });

    expect(stdout).toContain('Cloning into');
    expect(exitCode).toBe(0);

    const cloneExists = await fs.exists('/home/user/test-clone');
    expect(cloneExists).toBe(true);
  });
});
