import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '../src/filesystem';
import { Shell } from '../src/shell';
import { CommandRegistry } from '../src/commands/index';
import { gitCmd } from '../src/commands/git';

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

    console.log('git init exitCode:', exitCode);
    console.log('git init stdout:', stdout);
    console.log('git init stderr:', stderr);

    expect(stderr).toBe('');
    expect(stdout).toContain('Initialized empty Git repository');
    expect(exitCode).toBe(0);

    // Verify .git directory was created
    const gitExists = await fs.exists('/home/user/.git');
    expect(gitExists).toBe(true);

    // Verify .git/config was created by isomorphic-git
    const configExists = await fs.exists('/home/user/.git/config');
    expect(configExists).toBe(true);
  });

  it('should initialize a git repository in specified directory', async () => {
    let stdout = '';
    let stderr = '';

    // This is the failing case from the GitHub issue
    const exitCode = await shell.execute('git init test-repo', (s) => { stdout += s; }, (e) => { stderr += e; });

    console.log('git init test-repo exitCode:', exitCode);
    console.log('git init test-repo stdout:', stdout);
    console.log('git init test-repo stderr:', stderr);

    expect(stderr).toBe('');
    expect(stdout).toContain('Initialized empty Git repository');
    expect(exitCode).toBe(0);

    // Verify test-repo directory was created
    const repoExists = await fs.exists('/home/user/test-repo');
    expect(repoExists).toBe(true);

    // Verify .git directory was created in test-repo
    const gitExists = await fs.exists('/home/user/test-repo/.git');
    expect(gitExists).toBe(true);

    // Verify .git/config was created by isomorphic-git
    const configExists = await fs.exists('/home/user/test-repo/.git/config');
    expect(configExists).toBe(true);
  });

  it('should clone a repository', async () => {
    let stdout = '';
    let stderr = '';

    // This test will likely fail due to the ENOENT issue
    const exitCode = await shell.execute('git clone https://github.com/williamsharkey/shiro test-clone', (s) => { stdout += s; }, (e) => { stderr += e; });

    console.log('git clone exitCode:', exitCode);
    console.log('git clone stdout:', stdout);
    console.log('git clone stderr:', stderr);

    // Check if clone succeeded
    if (stderr) {
      expect(stderr).not.toContain('ENOENT');
    }
    expect(stdout).toContain('Cloning into');
    expect(exitCode).toBe(0);

    // Verify cloned files exist
    const cloneExists = await fs.exists('/home/user/test-clone');
    expect(cloneExists).toBe(true);

    const readmeExists = await fs.exists('/home/user/test-clone/README.md');
    expect(readmeExists).toBe(true);

    const gitConfigExists = await fs.exists('/home/user/test-clone/.git/config');
    expect(gitConfigExists).toBe(true);

    // List some files
    const files = await fs.readdir('/home/user/test-clone');
    console.log('Cloned files:', files);
  });
});
