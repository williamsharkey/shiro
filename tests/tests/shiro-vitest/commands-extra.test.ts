import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('Extra Commands (Batch 1)', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // --- rev ---
  describe('rev', () => {
    it('should reverse a simple line', async () => {
      const { output } = await run(shell, 'echo hello | rev');
      expect(output.trim()).toBe('olleh');
    });

    it('should reverse multiple lines', async () => {
      await fs.writeFile('/home/user/rev.txt', 'abc\nxyz\n');
      const { output } = await run(shell, 'rev rev.txt');
      const clean = output.replace(/\r/g, '');
      expect(clean).toBe('cba\nzyx\n');
    });

    it('should handle empty input', async () => {
      const { output, exitCode } = await run(shell, 'echo -n "" | rev');
      expect(exitCode).toBe(0);
    });
  });

  // --- tac ---
  describe('tac', () => {
    it('should reverse line order', async () => {
      await fs.writeFile('/home/user/tac.txt', 'first\nsecond\nthird\n');
      const { output } = await run(shell, 'tac tac.txt');
      const clean = output.replace(/\r/g, '');
      expect(clean).toBe('third\nsecond\nfirst\n');
    });

    it('should work with stdin via echo', async () => {
      await fs.writeFile('/home/user/tac2.txt', 'x\ny\nz\n');
      const { output } = await run(shell, 'cat tac2.txt | tac');
      const clean = output.replace(/\r/g, '');
      expect(clean).toBe('z\ny\nx\n');
    });
  });

  // --- shuf ---
  describe('shuf', () => {
    it('should output same lines as input (just reordered)', async () => {
      await fs.writeFile('/home/user/shuf.txt', 'a\nb\nc\nd\ne\n');
      const { output } = await run(shell, 'shuf shuf.txt');
      const lines = output.replace(/\r/g, '').trim().split('\n').sort();
      expect(lines).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('should limit output with -n', async () => {
      const { output } = await run(shell, 'shuf -i 1-100 -n 5');
      const lines = output.trim().split('\n');
      expect(lines.length).toBe(5);
    });

    it('should generate range with -i', async () => {
      const { output } = await run(shell, 'shuf -i 1-5');
      const lines = output.trim().split('\n').map(Number).sort((a, b) => a - b);
      expect(lines).toEqual([1, 2, 3, 4, 5]);
    });

    it('should shuffle args with -e', async () => {
      const { output } = await run(shell, 'shuf -e alpha beta gamma');
      const lines = output.replace(/\r/g, '').trim().split('\n').sort();
      expect(lines).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  // --- cmp ---
  describe('cmp', () => {
    it('should return 0 for identical files', async () => {
      await fs.writeFile('/home/user/a.txt', 'same content');
      await fs.writeFile('/home/user/b.txt', 'same content');
      const { exitCode } = await run(shell, 'cmp a.txt b.txt');
      expect(exitCode).toBe(0);
    });

    it('should return 1 for different files', async () => {
      await fs.writeFile('/home/user/a.txt', 'hello');
      await fs.writeFile('/home/user/b.txt', 'world');
      const { exitCode, output } = await run(shell, 'cmp a.txt b.txt');
      expect(exitCode).toBe(1);
      expect(output).toContain('differ');
    });

    it('should be silent with -s', async () => {
      await fs.writeFile('/home/user/a.txt', 'aaa');
      await fs.writeFile('/home/user/b.txt', 'bbb');
      const { exitCode, output } = await run(shell, 'cmp -s a.txt b.txt');
      expect(exitCode).toBe(1);
      expect(output).toBe('');
    });

    it('should list all differences with -l', async () => {
      await fs.writeFile('/home/user/a.txt', 'abc');
      await fs.writeFile('/home/user/b.txt', 'axc');
      const { output } = await run(shell, 'cmp -l a.txt b.txt');
      expect(output).toContain('2'); // byte 2 differs
    });
  });

  // --- dd ---
  describe('dd', () => {
    it('should copy stdin to stdout', async () => {
      const { output } = await run(shell, 'echo hello | dd 2>/dev/null');
      expect(output.trim()).toBe('hello');
    });

    it('should copy file with if=/of=', async () => {
      await fs.writeFile('/home/user/dd-in.txt', 'dd data here');
      await run(shell, 'dd if=dd-in.txt of=dd-out.txt');
      const content = await fs.readFile('/home/user/dd-out.txt', 'utf8');
      expect(content).toBe('dd data here');
    });

    it('should respect bs and count', async () => {
      await fs.writeFile('/home/user/dd-big.txt', 'abcdefghijklmnop');
      await run(shell, 'dd if=dd-big.txt of=dd-small.txt bs=4 count=2');
      const content = await fs.readFile('/home/user/dd-small.txt', 'utf8');
      expect(content).toBe('abcdefgh');
    });

    it('should support conv=ucase', async () => {
      const { output } = await run(shell, 'echo hello | dd conv=ucase 2>/dev/null');
      expect(output.trim()).toBe('HELLO');
    });
  });

  // --- xxd ---
  describe('xxd', () => {
    it('should produce hex dump', async () => {
      const { output } = await run(shell, 'echo -n "AB" | xxd');
      expect(output).toContain('4142');
    });

    it('should produce plain hex with -p', async () => {
      const { output } = await run(shell, 'echo -n "Hi" | xxd -p');
      expect(output.trim()).toBe('4869');
    });

    it('should reverse hex dump with -r -p', async () => {
      const { output } = await run(shell, 'echo 48656c6c6f | xxd -r -p');
      expect(output).toBe('Hello');
    });

    it('should limit output with -l', async () => {
      const { output } = await run(shell, 'echo -n "ABCDEF" | xxd -p -l 3');
      expect(output.trim()).toBe('414243');
    });
  });

  // --- dc ---
  describe('dc', () => {
    it('should do basic addition', async () => {
      const { output } = await run(shell, 'echo "3 5 + p" | dc');
      expect(output.trim()).toBe('8');
    });

    it('should do multiplication', async () => {
      const { output } = await run(shell, 'echo "4 7 * p" | dc');
      expect(output.trim()).toBe('28');
    });

    it('should handle stack operations', async () => {
      const { output } = await run(shell, 'echo "10 20 r p" | dc');
      // r swaps, so top should be 10
      expect(output.trim()).toBe('10');
    });

    it('should use registers', async () => {
      const { output } = await run(shell, 'echo "42 sa la p" | dc');
      expect(output.trim()).toBe('42');
    });

    it('should handle integer division', async () => {
      const { output } = await run(shell, 'echo "7 2 / p" | dc');
      expect(output.trim()).toBe('3');
    });
  });

  // --- split ---
  describe('split', () => {
    it('should split by lines (default 1000)', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n';
      await fs.writeFile('/home/user/split-in.txt', lines);
      await run(shell, 'split -l 5 split-in.txt chunk');
      const chunk1 = await fs.readFile('/home/user/chunkaa', 'utf8');
      const chunk2 = await fs.readFile('/home/user/chunkab', 'utf8');
      expect(chunk1).toContain('line0');
      expect(chunk2).toContain('line5');
    });

    it('should split by bytes with -b', async () => {
      await fs.writeFile('/home/user/split-b.txt', 'abcdefghij');
      await run(shell, 'split -b 4 split-b.txt part');
      const p1 = await fs.readFile('/home/user/partaa', 'utf8');
      const p2 = await fs.readFile('/home/user/partab', 'utf8');
      const p3 = await fs.readFile('/home/user/partac', 'utf8');
      expect(p1).toBe('abcd');
      expect(p2).toBe('efgh');
      expect(p3).toBe('ij');
    });

    it('should use default prefix x', async () => {
      await fs.writeFile('/home/user/sp.txt', 'data');
      await run(shell, 'split -b 100 sp.txt');
      const content = await fs.readFile('/home/user/xaa', 'utf8');
      expect(content).toBe('data');
    });
  });
});
