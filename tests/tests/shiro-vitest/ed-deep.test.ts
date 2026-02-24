/**
 * Deep tests for the ed line editor.
 *
 * Covers all ed commands: a(ppend), i(nsert), c(hange), d(elete),
 * p(rint), n(umber), s(ubstitute), w(rite), r(ead), e(dit), q(uit),
 * = (line count), wq, range addressing, regex addressing, and %-range.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('ed line editor (deep)', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ─── File Loading ──────────────────────────────────────────────

  describe('file loading', () => {
    it('should report byte count when opening a file', async () => {
      await fs.writeFile('/tmp/ed-file.txt', 'hello world\n');
      const { output } = await run(shell, 'echo "q" | ed /tmp/ed-file.txt');
      expect(output).toMatch(/12/); // "hello world\n" = 12 bytes
    });

    it('should report error for nonexistent file', async () => {
      const { output } = await run(shell, 'echo "q" | ed /tmp/nonexistent.txt');
      expect(output).toContain('No such file');
    });

    it('should work with empty stdin (no commands)', async () => {
      await fs.writeFile('/tmp/ed-empty.txt', 'content\n');
      const { exitCode } = await run(shell, 'echo "" | ed /tmp/ed-empty.txt');
      expect(exitCode).toBe(0);
    });
  });

  // ─── Append (a) ────────────────────────────────────────────────

  describe('append (a)', () => {
    it('should append lines to empty buffer', async () => {
      const { exitCode } = await run(shell, 'echo "a\nline1\nline2\n.\nw /tmp/ed-append.txt\nq" | ed');
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/ed-append.txt', 'utf8');
      expect(content).toContain('line1');
      expect(content).toContain('line2');
    });

    it('should append after current line', async () => {
      await fs.writeFile('/tmp/ed-append2.txt', 'first\nthird\n');
      await run(shell, 'echo "1\na\nsecond\n.\nw\nq" | ed /tmp/ed-append2.txt');
      const content = await fs.readFile('/tmp/ed-append2.txt', 'utf8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toEqual(['first', 'second', 'third']);
    });
  });

  // ─── Insert (i) ────────────────────────────────────────────────

  describe('insert (i)', () => {
    it('should insert before current line', async () => {
      await fs.writeFile('/tmp/ed-insert.txt', 'second\nthird\n');
      await run(shell, 'echo "1\ni\nfirst\n.\nw\nq" | ed /tmp/ed-insert.txt');
      const content = await fs.readFile('/tmp/ed-insert.txt', 'utf8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines[0]).toBe('first');
      expect(lines[1]).toBe('second');
    });
  });

  // ─── Change (c) ────────────────────────────────────────────────

  describe('change (c)', () => {
    it('should replace current line', async () => {
      await fs.writeFile('/tmp/ed-change.txt', 'old line\n');
      await run(shell, 'echo "1\nc\nnew line\n.\nw\nq" | ed /tmp/ed-change.txt');
      const content = await fs.readFile('/tmp/ed-change.txt', 'utf8');
      expect(content).toContain('new line');
      expect(content).not.toContain('old line');
    });

    it('should replace a range of lines', async () => {
      await fs.writeFile('/tmp/ed-crange.txt', 'keep\nreplace1\nreplace2\nkeep2\n');
      await run(shell, 'echo "2,3c\nnew content\n.\nw\nq" | ed /tmp/ed-crange.txt');
      const content = await fs.readFile('/tmp/ed-crange.txt', 'utf8');
      expect(content).toContain('keep');
      expect(content).toContain('new content');
      expect(content).toContain('keep2');
      expect(content).not.toContain('replace1');
    });
  });

  // ─── Delete (d) ────────────────────────────────────────────────

  describe('delete (d)', () => {
    it('should delete a specific line', async () => {
      await fs.writeFile('/tmp/ed-del.txt', 'a\nb\nc\n');
      await run(shell, 'echo "2d\nw\nq" | ed /tmp/ed-del.txt');
      const content = await fs.readFile('/tmp/ed-del.txt', 'utf8');
      expect(content).not.toContain('b');
      expect(content).toContain('a');
      expect(content).toContain('c');
    });

    it('should delete a range of lines', async () => {
      await fs.writeFile('/tmp/ed-delr.txt', 'a\nb\nc\nd\n');
      await run(shell, 'echo "2,3d\nw\nq" | ed /tmp/ed-delr.txt');
      const content = await fs.readFile('/tmp/ed-delr.txt', 'utf8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toEqual(['a', 'd']);
    });
  });

  // ─── Print (p) & Number (n) ────────────────────────────────────

  describe('print (p) and number (n)', () => {
    it('p should print specified lines', async () => {
      await fs.writeFile('/tmp/ed-print.txt', 'alpha\nbeta\ngamma\n');
      const { output } = await run(shell, 'echo "1,2p\nq" | ed /tmp/ed-print.txt');
      expect(output).toContain('alpha');
      expect(output).toContain('beta');
    });

    it('n should print with line numbers', async () => {
      await fs.writeFile('/tmp/ed-num.txt', 'one\ntwo\nthree\n');
      const { output } = await run(shell, 'echo "1,3n\nq" | ed /tmp/ed-num.txt');
      expect(output).toContain('1\t');
      expect(output).toContain('2\t');
      expect(output).toContain('3\t');
    });
  });

  // ─── Substitute (s) ───────────────────────────────────────────

  describe('substitute (s)', () => {
    it('should substitute first occurrence', async () => {
      await fs.writeFile('/tmp/ed-sub.txt', 'hello hello\n');
      await run(shell, 'echo "1s/hello/world/\nw\nq" | ed /tmp/ed-sub.txt');
      const content = await fs.readFile('/tmp/ed-sub.txt', 'utf8');
      expect(content).toBe('world hello\n');
    });

    it('should substitute globally with g flag', async () => {
      await fs.writeFile('/tmp/ed-subg.txt', 'aaa\n');
      await run(shell, 'echo "1s/a/b/g\nw\nq" | ed /tmp/ed-subg.txt');
      const content = await fs.readFile('/tmp/ed-subg.txt', 'utf8');
      expect(content).toBe('bbb\n');
    });

    it('should substitute across a range', async () => {
      await fs.writeFile('/tmp/ed-subr.txt', 'foo\nfoo\nbar\n');
      await run(shell, 'echo "1,2s/foo/baz/\nw\nq" | ed /tmp/ed-subr.txt');
      const content = await fs.readFile('/tmp/ed-subr.txt', 'utf8');
      expect(content).toBe('baz\nbaz\nbar\n');
    });
  });

  // ─── Write (w) & Quit (q) ─────────────────────────────────────

  describe('write & quit', () => {
    it('w should report byte count', async () => {
      const { output } = await run(shell, 'echo "a\nhello\n.\nw /tmp/ed-wcount.txt\nq" | ed');
      expect(output).toMatch(/\d+/);
    });

    it('wq should write and quit', async () => {
      await fs.writeFile('/tmp/ed-wq.txt', 'original\n');
      const { exitCode } = await run(shell, 'echo "1c\ndata\n.\nwq" | ed /tmp/ed-wq.txt');
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/ed-wq.txt', 'utf8');
      expect(content).toContain('data');
    });

    it('wq with explicit filename should write to that file', async () => {
      const { exitCode } = await run(shell, 'echo "a\nhello\n.\nwq /tmp/wq-new.txt" | ed');
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/wq-new.txt', 'utf8');
      expect(content).toContain('hello');
    });

    it('w without filename should error', async () => {
      const { output } = await run(shell, 'echo "a\ntest\n.\nw\nq" | ed');
      expect(output).toContain('?');
    });
  });

  // ─── Read (r) ──────────────────────────────────────────────────

  describe('read (r)', () => {
    it('should read file into buffer at current position', async () => {
      await fs.writeFile('/tmp/ed-rfrom.txt', 'inserted line\n');
      await fs.writeFile('/tmp/ed-rinto.txt', 'before\n');
      await run(shell, 'echo "r /tmp/ed-rfrom.txt\nw\nq" | ed /tmp/ed-rinto.txt');
      const content = await fs.readFile('/tmp/ed-rinto.txt', 'utf8');
      expect(content).toContain('before');
      expect(content).toContain('inserted line');
    });

    it('should error on reading nonexistent file', async () => {
      const { output } = await run(shell, 'echo "r /tmp/nonexistent\nq" | ed');
      expect(output).toContain('No such file');
    });
  });

  // ─── Edit (e) ──────────────────────────────────────────────────

  describe('edit (e)', () => {
    it('should load a new file into buffer', async () => {
      await fs.writeFile('/tmp/ed-efile.txt', 'new file content\n');
      const { output } = await run(shell, 'echo "e /tmp/ed-efile.txt\n1p\nq" | ed');
      expect(output).toContain('new file content');
    });
  });

  // ─── Line Count (=) ───────────────────────────────────────────

  describe('line count (=)', () => {
    it('should print total line count', async () => {
      await fs.writeFile('/tmp/ed-count.txt', 'a\nb\nc\nd\ne\n');
      const { output } = await run(shell, 'echo "=\nq" | ed /tmp/ed-count.txt');
      expect(output).toContain('5');
    });
  });

  // ─── Range Addressing ─────────────────────────────────────────

  describe('range addressing', () => {
    it('should handle $ (last line)', async () => {
      await fs.writeFile('/tmp/ed-addr.txt', 'first\nsecond\nthird\n');
      // Use single quotes to prevent shell $p expansion
      const { edCmd } = await import('@shiro/commands/ed');
      const ctx = {
        args: ['/tmp/ed-addr.txt'],
        fs, cwd: '/home/user', env: {},
        stdin: '$p\nq\n', stdout: '', stderr: '', shell,
      };
      await edCmd.exec(ctx);
      expect(ctx.stdout).toContain('third');
    });

    it('should handle % (all lines)', async () => {
      await fs.writeFile('/tmp/ed-pct.txt', 'a\nb\nc\n');
      await run(shell, 'echo "%s/./x/\nw\nq" | ed /tmp/ed-pct.txt');
      const content = await fs.readFile('/tmp/ed-pct.txt', 'utf8');
      // Each line's first char replaced with x
      expect(content).toBe('x\nx\nx\n');
    });

    it('bare number should navigate and print', async () => {
      await fs.writeFile('/tmp/ed-nav.txt', 'one\ntwo\nthree\n');
      const { output } = await run(shell, 'echo "2\nq" | ed /tmp/ed-nav.txt');
      expect(output).toContain('two');
    });
  });

  // ─── Regex Addressing ─────────────────────────────────────────

  describe('regex addressing', () => {
    it('should find line by regex', async () => {
      await fs.writeFile('/tmp/ed-regex.txt', 'apple\nbanana\ncherry\n');
      const { output } = await run(shell, 'echo "/banana/p\nq" | ed /tmp/ed-regex.txt');
      expect(output).toContain('banana');
    });
  });

  // ─── Multiple Operations ──────────────────────────────────────

  describe('multi-step editing', () => {
    it('should handle create, edit, and save workflow', async () => {
      const cmds = [
        'a',        // append mode
        'line 1',
        'line 2',
        'line 3',
        '.',         // end append
        '2d',        // delete line 2
        'a',         // append after current (now line 1)
        'new line 2',
        '.',
        'w /tmp/ed-multi.txt',
        'q',
      ].join('\n');
      await run(shell, `echo "${cmds}" | ed`);
      const content = await fs.readFile('/tmp/ed-multi.txt', 'utf8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toContain('line 1');
      expect(lines).toContain('new line 2');
      expect(lines).toContain('line 3');
      expect(lines).not.toContain('line 2');
    });
  });
});
