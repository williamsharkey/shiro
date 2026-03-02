/**
 * Batch 2 commands: factor, cksum, base32, numfmt, csplit, nice
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  const env = await createTestShell();
  shell = env.shell;
  fs = env.fs;
});

describe('factor', () => {
  it('factors 12 into 2 2 3', async () => {
    const { output } = await run(shell, 'factor 12');
    expect(output.replace(/\r/g, '').trim()).toBe('12: 2 2 3');
  });

  it('factors 1 (no factors)', async () => {
    const { output } = await run(shell, 'factor 1');
    expect(output.replace(/\r/g, '').trim()).toBe('1:');
  });

  it('factors 0 (no factors)', async () => {
    const { output } = await run(shell, 'factor 0');
    expect(output.replace(/\r/g, '').trim()).toBe('0:');
  });

  it('factors a prime number', async () => {
    const { output } = await run(shell, 'factor 17');
    expect(output.replace(/\r/g, '').trim()).toBe('17: 17');
  });

  it('factors multiple args', async () => {
    const { output } = await run(shell, 'factor 6 15');
    const lines = output.replace(/\r/g, '').trim().split('\n');
    expect(lines[0]).toBe('6: 2 3');
    expect(lines[1]).toBe('15: 3 5');
  });

  it('factors from stdin', async () => {
    const { output } = await run(shell, 'echo 100 | factor');
    expect(output.replace(/\r/g, '')).toContain('100: 2 2 5 5');
  });

  it('returns exit 1 for invalid input', async () => {
    const { exitCode } = await run(shell, 'factor abc');
    expect(exitCode).toBe(1);
  });

  it('factors large composite', async () => {
    const { output } = await run(shell, 'factor 12345678');
    expect(output.replace(/\r/g, '').trim()).toBe('12345678: 2 3 3 47 14593');
  });
});

describe('cksum', () => {
  it('checksums empty input from stdin', async () => {
    const { output } = await run(shell, 'echo -n "" | cksum');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toMatch(/^\d+ 0$/);
  });

  it('checksums a known string', async () => {
    const { output } = await run(shell, 'echo -n "hello" | cksum');
    const clean = output.replace(/\r/g, '').trim();
    const parts = clean.split(' ');
    expect(parts.length).toBe(2);
    expect(parseInt(parts[1])).toBe(5);
  });

  it('checksums a file with filename in output', async () => {
    await fs.writeFile('/home/user/ck.txt', 'test data');
    const { output } = await run(shell, 'cksum ck.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toContain('ck.txt');
    const parts = clean.split(/\s+/);
    expect(parts.length).toBe(3);
    expect(parseInt(parts[1])).toBe(9);
  });

  it('checksums multiple files', async () => {
    await fs.writeFile('/home/user/a.txt', 'aaa');
    await fs.writeFile('/home/user/b.txt', 'bbb');
    const { output } = await run(shell, 'cksum a.txt b.txt');
    const lines = output.replace(/\r/g, '').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('a.txt');
    expect(lines[1]).toContain('b.txt');
  });
});

describe('base32', () => {
  it('encodes empty string', async () => {
    const { output } = await run(shell, 'echo -n "" | base32');
    expect(output.replace(/\r/g, '').trim()).toBe('');
  });

  it('encodes "f" correctly', async () => {
    const { output } = await run(shell, 'echo -n "f" | base32');
    expect(output.replace(/\r/g, '').trim()).toBe('MY======');
  });

  it('encodes "fo" correctly', async () => {
    const { output } = await run(shell, 'echo -n "fo" | base32');
    expect(output.replace(/\r/g, '').trim()).toBe('MZXQ====');
  });

  it('encodes "foo" correctly', async () => {
    const { output } = await run(shell, 'echo -n "foo" | base32');
    expect(output.replace(/\r/g, '').trim()).toBe('MZXW6===');
  });

  it('encodes "foob" correctly', async () => {
    const { output } = await run(shell, 'echo -n "foob" | base32');
    expect(output.replace(/\r/g, '').trim()).toBe('MZXW6YQ=');
  });

  it('encodes "fooba" correctly', async () => {
    const { output } = await run(shell, 'echo -n "fooba" | base32');
    expect(output.replace(/\r/g, '').trim()).toBe('MZXW6YTB');
  });

  it('encodes "foobar" correctly', async () => {
    const { output } = await run(shell, 'echo -n "foobar" | base32');
    expect(output.replace(/\r/g, '').trim()).toBe('MZXW6YTBOI======');
  });

  it('decodes base32 back', async () => {
    const { output } = await run(shell, 'echo -n "MZXW6===" | base32 -d');
    expect(output.replace(/\r/g, '').trim()).toBe('foo');
  });

  it('round-trips correctly', async () => {
    await fs.writeFile('/home/user/b32.txt', 'Hello, World!');
    const { output: encoded } = await run(shell, 'base32 b32.txt');
    await fs.writeFile('/home/user/b32enc.txt', encoded.replace(/\r/g, '').trim());
    const { output: decoded } = await run(shell, 'base32 -d b32enc.txt');
    expect(decoded.replace(/\r/g, '').trim()).toBe('Hello, World!');
  });

  it('supports -w 0 for no wrapping', async () => {
    const { output } = await run(shell, 'echo -n "foobar" | base32 -w 0');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('MZXW6YTBOI======');
    expect(clean.includes('\n')).toBe(false);
  });

  it('ignores garbage with -i on decode', async () => {
    const { output } = await run(shell, 'echo -n "MZX W6== =" | base32 -d -i');
    expect(output.replace(/\r/g, '').trim()).toBe('foo');
  });
});

describe('numfmt', () => {
  it('converts to SI', async () => {
    const { output } = await run(shell, 'numfmt --to=si 1000');
    expect(output.replace(/\r/g, '').trim()).toBe('1.0K');
  });

  it('converts to IEC', async () => {
    const { output } = await run(shell, 'numfmt --to=iec 1048576');
    expect(output.replace(/\r/g, '').trim()).toBe('1.0M');
  });

  it('converts to IEC-I suffixes', async () => {
    const { output } = await run(shell, 'numfmt --to=iec-i 1048576');
    expect(output.replace(/\r/g, '').trim()).toBe('1.0Mi');
  });

  it('converts from SI', async () => {
    const { output } = await run(shell, 'numfmt --from=si 1K');
    expect(output.replace(/\r/g, '').trim()).toBe('1000.0');
  });

  it('converts from IEC', async () => {
    const { output } = await run(shell, 'numfmt --from=iec 1K');
    expect(output.replace(/\r/g, '').trim()).toBe('1024.0');
  });

  it('respects --format', async () => {
    const { output } = await run(shell, 'numfmt --to=si --format=%.2f 1500');
    expect(output.replace(/\r/g, '').trim()).toBe('1.50K');
  });

  it('applies padding', async () => {
    const { output } = await run(shell, 'numfmt --to=si --padding=10 1000');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('1.0K');
    // Should have leading spaces
    expect(clean.indexOf('1.0K')).toBeGreaterThan(0);
  });

  it('reads from stdin', async () => {
    const { output } = await run(shell, 'echo 2048 | numfmt --to=iec');
    expect(output.replace(/\r/g, '')).toContain('2.0K');
  });

  it('passes header lines through', async () => {
    await fs.writeFile('/home/user/nums.txt', 'Size\n1024\n2048\n');
    const { output } = await run(shell, 'cat nums.txt | numfmt --to=iec --header');
    const lines = output.replace(/\r/g, '').trim().split('\n');
    expect(lines[0]).toBe('Size');
    expect(lines[1]).toBe('1.0K');
  });
});

describe('csplit', () => {
  it('splits at a line number', async () => {
    await fs.writeFile('/home/user/cs.txt', 'a\nb\nc\nd\ne\n');
    const { output } = await run(shell, 'csplit cs.txt 3');
    // Should print byte counts
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toContain('\n'); // multiple counts
    // Check files exist
    const f0 = await fs.readFile('/home/user/xx00', 'utf8');
    const f1 = await fs.readFile('/home/user/xx01', 'utf8');
    expect(f0).toBe('a\nb\n');
    expect(f1).toContain('c\n');
  });

  it('splits at regex pattern', async () => {
    await fs.writeFile('/home/user/cs2.txt', 'intro\nChapter 1\ntext1\nChapter 2\ntext2\n');
    const { output } = await run(shell, "csplit cs2.txt '/^Chapter/'");
    const f0 = await fs.readFile('/home/user/xx00', 'utf8');
    expect(f0).toBe('intro\n');
  });

  it('repeats with {*}', async () => {
    await fs.writeFile('/home/user/cs3.txt', 'a\n---\nb\n---\nc\n');
    await run(shell, "csplit cs3.txt '/^---/' '{*}'");
    const f0 = await fs.readFile('/home/user/xx00', 'utf8');
    expect(f0).toBe('a\n');
  });

  it('uses -f prefix', async () => {
    await fs.writeFile('/home/user/cs4.txt', 'line1\nline2\nline3\n');
    await run(shell, 'csplit -f part cs4.txt 2');
    const f0 = await fs.readFile('/home/user/part00', 'utf8');
    expect(f0).toBe('line1\n');
  });

  it('suppresses output with -s', async () => {
    await fs.writeFile('/home/user/cs5.txt', 'a\nb\nc\n');
    const { output } = await run(shell, 'csplit -s cs5.txt 2');
    expect(output.replace(/\r/g, '').trim()).toBe('');
  });
});

describe('nice', () => {
  it('prints 0 with no args', async () => {
    const { output } = await run(shell, 'nice');
    expect(output.replace(/\r/g, '').trim()).toBe('0');
  });

  it('passes through a command', async () => {
    const { output } = await run(shell, 'nice echo hello');
    expect(output.replace(/\r/g, '')).toContain('hello');
  });

  it('passes through exit code', async () => {
    const { exitCode } = await run(shell, 'nice false');
    expect(exitCode).toBe(1);
  });
});
