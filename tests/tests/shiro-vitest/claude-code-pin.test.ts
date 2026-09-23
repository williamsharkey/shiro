/**
 * Regression tests for the `sc` / `cw` / `builder` Claude Code launch path.
 *
 * @anthropic-ai/claude-code@2.1.113 (2026-04-17) switched from a pure-JS
 * bundle (bin -> cli.js) to a native-binary launcher (bin -> bin/claude.exe,
 * populated by a postinstall script). Shiro can execute neither, so tracking
 * `latest` silently broke `sc`: install appeared to succeed, then `claude`
 * exited 1 with no output. These tests pin that behaviour down.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { npmCmd } from '@shiro/commands/npm';
import {
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_REPORTED_VERSION,
  CLAUDE_CODE_DIR,
  CLAUDE_CODE_CLI_JS,
  CLAUDE_BIN,
  claudeLaunchCmd,
  isClaudeCodeInstalled,
} from '@shiro/claude-code-version';
import type { CommandContext } from '@shiro/commands/index';

function createCtx(shell: Shell, fs: FileSystem, args: string[]): CommandContext {
  return { args, fs, cwd: shell.cwd, env: shell.env, stdin: '', stdout: '', stderr: '', shell };
}

/**
 * FileSystem always opens the same IndexedDB ('shiro-fs'), so tests in a file
 * share state. Wipe the install locations explicitly — without this, a cli.js
 * left behind by one test makes the next test's install look healthy, which is
 * the exact failure mode these tests exist to catch.
 */
async function freshShell(): Promise<{ shell: Shell; fs: FileSystem }> {
  const env = await createTestShell();
  for (const p of [CLAUDE_CODE_DIR, CLAUDE_BIN]) {
    try { await env.fs.rm(p, { recursive: true }); } catch { /* not there yet */ }
  }
  return env;
}

const install = (shell: Shell, fs: FileSystem, spec: string) =>
  npmCmd.exec(createCtx(shell, fs, ['install', '-g', spec]));

describe('Claude Code pinned install', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeEach(async () => { ({ shell, fs } = await freshShell()); });

  it('the pinned version still ships an executable cli.js', async () => {
    expect(await install(shell, fs, `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`)).toBe(0);

    const pkg = JSON.parse(await fs.readFile(`${CLAUDE_CODE_DIR}/package.json`, 'utf8') as string);
    expect(pkg.version).toBe(CLAUDE_CODE_VERSION);
    expect(pkg.bin.claude).toBe('cli.js');
    expect((await fs.stat(CLAUDE_CODE_CLI_JS)).type).toBe('file');
  }, 300000);

  it('`sc` installs and launches Claude on a clean filesystem', async () => {
    const cmd = await claudeLaunchCmd(fs, ' --version');
    expect(cmd).toContain(`npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);

    const { output, exitCode } = await run(shell, cmd + ' 2>&1');
    expect(exitCode).toBe(0);
    expect(output).toContain(`${CLAUDE_CODE_REPORTED_VERSION} (Claude Code)`);
  }, 300000);

  it('a second `sc` reuses the install instead of reinstalling', async () => {
    await run(shell, await claudeLaunchCmd(fs, ' --version'));

    const cmd = await claudeLaunchCmd(fs, ' --version');
    expect(cmd).not.toContain('npm install');

    const { output, exitCode } = await run(shell, cmd + ' 2>&1');
    expect(exitCode).toBe(0);
    expect(output).toContain(`${CLAUDE_CODE_REPORTED_VERSION} (Claude Code)`);
    expect(output).not.toContain('Installing packages globally');
  }, 300000);

  it('installing latest leaves a claude that cannot run — the reported bug', async () => {
    expect(await install(shell, fs, '@anthropic-ai/claude-code')).toBe(0);

    const pkg = JSON.parse(await fs.readFile(`${CLAUDE_CODE_DIR}/package.json`, 'utf8') as string);
    expect(pkg.bin.claude).toBe('bin/claude.exe');

    // `which claude` succeeds, so a which-only guard would call this healthy...
    expect((await run(shell, 'which claude')).exitCode).toBe(0);
    // ...but running it fails.
    expect((await run(shell, 'claude --version 2>&1')).exitCode).not.toBe(0);
    // The version+symlink check sees through it.
    expect(await isClaudeCodeInstalled(fs)).toBe(false);
  }, 300000);

  it('`sc` repairs a filesystem already poisoned by a latest install', async () => {
    await install(shell, fs, '@anthropic-ai/claude-code');
    expect((await run(shell, 'claude --version 2>&1')).exitCode).not.toBe(0);

    const { output, exitCode } = await run(shell, await claudeLaunchCmd(fs, ' --version') + ' 2>&1');
    expect(exitCode).toBe(0);
    expect(output).toContain(`${CLAUDE_CODE_REPORTED_VERSION} (Claude Code)`);

    const pkg = JSON.parse(await fs.readFile(`${CLAUDE_CODE_DIR}/package.json`, 'utf8') as string);
    expect(pkg.version).toBe(CLAUDE_CODE_VERSION);
  }, 300000);

  it('a stale cli.js from an earlier install does not mask a broken latest', async () => {
    // Pinned install first, so cli.js exists...
    await install(shell, fs, `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);
    // ...then latest over the top. npm does not clean the directory, so cli.js
    // survives while the symlink is repointed at the native placeholder.
    await install(shell, fs, '@anthropic-ai/claude-code');
    expect((await fs.stat(CLAUDE_CODE_CLI_JS)).type).toBe('file');

    expect(await isClaudeCodeInstalled(fs)).toBe(false);
    expect(await claudeLaunchCmd(fs)).toContain('npm install');
  }, 300000);
});
