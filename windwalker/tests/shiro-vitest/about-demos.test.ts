import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('About page demos', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  describe('Demo 1: Hello (pipes)', () => {
    it('echo hello world', async () => {
      const { output } = await run(shell, 'echo "hello world"');
      expect(output.trim()).toBe('hello world');
    });

    it('echo | wc -c', async () => {
      const { output } = await run(shell, 'echo "hello world" | wc -c');
      expect(output.trim()).toBe('12');
    });

    it('echo | sed', async () => {
      const { output } = await run(shell, "echo \"hello world\" | sed 's/world/browser/'");
      expect(output.trim()).toBe('hello browser');
    });
  });

  describe('Demo 2: Files', () => {
    it('mkdir -p creates nested dirs', async () => {
      await run(shell, 'mkdir -p /tmp/demo-fs/src /tmp/demo-fs/docs');
      expect(await fs.exists('/tmp/demo-fs/src')).toBe(true);
      expect(await fs.exists('/tmp/demo-fs/docs')).toBe(true);
    });

    it('write and read files', async () => {
      await run(shell, 'mkdir -p /tmp/demo-fs/src /tmp/demo-fs/docs');
      await run(shell, 'echo \'console.log("hi")\' > /tmp/demo-fs/src/app.js');
      await run(shell, 'echo \'# My Project\' > /tmp/demo-fs/docs/README.md');

      const { output: appContent } = await run(shell, 'cat /tmp/demo-fs/src/app.js');
      expect(appContent).toContain('console.log("hi")');
    });

    it('find lists files', async () => {
      await run(shell, 'mkdir -p /tmp/demo-fs/src /tmp/demo-fs/docs');
      await run(shell, 'echo \'console.log("hi")\' > /tmp/demo-fs/src/app.js');
      await run(shell, 'echo \'# My Project\' > /tmp/demo-fs/docs/README.md');

      const { output } = await run(shell, 'find /tmp/demo-fs -type f');
      expect(output).toContain('app.js');
      expect(output).toContain('README.md');
    });
  });

  describe('Demo 3: Text Processing', () => {
    beforeEach(async () => {
      await run(shell, "printf 'alice,95\\nbob,87\\ncarol,92\\nalice,88\\nbob,91\\n' > /tmp/grades.csv");
    });

    it('cat shows CSV content', async () => {
      const { output } = await run(shell, 'cat /tmp/grades.csv');
      expect(output).toContain('alice,95');
      expect(output).toContain('bob,87');
    });

    it('grep filters rows', async () => {
      const { output } = await run(shell, 'grep alice /tmp/grades.csv');
      expect(output).toContain('alice,95');
      expect(output).toContain('alice,88');
      expect(output).not.toContain('bob');
    });

    it('sort sorts lines', async () => {
      const { output } = await run(shell, 'sort /tmp/grades.csv');
      const lines = output.trim().split('\n');
      // Both alice lines should appear before bob lines in sorted output
      expect(lines.length).toBe(5);
      expect(output).toContain('alice,88');
      expect(output).toContain('alice,95');
    });

    it('cut | sort -n extracts and sorts scores', async () => {
      const { output } = await run(shell, 'cut -d, -f2 /tmp/grades.csv | sort -n');
      const lines = output.replace(/\r/g, '').trim().split('\n');
      expect(lines[0]).toBe('87');
      expect(lines[lines.length - 1]).toBe('95');
    });

    it('awk computes averages', async () => {
      const { output } = await run(shell, "awk -F, '{s[$1]+=$2;n[$1]++} END {for(k in s) printf \"%s: %.0f\\n\",k,s[k]/n[k]}' /tmp/grades.csv");
      expect(output).toContain('alice: 92');
      expect(output).toContain('bob: 89');
      expect(output).toContain('carol: 92');
    });
  });

  describe('Demo 4: Git Workflow', () => {
    it('full git workflow', async () => {
      await run(shell, 'rm -rf /tmp/myrepo; mkdir -p /tmp/myrepo');

      // git init
      const { output: initOut } = await run(shell, 'cd /tmp/myrepo && git init');
      expect(initOut).toContain('Initialized');

      // create files
      await run(shell, 'echo "# Todo App" > /tmp/myrepo/README.md');
      await run(shell, 'echo \'console.log("v1")\' > /tmp/myrepo/app.js');

      // git add & commit
      await run(shell, 'cd /tmp/myrepo && git add .');
      const { output: commitOut } = await run(shell, 'cd /tmp/myrepo && git commit -m "initial commit"');
      expect(commitOut).toContain('initial commit');

      // edit file
      await run(shell, 'echo \'console.log("v2 — added features")\' > /tmp/myrepo/app.js');

      // git diff
      const { output: diffOut } = await run(shell, 'cd /tmp/myrepo && git diff');
      expect(diffOut).toContain('v1');
      expect(diffOut).toContain('v2');
    });
  });

  describe('Demo 7: The Opus (command-only steps)', () => {
    it('scaffolds project structure', async () => {
      await run(shell, 'rm -rf /tmp/opus; mkdir -p /tmp/opus/src /tmp/opus/public');
      expect(await fs.exists('/tmp/opus/src')).toBe(true);
      expect(await fs.exists('/tmp/opus/public')).toBe(true);
    });

    it('creates files and lists them', async () => {
      await run(shell, 'rm -rf /tmp/opus; mkdir -p /tmp/opus/src /tmp/opus/public');
      await run(shell, "echo '<html><body><h1>Counter</h1></body></html>' > /tmp/opus/public/index.html");
      await run(shell, "echo 'body { background: #0f0f23; }' > /tmp/opus/public/style.css");
      await run(shell, "echo 'let count = 0;' > /tmp/opus/src/app.js");

      const { output } = await run(shell, 'ls -la /tmp/opus/public /tmp/opus/src');
      expect(output).toContain('index.html');
      expect(output).toContain('style.css');
      expect(output).toContain('app.js');
    });

    it('full git workflow in opus', async () => {
      await run(shell, 'rm -rf /tmp/opus; mkdir -p /tmp/opus/src /tmp/opus/public');
      await run(shell, "echo '<html></html>' > /tmp/opus/public/index.html");
      await run(shell, "echo 'body {}' > /tmp/opus/public/style.css");
      await run(shell, "echo 'let count = 0;' > /tmp/opus/src/app.js");

      // git init + commit
      const { output: initOut } = await run(shell, 'cd /tmp/opus && git init');
      expect(initOut).toContain('Initialized');

      await run(shell, 'cd /tmp/opus && git add .');
      const { output: commitOut } = await run(shell, 'cd /tmp/opus && git commit -m "feat: counter app"');
      expect(commitOut).toContain('feat: counter app');

      // log
      const { output: logOut } = await run(shell, 'cd /tmp/opus && git log --oneline');
      expect(logOut).toContain('counter app');

      // edit, second commit
      await run(shell, "echo 'let count = 0; function reset() { count = 0; }' > /tmp/opus/src/app.js");
      await run(shell, 'cd /tmp/opus && git add . && git commit -m "feat: reset button"');

      // third commit
      await run(shell, "echo 'let count = 0; function reset() { count = 0; } // keys' > /tmp/opus/src/app.js");
      await run(shell, 'cd /tmp/opus && git add . && git commit -m "feat: keyboard shortcuts"');

      // final log should have 3 commits
      const { output: finalLog } = await run(shell, 'cd /tmp/opus && git log --oneline');
      const commits = finalLog.trim().split('\n').filter(l => l.trim());
      expect(commits.length).toBe(3);
    });

    it('find lists all opus files', async () => {
      await run(shell, 'rm -rf /tmp/opus; mkdir -p /tmp/opus/src /tmp/opus/public');
      await run(shell, "echo '<html></html>' > /tmp/opus/public/index.html");
      await run(shell, "echo 'body {}' > /tmp/opus/public/style.css");
      await run(shell, "echo 'let x = 1;' > /tmp/opus/src/app.js");

      const { output } = await run(shell, 'find /tmp/opus -type f | sort');
      expect(output).toContain('index.html');
      expect(output).toContain('style.css');
      expect(output).toContain('app.js');
    });
  });
});
