import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('Commands', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  describe('ls', () => {
    it('should list files', async () => {
      await fs.writeFile('/home/user/a.txt', 'a');
      await fs.writeFile('/home/user/b.txt', 'b');
      const { output } = await run(shell, 'ls');
      expect(output).toContain('a.txt');
      expect(output).toContain('b.txt');
    });

    it('should show long format with -l', async () => {
      await fs.writeFile('/home/user/file.txt', 'content');
      const { output } = await run(shell, 'ls -l');
      expect(output).toContain('file.txt');
      expect(output).toContain('rw');
    });
  });

  describe('cat', () => {
    it('should read files', async () => {
      await fs.writeFile('/home/user/cat.txt', 'cat content');
      const { output } = await run(shell, 'cat cat.txt');
      expect(output).toContain('cat content');
    });
  });

  describe('mkdir and rmdir', () => {
    it('should create and remove directories', async () => {
      await run(shell, 'mkdir testdir');
      const stat = await fs.stat('/home/user/testdir');
      expect(stat.isDirectory()).toBe(true);
      await run(shell, 'rmdir testdir');
      await expect(fs.stat('/home/user/testdir')).rejects.toThrow();
    });

    it('should create nested directories with -p', async () => {
      await run(shell, 'mkdir -p a/b/c');
      const stat = await fs.stat('/home/user/a/b/c');
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('cp', () => {
    it('should copy files', async () => {
      await fs.writeFile('/home/user/src.txt', 'copy me');
      await run(shell, 'cp src.txt dst.txt');
      const content = await fs.readFile('/home/user/dst.txt', 'utf8');
      expect(content).toBe('copy me');
    });
  });

  describe('mv', () => {
    it('should move files', async () => {
      await fs.writeFile('/home/user/before.txt', 'move me');
      await run(shell, 'mv before.txt after.txt');
      const content = await fs.readFile('/home/user/after.txt', 'utf8');
      expect(content).toBe('move me');
      await expect(fs.stat('/home/user/before.txt')).rejects.toThrow();
    });
  });

  describe('rm', () => {
    it('should remove files', async () => {
      await fs.writeFile('/home/user/gone.txt', 'bye');
      await run(shell, 'rm gone.txt');
      await expect(fs.stat('/home/user/gone.txt')).rejects.toThrow();
    });

    it('should remove directories with -rf', async () => {
      await fs.mkdir('/home/user/gonedir');
      await fs.writeFile('/home/user/gonedir/file.txt', 'data');
      await run(shell, 'rm -rf gonedir');
      await expect(fs.stat('/home/user/gonedir')).rejects.toThrow();
    });
  });

  describe('grep', () => {
    it('should find patterns', async () => {
      await fs.writeFile('/home/user/grep.txt', 'hello world\nfoo bar\nhello again');
      const { output } = await run(shell, 'grep hello grep.txt');
      expect(output).toContain('hello world');
      expect(output).toContain('hello again');
      expect(output).not.toContain('foo bar');
    });

    it('should support -i flag', async () => {
      await fs.writeFile('/home/user/grepi.txt', 'Hello World\nfoo bar');
      const { output } = await run(shell, 'grep -i hello grepi.txt');
      expect(output).toContain('Hello World');
    });

    it('should support -n flag', async () => {
      await fs.writeFile('/home/user/grepn.txt', 'aaa\nbbb\nccc');
      const { output } = await run(shell, 'grep -n bbb grepn.txt');
      expect(output).toContain('2:');
    });

    it('should support -v flag', async () => {
      await fs.writeFile('/home/user/grepv.txt', 'keep\nremove\nkeep');
      const { output } = await run(shell, 'grep -v remove grepv.txt');
      expect(output).not.toContain('remove');
      expect(output).toContain('keep');
    });
  });

  describe('sed', () => {
    it('should substitute text', async () => {
      await fs.writeFile('/home/user/sed.txt', 'hello world');
      const { output } = await run(shell, "sed s/hello/goodbye/ sed.txt");
      expect(output).toContain('goodbye world');
    });

    it('should support global flag', async () => {
      await fs.writeFile('/home/user/sedg.txt', 'aaa');
      const { output } = await run(shell, "sed s/a/b/g sedg.txt");
      expect(output).toContain('bbb');
    });
  });

  describe('sort', () => {
    it('should sort lines', async () => {
      await fs.writeFile('/home/user/sort.txt', 'cherry\napple\nbanana\n');
      const { output } = await run(shell, 'sort sort.txt');
      const lines = output.replace(/\r/g, '').trim().split('\n');
      expect(lines).toEqual(['apple', 'banana', 'cherry']);
    });
  });

  describe('wc', () => {
    it('should count lines, words, chars', async () => {
      await fs.writeFile('/home/user/wc.txt', 'hello world\nfoo bar\n');
      const { output } = await run(shell, 'wc wc.txt');
      expect(output).toContain('2');
      expect(output).toContain('4');
    });
  });

  describe('head and tail', () => {
    it('head should show first lines', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
      await fs.writeFile('/home/user/head.txt', lines);
      const { output } = await run(shell, 'head -n 3 head.txt');
      expect(output).toContain('line1');
      expect(output).toContain('line3');
      expect(output).not.toContain('line4');
    });

    it('tail should show last lines', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
      await fs.writeFile('/home/user/tail.txt', lines);
      const { output } = await run(shell, 'tail -n 3 tail.txt');
      expect(output).toContain('line20');
      expect(output).toContain('line18');
    });
  });

  describe('find', () => {
    it('should find files by name', async () => {
      await fs.mkdir('/home/user/findtest', { recursive: true });
      await fs.writeFile('/home/user/findtest/hello.txt', 'hi');
      await fs.writeFile('/home/user/findtest/world.js', 'code');
      const { output } = await run(shell, "find findtest -name '*.txt'");
      expect(output).toContain('hello.txt');
      expect(output).not.toContain('world.js');
    });

    it('should filter by type', async () => {
      await fs.mkdir('/home/user/findtype');
      await fs.mkdir('/home/user/findtype/subdir');
      await fs.writeFile('/home/user/findtype/file.txt', 'data');
      const { output } = await run(shell, 'find findtype -type d');
      expect(output).toContain('subdir');
      expect(output).not.toContain('file.txt');
    });
  });

  describe('diff', () => {
    it('should show differences', async () => {
      await fs.writeFile('/home/user/a.txt', 'line1\nline2\nline3\n');
      await fs.writeFile('/home/user/b.txt', 'line1\nmodified\nline3\n');
      const { output, exitCode } = await run(shell, 'diff a.txt b.txt');
      expect(exitCode).toBe(1);
      expect(output).toContain('line2');
      expect(output).toContain('modified');
    });

    it('should return 0 for identical files', async () => {
      await fs.writeFile('/home/user/same1.txt', 'same content\n');
      await fs.writeFile('/home/user/same2.txt', 'same content\n');
      const { exitCode } = await run(shell, 'diff same1.txt same2.txt');
      expect(exitCode).toBe(0);
    });
  });

  describe('basename and dirname', () => {
    it('basename strips directory', async () => {
      const { output } = await run(shell, 'echo /foo/bar/baz.txt | xargs basename');
    });

    it('basename works directly', async () => {
      const { output } = await run(shell, 'basename /foo/bar/file.txt');
      expect(output.replace(/\r/g, '').trim()).toBe('file.txt');
    });

    it('dirname strips filename', async () => {
      const { output } = await run(shell, 'dirname /foo/bar/file.txt');
      expect(output.replace(/\r/g, '').trim()).toBe('/foo/bar');
    });
  });

  describe('tr', () => {
    it('should translate characters', async () => {
      await run(shell, 'echo hello > /home/user/tr.txt');
      const { output } = await run(shell, 'cat tr.txt | tr a-z A-Z');
      expect(output.replace(/\r/g, '').trim()).toBe('HELLO');
    });

    it('should delete characters with -d', async () => {
      await run(shell, 'echo hello > /home/user/trd.txt');
      const { output } = await run(shell, 'cat trd.txt | tr -d l');
      expect(output.replace(/\r/g, '').trim()).toBe('heo');
    });
  });

  describe('cut', () => {
    it('should cut fields', async () => {
      await fs.writeFile('/home/user/cut.txt', 'a:b:c\n1:2:3\n');
      const { output } = await run(shell, 'cut -d: -f2 cut.txt');
      expect(output).toContain('b');
      expect(output).toContain('2');
    });
  });

  describe('glob', () => {
    it('should match files by pattern', async () => {
      await fs.mkdir('/home/user/globtest', { recursive: true });
      await fs.writeFile('/home/user/globtest/app.ts', 'code');
      await fs.writeFile('/home/user/globtest/util.ts', 'code');
      await fs.writeFile('/home/user/globtest/readme.md', 'docs');
      await run(shell, 'cd /home/user/globtest');
      const { output } = await run(shell, "glob '*.ts'");
      expect(output).toContain('app.ts');
      expect(output).toContain('util.ts');
      expect(output).not.toContain('readme.md');
    });

    it('should match with ** pattern', async () => {
      await fs.mkdir('/home/user/globdeep/sub', { recursive: true });
      await fs.writeFile('/home/user/globdeep/a.ts', 'a');
      await fs.writeFile('/home/user/globdeep/sub/b.ts', 'b');
      await run(shell, 'cd /home/user/globdeep');
      const { output } = await run(shell, "glob '**/*.ts'");
      expect(output).toContain('b.ts');
    });
  });

  describe('js-eval', () => {
    it('should evaluate expressions', async () => {
      const { output } = await run(shell, 'js-eval 1 + 2');
      expect(output.replace(/\r/g, '').trim()).toBe('3');
    });

    it('should evaluate string expressions', async () => {
      const { output } = await run(shell, "js-eval '\"hello\".toUpperCase()'");
      expect(output).toContain('HELLO');
    });

    it('should return error for invalid code', async () => {
      const { exitCode } = await run(shell, 'js-eval throw new Error("fail")');
      expect(exitCode).toBe(1);
    });
  });

  describe('node', () => {
    it('should execute JS file', async () => {
      await fs.writeFile('/home/user/test.js', 'console.log("from file")');
      const { output } = await run(shell, 'node test.js');
      expect(output).toContain('from file');
    });

    it('should execute -e code', async () => {
      const { output } = await run(shell, "node -e 'console.log(2 + 3)'");
      expect(output).toContain('5');
    });

    it('should print with -p', async () => {
      const { output } = await run(shell, "node -p '42 * 2'");
      expect(output).toContain('84');
    });

    it('should have process.env', async () => {
      await run(shell, 'export MY_VAR=testing');
      await fs.writeFile('/home/user/envtest.js', 'console.log(process.env.MY_VAR)');
      const { output } = await run(shell, 'node envtest.js');
      expect(output).toContain('testing');
    });
  });

  describe('seq', () => {
    it('should generate a sequence', async () => {
      const { output } = await run(shell, 'seq 5');
      const lines = output.replace(/\r/g, '').trim().split('\n');
      expect(lines).toEqual(['1', '2', '3', '4', '5']);
    });

    it('should support start and end', async () => {
      const { output } = await run(shell, 'seq 3 6');
      const lines = output.replace(/\r/g, '').trim().split('\n');
      expect(lines).toEqual(['3', '4', '5', '6']);
    });
  });

  describe('which', () => {
    it('should find built-in commands', async () => {
      const { output, exitCode } = await run(shell, 'which echo');
      expect(exitCode).toBe(0);
      // which outputs just the command name (type says "shell builtin")
      expect(output).toContain('echo');
    });

    it('should report missing commands', async () => {
      const { exitCode } = await run(shell, 'which nonexistent');
      expect(exitCode).toBe(1);
    });
  });

  describe('test', () => {
    it('should test file existence', async () => {
      await fs.writeFile('/home/user/exists.txt', 'data');
      const { exitCode: e1 } = await run(shell, 'test -e exists.txt');
      expect(e1).toBe(0);
      const { exitCode: e2 } = await run(shell, 'test -e nofile.txt');
      expect(e2).toBe(1);
    });

    it('should test directory', async () => {
      await fs.mkdir('/home/user/testdir2');
      const { exitCode } = await run(shell, 'test -d testdir2');
      expect(exitCode).toBe(0);
    });

    it('should compare strings', async () => {
      const { exitCode: e1 } = await run(shell, 'test foo = foo');
      expect(e1).toBe(0);
      const { exitCode: e2 } = await run(shell, 'test foo = bar');
      expect(e2).toBe(1);
    });
  });

  describe('ln', () => {
    it('should create symbolic links', async () => {
      await fs.writeFile('/home/user/linktest.txt', 'linked data');
      await run(shell, 'ln -s /home/user/linktest.txt /home/user/mylink');
      const target = await fs.readlink('/home/user/mylink');
      expect(target).toBe('/home/user/linktest.txt');
    });
  });

  describe('system commands', () => {
    it('whoami returns user', async () => {
      const { output } = await run(shell, 'whoami');
      expect(output.replace(/\r/g, '').trim()).toBe('user');
    });

    it('hostname returns shiro', async () => {
      const { output } = await run(shell, 'hostname');
      expect(output.replace(/\r/g, '').trim()).toBe('shiro');
    });

    it('uname returns Shiro', async () => {
      const { output } = await run(shell, 'uname');
      expect(output.replace(/\r/g, '').trim()).toBe('Shiro');
    });

    it('date returns a date string', async () => {
      const { output } = await run(shell, 'date');
      expect(output.length).toBeGreaterThan(10);
    });
  });
});
