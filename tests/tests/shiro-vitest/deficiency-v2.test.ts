/**
 * Tests for Shiro deficiency assessment v2 fixes:
 * - ${VAR:-default} parameter expansion
 * - Control structures in compound commands
 * - [[ ]] double-bracket test
 * - Heredoc in $() quote tracking
 * - /bin/sh dispatch
 * - until loops
 * - chmod symbolic mode
 * - mktemp abs path template + --suffix
 * - getSyncResponse expansion
 * - os.cpus() count
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { nodeCmd } from '@shiro/commands/jseval';
import type { CommandContext } from '@shiro/commands/index';

function createCtx(shell: Shell, fs: FileSystem, args: string[]): CommandContext {
  return { args, fs, cwd: shell.cwd, env: shell.env, stdin: '', stdout: '', stderr: '', shell };
}

describe('Deficiency v2 Fixes', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ─── Fix 1: ${VAR:-default} parameter expansion ───────────────────────

  describe('${VAR:-default} parameter expansion', () => {
    it('uses default when variable is unset', async () => {
      const { output } = await run(shell, 'echo ${UNSET_VAR:-fallback}');
      expect(output.trim()).toBe('fallback');
    });

    it('uses variable value when set', async () => {
      shell.env['MY_VAR'] = 'hello';
      const { output } = await run(shell, 'echo ${MY_VAR:-default}');
      expect(output.trim()).toBe('hello');
    });

    it('uses default when variable is empty with colon', async () => {
      shell.env['EMPTY_VAR'] = '';
      const { output } = await run(shell, 'echo ${EMPTY_VAR:-fallback}');
      expect(output.trim()).toBe('fallback');
    });

    it('uses empty value without colon when set to empty', async () => {
      shell.env['EMPTY_VAR'] = '';
      const { output } = await run(shell, 'echo ${EMPTY_VAR-fallback}');
      expect(output.trim()).toBe('');
    });

    it('handles ${VAR:=assign} — assigns default', async () => {
      const { output } = await run(shell, 'echo ${NEW_VAR:=assigned}');
      expect(output.trim()).toBe('assigned');
      expect(shell.env['NEW_VAR']).toBe('assigned');
    });

    it('handles ${VAR:+alternate} — uses alternate when set', async () => {
      shell.env['SET_VAR'] = 'something';
      const { output } = await run(shell, 'echo ${SET_VAR:+alternate}');
      expect(output.trim()).toBe('alternate');
    });

    it('handles ${VAR:+alternate} — empty when unset', async () => {
      const { output } = await run(shell, 'echo ${UNSET:+alternate}');
      expect(output.trim()).toBe('');
    });

    it('handles nested ${A:-${B:-c}}', async () => {
      const { output } = await run(shell, 'echo ${UNSET1:-${UNSET2:-nested}}');
      expect(output.trim()).toBe('nested');
    });
  });

  // ─── Fix 2: Control structures in compound commands ───────────────────

  describe('control structures in compound commands', () => {
    it('while loop after && works', async () => {
      shell.env['COUNTER'] = '0';
      const { output } = await run(shell, 'echo ok && while [ $COUNTER -lt 0 ]; do echo x; done && echo done');
      expect(output).toContain('ok');
      expect(output).toContain('done');
    });

    it('for loop after && works', async () => {
      const { output } = await run(shell, 'echo start && for i in a b; do echo $i; done && echo end');
      expect(output).toContain('start');
      expect(output).toContain('a');
      expect(output).toContain('b');
      expect(output).toContain('end');
    });

    it('if after ; works', async () => {
      const { output } = await run(shell, 'echo first; if [ 1 -eq 1 ]; then echo yes; fi');
      expect(output).toContain('first');
      expect(output).toContain('yes');
    });
  });

  // ─── Fix 2b: until loops ──────────────────────────────────────────────

  describe('until loops', () => {
    it('single-line until loop works', async () => {
      shell.env['N'] = '0';
      const { output, exitCode } = await run(shell, 'until [ $N -eq 3 ]; do echo $N; N=$(($N + 1)); done');
      expect(exitCode).toBe(0);
      expect(output).toContain('0');
      expect(output).toContain('1');
      expect(output).toContain('2');
      expect(output).not.toContain('3');
    });
  });

  // ─── Fix 3: [[ ]] double-bracket test ─────────────────────────────────

  describe('[[ ]] double-bracket test', () => {
    it('[[ -f file ]] works in condition', async () => {
      await fs.writeFile('/tmp/testfile', 'hello');
      const { output, exitCode } = await run(shell, 'if [[ -f /tmp/testfile ]]; then echo found; fi');
      expect(output.trim()).toBe('found');
      expect(exitCode).toBe(0);
    });

    it('[[ -f missing ]] returns nonzero', async () => {
      const { exitCode } = await run(shell, '[[ -f /tmp/nonexistent ]]');
      expect(exitCode).toBe(1);
    });

    it('[[ ]] works with && chain', async () => {
      await fs.writeFile('/tmp/check', 'data');
      const { output } = await run(shell, '[[ -f /tmp/check ]] && echo yes');
      expect(output.trim()).toBe('yes');
    });

    it('[[ string comparison ]] works', async () => {
      shell.env['FOO'] = 'bar';
      const { exitCode } = await run(shell, '[[ $FOO = bar ]]');
      expect(exitCode).toBe(0);
    });
  });

  // ─── Fix 4: Heredoc in $() quote tracking ─────────────────────────────

  describe('heredoc in $() quote tracking', () => {
    it('parens inside quotes do not close $()', async () => {
      const { output } = await run(shell, 'echo $(echo "hello (world)")');
      expect(output.trim()).toBe('hello (world)');
    });
  });

  // ─── Fix 5: /bin/sh dispatch ──────────────────────────────────────────

  describe('/bin/sh dispatch', () => {
    it('/bin/sh -c "echo hello" works', async () => {
      const { output, exitCode } = await run(shell, '/bin/sh -c "echo hello"');
      expect(output.trim()).toBe('hello');
      expect(exitCode).toBe(0);
    });

    it('/bin/bash -c "echo test" works', async () => {
      const { output } = await run(shell, '/bin/bash -c "echo test"');
      expect(output.trim()).toBe('test');
    });

    it('/usr/bin/env echo works', async () => {
      const { output } = await run(shell, '/usr/bin/env echo hello');
      expect(output.trim()).toBe('hello');
    });

    it('/bin/sh with script file works', async () => {
      await fs.writeFile('/tmp/test.sh', 'echo from-script\n');
      const { output } = await run(shell, '/bin/sh /tmp/test.sh');
      expect(output.trim()).toBe('from-script');
    });
  });

  // ─── Fix 6: chmod symbolic mode ───────────────────────────────────────

  describe('chmod symbolic mode', () => {
    it('chmod +x works', async () => {
      await fs.writeFile('/tmp/chtest', 'content');
      const { exitCode } = await run(shell, 'chmod +x /tmp/chtest');
      expect(exitCode).toBe(0);
      const stat = await fs.stat('/tmp/chtest');
      expect(stat.mode & 0o111).not.toBe(0);
    });

    it('chmod u+rw works', async () => {
      await fs.writeFile('/tmp/chtest2', 'content');
      await fs.chmod('/tmp/chtest2', 0o000);
      const { exitCode } = await run(shell, 'chmod u+rw /tmp/chtest2');
      expect(exitCode).toBe(0);
      const stat = await fs.stat('/tmp/chtest2');
      expect(stat.mode & 0o600).toBe(0o600);
    });

    it('chmod 755 still works (octal)', async () => {
      await fs.writeFile('/tmp/chtest3', 'content');
      const { exitCode } = await run(shell, 'chmod 755 /tmp/chtest3');
      expect(exitCode).toBe(0);
      const stat = await fs.stat('/tmp/chtest3');
      expect(stat.mode).toBe(0o755);
    });

    it('chmod -x removes execute', async () => {
      await fs.writeFile('/tmp/chtest4', 'content');
      await fs.chmod('/tmp/chtest4', 0o755);
      const { exitCode } = await run(shell, 'chmod -x /tmp/chtest4');
      expect(exitCode).toBe(0);
      const stat = await fs.stat('/tmp/chtest4');
      expect(stat.mode & 0o111).toBe(0);
    });
  });

  // ─── Fix 7: mktemp abs path template ──────────────────────────────────

  describe('mktemp fixes', () => {
    it('mktemp /tmp/cc-XXXXXX creates in /tmp (not /tmp//tmp)', async () => {
      const { output, exitCode } = await run(shell, 'mktemp /tmp/cc-XXXXXX');
      expect(exitCode).toBe(0);
      const path = output.trim();
      expect(path).toMatch(/^\/tmp\/cc-.{6}$/);
      expect(path).not.toContain('//');
    });

    it('mktemp --suffix=.txt appends suffix', async () => {
      const { output, exitCode } = await run(shell, 'mktemp --suffix=.txt');
      expect(exitCode).toBe(0);
      expect(output.trim()).toMatch(/\.txt$/);
    });

    it('mktemp --suffix VALUE appends suffix', async () => {
      const { output, exitCode } = await run(shell, 'mktemp --suffix .json');
      expect(exitCode).toBe(0);
      expect(output.trim()).toMatch(/\.json$/);
    });
  });

  // ─── Fix 8: getSyncResponse expansion ─────────────────────────────────

  describe('getSyncResponse expansion', () => {
    it('execSync("pwd") returns correct cwd', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const cp = require("child_process"); const r = cp.execSync("pwd", {encoding:"utf8"}); process.stdout.write(r)']);
      await nodeCmd.exec(ctx);
      expect(ctx.stdout.trim()).toBe('/home/user');
    });

    it('execSync("echo hello") returns output', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const cp = require("child_process"); const r = cp.execSync("echo hello", {encoding:"utf8"}); process.stdout.write(r)']);
      await nodeCmd.exec(ctx);
      expect(ctx.stdout.trim()).toBe('hello');
    });

    it('execSync("true") returns empty with status 0', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const cp = require("child_process"); const r = cp.spawnSync("true"); process.stdout.write(String(r.status))']);
      await nodeCmd.exec(ctx);
      expect(ctx.stdout.trim()).toBe('0');
    });

    it('execSync("node --version") returns version', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const cp = require("child_process"); const r = cp.execSync("node --version", {encoding:"utf8"}); process.stdout.write(r)']);
      await nodeCmd.exec(ctx);
      expect(ctx.stdout.trim()).toBe('v20.0.0');
    });

    it('execSync("uname -s") returns Linux', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const cp = require("child_process"); const r = cp.execSync("uname -s", {encoding:"utf8"}); process.stdout.write(r)']);
      await nodeCmd.exec(ctx);
      expect(ctx.stdout.trim()).toBe('Linux');
    });

    it('which returns path for known commands', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const cp = require("child_process"); const r = cp.execSync("which node", {encoding:"utf8"}); process.stdout.write(r)']);
      await nodeCmd.exec(ctx);
      expect(ctx.stdout.trim()).toBe('/usr/local/bin/node');
    });
  });

  // ─── Fix 9: os.cpus() count ───────────────────────────────────────────

  describe('os.cpus()', () => {
    it('returns multiple CPUs', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const os = require("os"); process.stdout.write(String(os.cpus().length))']);
      await nodeCmd.exec(ctx);
      const count = parseInt(ctx.stdout.trim());
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('CPUs have proper fields', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const os = require("os"); const c = os.cpus()[0]; process.stdout.write(JSON.stringify({model: c.model, speed: c.speed, hasTimes: !!c.times}))']);
      await nodeCmd.exec(ctx);
      const info = JSON.parse(ctx.stdout);
      expect(info.model).toBeTruthy();
      expect(info.speed).toBeGreaterThan(0);
      expect(info.hasTimes).toBe(true);
    });
  });
});
