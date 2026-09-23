import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import {
  CLAUDE_CODE_REPORTED_VERSION,
  isClaudeCodeScript,
  patchClaudeCodeSource,
} from '@shiro/claude-code-version';
import { ensureClaudeBootstrap } from '@shiro/claude-config';
import { needsSession } from '@shiro/commands/claude';

describe('Claude Code version reporting', () => {
  it('raises every inlined VERSION constant of an older build', () => {
    const src = 'a={VERSION:"2.1.112",X:1};b={VERSION:"2.1.112"}.VERSION';
    const out = patchClaudeCodeSource(src);
    expect(out).not.toContain('2.1.112');
    expect(out.split(`VERSION:"${CLAUDE_CODE_REPORTED_VERSION}"`).length - 1).toBe(2);
  });

  it('leaves newer builds alone', () => {
    const src = 'a={VERSION:"9.0.0"}';
    expect(patchClaudeCodeSource(src)).toBe(src);
  });

  it('recognizes the package entry script only', () => {
    expect(isClaudeCodeScript('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(true);
    expect(isClaudeCodeScript('/usr/local/bin/claude')).toBe(false);
    expect(isClaudeCodeScript(undefined)).toBe(false);
  });
});

describe('claude command', () => {
  it('only treats sessions as needing sign-in and skip-permissions', () => {
    expect(needsSession([])).toBe(true);
    expect(needsSession(['-p', 'hi'])).toBe(true);
    expect(needsSession(['--version'])).toBe(false);
    expect(needsSession(['mcp', 'list'])).toBe(false);
  });

  it('resolves the bin symlink so node sees the package path', async () => {
    const { fs } = await createTestShell();
    await fs.mkdir('/tmp/pkg', { recursive: true });
    await fs.writeFile('/tmp/pkg/cli.js', 'x');
    try { await fs.unlink('/tmp/linked'); } catch {}
    await fs.symlink('/tmp/pkg/cli.js', '/tmp/linked');
    expect(await fs.realpath('/tmp/linked')).toBe('/tmp/pkg/cli.js');
  });
});

describe('Claude tui default', () => {
  let fs: FileSystem;
  beforeEach(async () => {
    fs = (await createTestShell()).fs;
    await fs.mkdir('/home/user/.claude', { recursive: true });
    try { await fs.unlink('/home/user/.claude/settings.json'); } catch {}
  });

  it('seeds fullscreen when unset', async () => {
    await ensureClaudeBootstrap(fs, { defaultTui: 'fullscreen' });
    const settings = JSON.parse(await fs.readFile('/home/user/.claude/settings.json', 'utf8') as string);
    expect(settings.tui).toBe('fullscreen');
  });

  it('keeps a choice made with /tui', async () => {
    await fs.writeFile('/home/user/.claude/settings.json', JSON.stringify({ tui: 'default' }));
    await ensureClaudeBootstrap(fs, { defaultTui: 'fullscreen' });
    const settings = JSON.parse(await fs.readFile('/home/user/.claude/settings.json', 'utf8') as string);
    expect(settings.tui).toBe('default');
  });
});
