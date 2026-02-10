/**
 * Tests for Claude Code tool shims (Edit, Write, Read, Grep, Glob).
 *
 * These test the Node.js fs/child_process shims in jseval.ts that Claude Code
 * relies on. The key scenario: Claude Code is a long-running node process, and
 * its Bash tool runs shell commands via child_process that write to IDB. Then
 * its Read/Edit tools must see the fresh data (not stale fileCache).
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

describe('Claude Code Tool Shims', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ─── Bug #1: Edit tool silent failure ──────────────────────────────────
  // Edit reads file, modifies content, writes back. If readFileSync returns
  // stale data, the edit appears to succeed but content is unchanged.
  describe('Bug #1: Edit tool — fileCache coherence after shell writes', () => {

    it('readFileSync should see content written by shell echo >', async () => {
      // Simulate: Bash tool writes file, then Read tool reads it
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        // Bash tool writes a file via shell
        'await new Promise((resolve, reject) => {',
        '  cp.exec("echo hello-from-bash > /tmp/edit-test.txt", (err) => err ? reject(err) : resolve());',
        '});',
        // Read tool reads it back via readFileSync
        'const content = fs.readFileSync("/tmp/edit-test.txt", "utf8");',
        'console.log("CONTENT:" + content.trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('CONTENT:hello-from-bash');
    });

    it('readFileSync should see updated content after overwrite via shell', async () => {
      // Write initial content, then overwrite, then read
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        // Write initial
        'fs.writeFileSync("/tmp/edit-test2.txt", "original");',
        // Overwrite via shell (simulating Bash tool)
        'await new Promise((resolve, reject) => {',
        '  cp.exec("echo overwritten > /tmp/edit-test2.txt", (err) => err ? reject(err) : resolve());',
        '});',
        // Read should see "overwritten" not "original"
        'const content = fs.readFileSync("/tmp/edit-test2.txt", "utf8");',
        'console.log("CONTENT:" + content.trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('CONTENT:overwritten');
    });

    it('callback readFile should see content written by shell', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        'await new Promise((resolve, reject) => {',
        '  cp.exec("echo callback-test > /tmp/edit-cb.txt", (err) => err ? reject(err) : resolve());',
        '});',
        'const content = await new Promise((resolve, reject) => {',
        '  fs.readFile("/tmp/edit-cb.txt", "utf8", (err, data) => err ? reject(err) : resolve(data));',
        '});',
        'console.log("CONTENT:" + content.trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('CONTENT:callback-test');
    });

    it('fs.promises.readFile should see content written by shell', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fsp = require("fs/promises");',
        'const cp = require("child_process");',
        'await new Promise((resolve, reject) => {',
        '  cp.exec("echo promises-test > /tmp/edit-prom.txt", (err) => err ? reject(err) : resolve());',
        '});',
        'const content = await fsp.readFile("/tmp/edit-prom.txt", "utf8");',
        'console.log("CONTENT:" + content.trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('CONTENT:promises-test');
    });
  });

  // ─── Bug #2: Write overwrite failure ───────────────────────────────────
  // Write tool writes file, but subsequent reads (via both sync and async)
  // should see the new content.
  describe('Bug #2: Write tool — overwrite must persist', () => {

    it('writeFileSync then readFileSync should roundtrip', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/write-test.txt", "version1");',
        'fs.writeFileSync("/tmp/write-test.txt", "version2");',
        'console.log(fs.readFileSync("/tmp/write-test.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('version2');
    });

    it('callback writeFile then readFileSync should see new content', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/write-cb.txt", "old-content");',
        'await new Promise((resolve, reject) => {',
        '  fs.writeFile("/tmp/write-cb.txt", "new-content", (err) => err ? reject(err) : resolve());',
        '});',
        'console.log(fs.readFileSync("/tmp/write-cb.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('new-content');
    });

    it('createWriteStream then readFileSync should see streamed content', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const ws = fs.createWriteStream("/tmp/write-stream.txt");',
        'ws.write("chunk1");',
        'ws.write("chunk2");',
        'await new Promise(resolve => ws.end(resolve));',
        'console.log(fs.readFileSync("/tmp/write-stream.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('chunk1chunk2');
    });

    it('fs.promises.writeFile then readFileSync should see new content', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const fsp = require("fs/promises");',
        'fs.writeFileSync("/tmp/write-prom.txt", "old");',
        'await fsp.writeFile("/tmp/write-prom.txt", "new");',
        'console.log(fs.readFileSync("/tmp/write-prom.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('new');
    });
  });

  // ─── Bug #3: Grep always "No matches" ─────────────────────────────────
  // Grep spawns rg via child_process. The spawn/exec must complete and
  // fire events before the script continues.
  describe('Bug #3: Grep tool — child_process must complete', () => {

    it('cp.exec rg should return matches', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        'fs.writeFileSync("/tmp/grep-test.txt", "hello world\\nfoo bar\\nhello again\\n");',
        'const result = await new Promise((resolve, reject) => {',
        '  cp.exec("rg hello /tmp/grep-test.txt", (err, stdout, stderr) => {',
        '    resolve({ stdout, stderr, code: err ? err.code : 0 });',
        '  });',
        '});',
        'console.log("STDOUT:" + result.stdout);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello world');
      expect(ctx.stdout).toContain('hello again');
    });

    it('cp.spawn rg should emit data events', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        'fs.writeFileSync("/tmp/grep-spawn.txt", "alpha\\nbeta\\nalpha2\\n");',
        'const child = cp.spawn("rg", ["alpha", "/tmp/grep-spawn.txt"]);',
        'let stdout = "";',
        'child.stdout.on("data", (d) => { stdout += d.toString(); });',
        'const code = await new Promise(resolve => child.on("close", resolve));',
        'console.log("CODE:" + code);',
        'console.log("STDOUT:" + stdout);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('CODE:0');
      expect(ctx.stdout).toContain('alpha');
    });

    it('cp.execFile should return stdout', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        'fs.writeFileSync("/tmp/grep-execfile.txt", "needle in haystack\\n");',
        'const result = await new Promise((resolve, reject) => {',
        '  cp.execFile("rg", ["needle", "/tmp/grep-execfile.txt"], (err, stdout) => {',
        '    resolve({ stdout, code: err ? err.code : 0 });',
        '  });',
        '});',
        'console.log("STDOUT:" + result.stdout);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('needle in haystack');
    });

    it('util.promisify(cp.execFile) should return stdout', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        'const util = require("util");',
        'fs.writeFileSync("/tmp/grep-promisify.txt", "findme here\\n");',
        'const execFileAsync = util.promisify(cp.execFile);',
        'const { stdout } = await execFileAsync("rg", ["findme", "/tmp/grep-promisify.txt"]);',
        'console.log("STDOUT:" + stdout);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('findme here');
    });

    it('args with spaces should be shell-quoted', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        'fs.writeFileSync("/tmp/grep-spaces.txt", "hello world\\nfoo bar\\n");',
        'const result = await new Promise((resolve, reject) => {',
        '  cp.execFile("rg", ["-e", "hello world", "/tmp/grep-spaces.txt"], (err, stdout) => {',
        '    resolve({ stdout, code: err ? err.code : 0 });',
        '  });',
        '});',
        'console.log("STDOUT:" + result.stdout);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello world');
    });
  });

  // ─── Bug #4: Glob path param ──────────────────────────────────────────
  // Glob needs statSync/readdirSync to recognize directories that exist
  // in fileCache but not necessarily in IDB.
  describe('Bug #4: Glob tool — stat/readdir must recognize fileCache dirs', () => {

    it('statSync should recognize /home/user as directory', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const stat = fs.statSync("/home/user");',
        'console.log("isDir:" + stat.isDirectory());',
        'console.log("isFile:" + stat.isFile());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isDir:true');
      expect(ctx.stdout).toContain('isFile:false');
    });

    it('callback stat should recognize /home/user as directory', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const stat = await new Promise((resolve, reject) => {',
        '  fs.stat("/home/user", (err, s) => err ? reject(err) : resolve(s));',
        '});',
        'console.log("isDir:" + stat.isDirectory());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isDir:true');
    });

    it('fs.promises.stat should recognize /home/user as directory', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fsp = require("fs/promises");',
        'const stat = await fsp.stat("/home/user");',
        'console.log("isDir:" + stat.isDirectory());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isDir:true');
    });

    it('readdirSync should list files in /home/user', async () => {
      await fs.writeFile('/home/user/glob-test.txt', 'test');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const entries = fs.readdirSync("/home/user");',
        'console.log("ENTRIES:" + entries.join(","));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('glob-test.txt');
    });

    it('readdirSync withFileTypes should return dirents', async () => {
      await fs.writeFile('/home/user/dirent-file.txt', 'x');
      await fs.mkdir('/home/user/dirent-dir', { recursive: true });
      await fs.writeFile('/home/user/dirent-dir/child.txt', 'y');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const entries = fs.readdirSync("/home/user", { withFileTypes: true });',
        'for (const e of entries) {',
        '  console.log(e.name + ":" + (e.isDirectory() ? "dir" : "file"));',
        '}',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('dirent-file.txt:file');
      expect(ctx.stdout).toContain('dirent-dir:dir');
    });

    it('existsSync should find /home/user', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'console.log("exists:" + fs.existsSync("/home/user"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('exists:true');
    });
  });

  // ─── Bug #5: Shell parser || in quotes ─────────────────────────────────
  // node -e "console.log('a' || 'b')" should not split on ||
  describe('Bug #5: Shell parser — || inside quotes', () => {

    it('should not split || inside double quotes', async () => {
      const { output, exitCode } = await run(shell, 'echo "a || b"');
      expect(exitCode).toBe(0);
      expect(output).toContain('a || b');
    });

    it('should not split && inside double quotes', async () => {
      const { output, exitCode } = await run(shell, 'echo "a && b"');
      expect(exitCode).toBe(0);
      expect(output).toContain('a && b');
    });

    it('should not split || inside single quotes', async () => {
      const { output, exitCode } = await run(shell, "echo 'a || b'");
      expect(exitCode).toBe(0);
      expect(output).toContain('a || b');
    });

    it('single quotes inside double quotes should not affect || parsing', async () => {
      const { output, exitCode } = await run(shell, 'echo "it\'s a test" && echo "done"');
      expect(exitCode).toBe(0);
      expect(output).toContain("it's a test");
      expect(output).toContain('done');
    });

    it('node -e with || inside code should not split as shell operator', async () => {
      // This is the exact failing case from the bug report:
      // node -e "console.log('a' || 'b')"
      const ctx = createCtx(shell, fs, ['-e', "console.log('a' || 'b')"]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('a');
    });

    it('node -e with || via shell.execute should work', async () => {
      // When run through the shell, quotes protect the ||
      const { output, exitCode } = await run(shell, 'node -e "console.log(1 || 2)"');
      expect(exitCode).toBe(0);
      expect(output).toContain('1');
    });
  });

  // ─── Bug #6: env leaks secrets ─────────────────────────────────────────
  describe('Bug #6: env command masks secrets', () => {

    it('should mask ANTHROPIC_API_KEY', async () => {
      shell.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-verysecretkey1234567890';
      const { output } = await run(shell, 'env');
      expect(output).toContain('ANTHROPIC_API_KEY=');
      expect(output).not.toContain('verysecretkey1234567890');
      // First 4 chars should be visible
      expect(output).toContain('sk-a');
    });

    it('should mask OPENAI_API_KEY', async () => {
      shell.env['OPENAI_API_KEY'] = 'sk-proj-abcdefghijklmnop';
      const { output } = await run(shell, 'env');
      expect(output).toContain('OPENAI_API_KEY=');
      expect(output).not.toContain('abcdefghijklmnop');
    });

    it('should mask GITHUB_TOKEN', async () => {
      shell.env['GITHUB_TOKEN'] = 'ghp_1234567890abcdefghij';
      const { output } = await run(shell, 'env');
      expect(output).toContain('GITHUB_TOKEN=');
      expect(output).not.toContain('1234567890abcdefghij');
    });

    it('should NOT mask non-secret env vars', async () => {
      shell.env['MY_NORMAL_VAR'] = 'visible-value';
      const { output } = await run(shell, 'env');
      expect(output).toContain('MY_NORMAL_VAR=visible-value');
    });

    it('should not mask short values', async () => {
      shell.env['API_KEY'] = 'short';
      const { output } = await run(shell, 'env');
      // Short values (< 8 chars) shown as-is
      expect(output).toContain('API_KEY=short');
    });
  });

  // ─── New Bug: xargs -I ────────────────────────────────────────────────
  describe('New Bug: xargs -I (replace string)', () => {

    it('basic xargs should work', async () => {
      const { output, exitCode } = await run(shell, 'echo hello | xargs echo');
      expect(exitCode).toBe(0);
      expect(output).toContain('hello');
    });

    it('xargs -I{} should replace {} with input', async () => {
      await fs.writeFile('/tmp/xargs-test.txt', 'alpha\nbeta\ngamma\n');
      const { output, exitCode } = await run(shell, 'cat /tmp/xargs-test.txt | xargs -I{} echo "item: {}"');
      expect(exitCode).toBe(0);
      expect(output).toContain('item: alpha');
      expect(output).toContain('item: beta');
      expect(output).toContain('item: gamma');
    });

    it('xargs -I {} (with space) should also work', async () => {
      await fs.writeFile('/tmp/xargs-test2.txt', 'foo\nbar\n');
      const { output, exitCode } = await run(shell, 'cat /tmp/xargs-test2.txt | xargs -I {} echo "got: {}"');
      expect(exitCode).toBe(0);
      expect(output).toContain('got: foo');
      expect(output).toContain('got: bar');
    });
  });

  // ─── New Bug: Read cache never invalidates ────────────────────────────
  // After a file is written via shell, deleted, and recreated, reads must
  // see the latest version.
  describe('New Bug: Read cache invalidation', () => {

    it('readFileSync should see recreated file after delete', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        // Create, read, delete, recreate, read — second read must see new content
        'fs.writeFileSync("/tmp/cache-test.txt", "version-A");',
        'const v1 = fs.readFileSync("/tmp/cache-test.txt", "utf8");',
        'console.log("V1:" + v1);',
        // Delete via shell
        'await new Promise((res, rej) => cp.exec("rm /tmp/cache-test.txt", (e) => e ? rej(e) : res()));',
        // Recreate via shell with different content
        'await new Promise((res, rej) => cp.exec("echo version-B > /tmp/cache-test.txt", (e) => e ? rej(e) : res()));',
        // Read again — must see version-B
        'const v2 = fs.readFileSync("/tmp/cache-test.txt", "utf8");',
        'console.log("V2:" + v2.trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('V1:version-A');
      expect(ctx.stdout).toContain('V2:version-B');
    });

    it('multiple overwrites via shell should always show latest', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        'const execP = (cmd) => new Promise((res, rej) => cp.exec(cmd, (e) => e ? rej(e) : res()));',
        'await execP("echo round1 > /tmp/multi-overwrite.txt");',
        'console.log("R1:" + fs.readFileSync("/tmp/multi-overwrite.txt", "utf8").trim());',
        'await execP("echo round2 > /tmp/multi-overwrite.txt");',
        'console.log("R2:" + fs.readFileSync("/tmp/multi-overwrite.txt", "utf8").trim());',
        'await execP("echo round3 > /tmp/multi-overwrite.txt");',
        'console.log("R3:" + fs.readFileSync("/tmp/multi-overwrite.txt", "utf8").trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('R1:round1');
      expect(ctx.stdout).toContain('R2:round2');
      expect(ctx.stdout).toContain('R3:round3');
    });
  });
});
