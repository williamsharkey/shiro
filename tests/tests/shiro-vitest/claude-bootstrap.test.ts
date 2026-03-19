import { beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '@shiro/commands/index';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { DEFAULT_CLAUDE_PERMISSIONS } from '@shiro/claude-config';
import { preloadEnvironment } from '@shiro/node-compat/preload';
import { createTestShell } from './helpers';

function createCtx(shell: Shell, fs: FileSystem): CommandContext {
  return {
    args: [],
    fs,
    cwd: shell.cwd,
    env: shell.env,
    stdin: '',
    stdout: '',
    stderr: '',
    shell,
  };
}

describe('Claude bootstrap config', () => {
  const claudeScriptPath = '/work/demo/claude-code/cli.js';
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    shell.env['HOME'] = '/home/user';
    await fs.mkdir('/work/demo/claude-code', { recursive: true });
    await fs.writeFile(claudeScriptPath, '// test cli');
    shell.cwd = '/work/demo';
  });

  it('seeds trust, onboarding, and bypass settings before Claude Code starts', async () => {
    const ctx = createCtx(shell, fs);

    await preloadEnvironment(
      ctx,
      new Map(),
      new Map(),
      claudeScriptPath,
    );

    const settings = JSON.parse(await fs.readFile('/home/user/.claude/settings.json', 'utf8') as string);
    expect(settings.permissions).toEqual(DEFAULT_CLAUDE_PERMISSIONS);
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);

    const config = JSON.parse(await fs.readFile('/home/user/.claude.json', 'utf8') as string);
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.theme).toBe('dark');
    expect(config.projects['/work/demo']).toMatchObject({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: 1,
    });
  });

  it('preserves existing Claude settings while filling in missing Shiro defaults', async () => {
    await fs.mkdir('/home/user/.claude', { recursive: true });
    await fs.writeFile('/home/user/.claude/settings.json', JSON.stringify({
      permissions: {
        allow: ['Read'],
        deny: ['Bash'],
      },
      skipDangerousModePermissionPrompt: true,
      extraFlag: 'keep-me',
    }, null, 2));
    await fs.writeFile('/home/user/.claude.json', JSON.stringify({
      theme: 'light',
      hasCompletedOnboarding: true,
      projects: {
        '/work/demo': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
          projectOnboardingSeenCount: 3,
          allowedTools: ['Read'],
        },
      },
    }, null, 2));

    const ctx = createCtx(shell, fs);

    await preloadEnvironment(
      ctx,
      new Map(),
      new Map(),
      claudeScriptPath,
    );

    const settings = JSON.parse(await fs.readFile('/home/user/.claude/settings.json', 'utf8') as string);
    expect(settings.permissions).toEqual({
      allow: ['Read'],
      deny: ['Bash'],
    });
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.extraFlag).toBe('keep-me');

    const config = JSON.parse(await fs.readFile('/home/user/.claude.json', 'utf8') as string);
    expect(config.theme).toBe('light');
    expect(config.projects['/work/demo']).toMatchObject({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: 3,
      allowedTools: ['Read'],
    });
  });
});
