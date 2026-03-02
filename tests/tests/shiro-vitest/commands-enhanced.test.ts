/**
 * Enhanced commands: sort -k/-t, ls --color, watch, grep enhancements,
 * POSIX tar, find logic, sed hold space, awk control flow,
 * x86 JIT basic block cache
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

// ─── Phase 1: sort enhancements ──────────────────────────────────────────

describe('sort -k/-t', () => {
  it('sorts by second field', async () => {
    await fs.writeFile('/tmp/data.txt', 'charlie 3\nalpha 1\nbravo 2\n');
    const { output } = await run(shell, 'sort -k2,2 /tmp/data.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('alpha 1\nbravo 2\ncharlie 3');
  });

  it('sorts by third field numerically with delimiter', async () => {
    await fs.writeFile('/tmp/csv.txt', 'a:x:10\nb:y:2\nc:z:30\n');
    const { output } = await run(shell, 'sort -t: -k3,3n /tmp/csv.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('b:y:2\na:x:10\nc:z:30');
  });

  it('sorts with -f case insensitive', async () => {
    await fs.writeFile('/tmp/ci.txt', 'banana\nApple\ncherry\n');
    const { output } = await run(shell, 'sort -f /tmp/ci.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('Apple\nbanana\ncherry');
  });

  it('sorts versions with -V', async () => {
    await fs.writeFile('/tmp/ver.txt', '1.10.0\n1.2.3\n1.1.0\n');
    const { output } = await run(shell, 'sort -V /tmp/ver.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('1.1.0\n1.2.3\n1.10.0');
  });

  it('sorts human-readable sizes with -h', async () => {
    await fs.writeFile('/tmp/sizes.txt', '1G\n500K\n2M\n');
    const { output } = await run(shell, 'sort -h /tmp/sizes.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('500K\n2M\n1G');
  });

  it('checks if sorted with -c (sorted)', async () => {
    await fs.writeFile('/tmp/sorted.txt', 'a\nb\nc\n');
    const { exitCode } = await run(shell, 'sort -c /tmp/sorted.txt');
    expect(exitCode).toBe(0);
  });

  it('checks if sorted with -c (unsorted)', async () => {
    await fs.writeFile('/tmp/unsorted.txt', 'b\na\nc\n');
    const { exitCode } = await run(shell, 'sort -c /tmp/unsorted.txt');
    expect(exitCode).toBe(1);
  });

  it('ignores leading blanks with -b', async () => {
    await fs.writeFile('/tmp/blanks.txt', '  apple\nbanana\n  cherry\n');
    const { output } = await run(shell, 'sort -b /tmp/blanks.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toContain('apple');
    expect(clean).toContain('banana');
  });

  it('supports multiple -k keys', async () => {
    await fs.writeFile('/tmp/multi.txt', 'a 2\nb 1\na 1\n');
    const { output } = await run(shell, 'sort -k1,1 -k2,2n /tmp/multi.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('a 1\na 2\nb 1');
  });

  it('supports -n numeric sort', async () => {
    await fs.writeFile('/tmp/nums.txt', '10\n2\n1\n20\n');
    const { output } = await run(shell, 'sort -n /tmp/nums.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('1\n2\n10\n20');
  });

  it('supports -r reverse', async () => {
    await fs.writeFile('/tmp/rev.txt', 'a\nb\nc\n');
    const { output } = await run(shell, 'sort -r /tmp/rev.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('c\nb\na');
  });

  it('supports -u unique', async () => {
    await fs.writeFile('/tmp/dup.txt', 'a\nb\na\nc\nb\n');
    const { output } = await run(shell, 'sort -u /tmp/dup.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('a\nb\nc');
  });
});

// ─── Phase 1: ls --color ──────────────────────────────────────────────────

describe('ls --color', () => {
  beforeEach(async () => {
    await fs.mkdir('/tmp/lscolor', { recursive: true });
    await fs.mkdir('/tmp/lscolor/subdir', { recursive: true });
    await fs.writeFile('/tmp/lscolor/file.txt', 'hello');
    await fs.writeFile('/tmp/lscolor/script.ts', 'console.log("hi")');
    await fs.writeFile('/tmp/lscolor/image.png', 'PNG');
    await fs.writeFile('/tmp/lscolor/archive.tar.gz', 'tar');
  });

  it('includes ANSI codes with --color=always', async () => {
    const { output } = await run(shell, 'ls --color=always /tmp/lscolor');
    expect(output).toContain('\x1b[');
  });

  it('no ANSI codes with --color=never', async () => {
    const { output } = await run(shell, 'ls --color=never /tmp/lscolor');
    expect(output).not.toContain('\x1b[');
  });

  it('-1 shows one entry per line', async () => {
    const { output } = await run(shell, 'ls -1 /tmp/lscolor');
    const clean = output.replace(/\r/g, '').trim();
    const lines = clean.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(clean).toContain('file.txt');
    expect(clean).toContain('subdir');
  });

  it('-d lists directory itself', async () => {
    const { output } = await run(shell, 'ls -d /tmp/lscolor');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toContain('lscolor');
    expect(clean).not.toContain('file.txt');
  });

  it('-F appends type indicators', async () => {
    const { output } = await run(shell, 'ls -F /tmp/lscolor');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('subdir/');
  });

  it('--group-directories-first puts dirs first', async () => {
    // Ensure directory exists (nested beforeEach may not have run yet for all tests)
    try { await fs.mkdir('/tmp/lscolor', { recursive: true }); } catch {}
    try { await fs.mkdir('/tmp/lscolor/subdir', { recursive: true }); } catch {}
    await fs.writeFile('/tmp/lscolor/aaa.txt', 'hi');
    const { output } = await run(shell, 'ls -1 --group-directories-first /tmp/lscolor');
    const clean = output.replace(/\r/g, '').trim();
    const lines = clean.split('\n');
    expect(lines[0]).toContain('subdir');
  });

  it('colors directories as bold blue', async () => {
    const { output } = await run(shell, 'ls --color=always /tmp/lscolor');
    // Bold blue = \x1b[1;34m
    expect(output).toContain('\x1b[1;34m');
  });

  it('colors source files as yellow', async () => {
    const { output } = await run(shell, 'ls --color=always /tmp/lscolor');
    // Yellow = \x1b[0;33m
    expect(output).toContain('\x1b[0;33m');
  });
});

// ─── Phase 2: watch ──────────────────────────────────────────────────────

describe('watch', () => {
  it('runs command once in batch mode (no terminal)', async () => {
    const { output, exitCode } = await run(shell, 'watch echo hello');
    const clean = output.replace(/\r/g, '');
    expect(exitCode).toBe(0);
    expect(clean).toContain('hello');
  });

  it('shows header with interval', async () => {
    const { output } = await run(shell, 'watch echo test');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('Every 2.0s');
  });

  it('-t suppresses header', async () => {
    const { output } = await run(shell, 'watch -t echo test');
    const clean = output.replace(/\r/g, '');
    expect(clean).not.toContain('Every');
  });

  it('errors on missing command', async () => {
    const { exitCode } = await run(shell, 'watch');
    expect(exitCode).toBe(1);
  });

  it('shows help', async () => {
    const { output, exitCode } = await run(shell, 'watch --help');
    expect(exitCode).toBe(0);
    expect(output.replace(/\r/g, '')).toContain('Usage');
  });
});

// ─── Phase 2: grep enhancements ──────────────────────────────────────────

describe('grep enhancements', () => {
  beforeEach(async () => {
    await fs.writeFile('/tmp/grepdata.txt', 'hello world\nfoo bar\nhello again\nbaz qux\n');
  });

  it('-F treats pattern as fixed string', async () => {
    await fs.writeFile('/tmp/dots.txt', 'a.b.c\nabc\na*b*c\n');
    const { output } = await run(shell, 'grep -F "a.b.c" /tmp/dots.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('a.b.c');
  });

  it('-q produces no output', async () => {
    const { output, exitCode } = await run(shell, 'grep -q hello /tmp/grepdata.txt');
    expect(exitCode).toBe(0);
    expect(output.replace(/\r/g, '').trim()).toBe('');
  });

  it('-q returns 1 on no match', async () => {
    const { exitCode } = await run(shell, 'grep -q notfound /tmp/grepdata.txt');
    expect(exitCode).toBe(1);
  });

  it('--color=always wraps matches in ANSI', async () => {
    const { output } = await run(shell, 'grep --color=always hello /tmp/grepdata.txt');
    expect(output).toContain('\x1b[1;31m');
    expect(output).toContain('hello');
  });

  it('-x matches whole line only', async () => {
    const { output } = await run(shell, 'grep -x "foo bar" /tmp/grepdata.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('foo bar');
  });

  it('-x rejects partial match', async () => {
    const { exitCode } = await run(shell, 'grep -x "foo" /tmp/grepdata.txt');
    expect(exitCode).toBe(1);
  });

  it('-m 1 stops after first match', async () => {
    const { output } = await run(shell, 'grep -m 1 hello /tmp/grepdata.txt');
    const clean = output.replace(/\r/g, '').trim();
    const lines = clean.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('hello world');
  });

  it('-H always prints filename', async () => {
    const { output } = await run(shell, 'grep -H hello /tmp/grepdata.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toContain('/tmp/grepdata.txt:');
  });

  it('-h never prints filename (even with multiple files)', async () => {
    await fs.writeFile('/tmp/grepdata2.txt', 'hello there\n');
    const { output } = await run(shell, 'grep -h hello /tmp/grepdata.txt /tmp/grepdata2.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).not.toContain(':hello');
  });
});

// ─── Phase 3: POSIX tar ──────────────────────────────────────────────────

describe('POSIX tar', () => {
  beforeEach(async () => {
    await fs.mkdir('/tmp/tartest', { recursive: true });
    await fs.writeFile('/tmp/tartest/file1.txt', 'content one');
    await fs.writeFile('/tmp/tartest/file2.txt', 'content two');
    await fs.mkdir('/tmp/tartest/sub', { recursive: true });
    await fs.writeFile('/tmp/tartest/sub/file3.txt', 'content three');
  });

  it('creates and extracts tar archive', async () => {
    const { exitCode: ec1 } = await run(shell, 'tar -cf /tmp/test.tar -C /tmp tartest');
    expect(ec1).toBe(0);
    await fs.mkdir('/tmp/tarout', { recursive: true });
    const { exitCode: ec2 } = await run(shell, 'tar -xf /tmp/test.tar -C /tmp/tarout');
    expect(ec2).toBe(0);
    const content = await fs.readFile('/tmp/tarout/tartest/file1.txt', 'utf8');
    expect(content).toBe('content one');
  });

  it('lists archive contents with -t', async () => {
    await run(shell, 'tar cf /tmp/test.tar /tmp/tartest');
    const { output } = await run(shell, 'tar tf /tmp/test.tar');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('file1.txt');
    expect(clean).toContain('file2.txt');
    expect(clean).toContain('file3.txt');
  });

  it('verbose create shows files', async () => {
    const { output } = await run(shell, 'tar cvf /tmp/test.tar /tmp/tartest');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('file1.txt');
  });

  it('supports combined flags without dash', async () => {
    await run(shell, 'tar cf /tmp/test.tar /tmp/tartest');
    const { output, exitCode } = await run(shell, 'tar tf /tmp/test.tar');
    expect(exitCode).toBe(0);
    expect(output.replace(/\r/g, '')).toContain('file1.txt');
  });

  it('reads old FLUFFY-TAR-V1 format (backward compat)', async () => {
    const oldFormat = 'FLUFFY-TAR-V1\nFILE:old.txt\nSIZE:5\nTYPE:file\nDATA-START\nhello\nDATA-END\n';
    await fs.writeFile('/tmp/old.tar', oldFormat);
    const { output } = await run(shell, 'tar tf /tmp/old.tar');
    expect(output.replace(/\r/g, '').trim()).toBe('old.txt');
  });

  it('extracts old FLUFFY-TAR-V1 format', async () => {
    const oldFormat = 'FLUFFY-TAR-V1\nFILE:legacy.txt\nSIZE:5\nTYPE:file\nDATA-START\nhello\nDATA-END\n';
    await fs.writeFile('/tmp/old.tar', oldFormat);
    await run(shell, 'tar xf /tmp/old.tar -C /tmp');
    const content = await fs.readFile('/tmp/legacy.txt', 'utf8');
    expect(content).toBe('hello');
  });
});

// ─── Phase 3: find logic operators ──────────────────────────────────────

describe('find logic', () => {
  beforeEach(async () => {
    await fs.mkdir('/tmp/findtest', { recursive: true });
    await fs.writeFile('/tmp/findtest/a.ts', 'typescript');
    await fs.writeFile('/tmp/findtest/b.js', 'javascript');
    await fs.writeFile('/tmp/findtest/c.txt', 'text');
    await fs.writeFile('/tmp/findtest/empty.txt', '');
    await fs.mkdir('/tmp/findtest/dir1', { recursive: true });
    await fs.writeFile('/tmp/findtest/dir1/d.ts', 'more ts');
  });

  it('finds with OR (-o)', async () => {
    const { output } = await run(shell, 'find /tmp/findtest -name "*.ts" -o -name "*.js"');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('a.ts');
    expect(clean).toContain('b.js');
    expect(clean).not.toContain('c.txt');
  });

  it('negates with ! (NOT)', async () => {
    const { output } = await run(shell, 'find /tmp/findtest ! -name "*.ts" -type f');
    const clean = output.replace(/\r/g, '');
    expect(clean).not.toContain('a.ts');
    expect(clean).toContain('b.js');
    expect(clean).toContain('c.txt');
  });

  it('finds empty files with -empty', async () => {
    const { output } = await run(shell, 'find /tmp/findtest -empty');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('empty.txt');
  });

  it('finds files by type', async () => {
    const { output } = await run(shell, 'find /tmp/findtest -type d');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('dir1');
    expect(clean).not.toContain('a.ts');
  });

  it('deletes matched files with -delete', async () => {
    await run(shell, 'find /tmp/findtest -name "*.txt" -type f -delete');
    const entries = await fs.readdir('/tmp/findtest');
    expect(entries).not.toContain('c.txt');
    expect(entries).not.toContain('empty.txt');
    expect(entries).toContain('a.ts');
  });
});

// ─── Phase 4: sed hold space ──────────────────────────────────────────────

describe('sed enhancements', () => {
  it('transliterates with y command', async () => {
    const { output } = await run(shell, 'echo "hello" | sed "y/helo/HELO/"');
    expect(output.replace(/\r/g, '').trim()).toBe('HELLO');
  });

  it('prints line number with = command', async () => {
    await fs.writeFile('/tmp/sed.txt', 'a\nb\nc\n');
    const { output } = await run(shell, 'sed -n "2=" /tmp/sed.txt');
    expect(output.replace(/\r/g, '').trim()).toBe('2');
  });

  it('quits after first line with q', async () => {
    await fs.writeFile('/tmp/sed.txt', 'first\nsecond\nthird\n');
    const { output } = await run(shell, 'sed "1q" /tmp/sed.txt');
    expect(output.replace(/\r/g, '').trim()).toBe('first');
  });

  it('hold space: h and g', async () => {
    await fs.writeFile('/tmp/sed.txt', 'first\nsecond\n');
    const { output } = await run(shell, 'sed -n "1h;2{g;p}" /tmp/sed.txt');
    expect(output.replace(/\r/g, '').trim()).toBe('first');
  });

  it('exchange with x', async () => {
    await fs.writeFile('/tmp/sed.txt', 'hello\nworld\n');
    const { output } = await run(shell, 'sed -n "1h;2{x;p}" /tmp/sed.txt');
    expect(output.replace(/\r/g, '').trim()).toBe('hello');
  });

  it('supports regex range /start/,/end/', async () => {
    await fs.writeFile('/tmp/sed.txt', 'before\nSTART\nmiddle\nEND\nafter\n');
    const { output } = await run(shell, 'sed "/START/,/END/d" /tmp/sed.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('before\nafter');
  });

  it('substitute with address', async () => {
    await fs.writeFile('/tmp/sed.txt', 'aaa\nbbb\nccc\n');
    const { output } = await run(shell, 'sed "2s/bbb/BBB/" /tmp/sed.txt');
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('aaa\nBBB\nccc');
  });
});

// ─── Phase 4: awk control flow ──────────────────────────────────────────

describe('awk control flow', () => {
  it('if/else statement', async () => {
    await fs.writeFile('/tmp/awk.txt', '5\n15\n3\n20\n');
    const { output } = await run(shell, `awk '{if ($1 > 10) {print "big"} else {print "small"}}' /tmp/awk.txt`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('small\nbig\nsmall\nbig');
  });

  it('for loop', async () => {
    const { output } = await run(shell, `echo "a b c" | awk '{for(i=1;i<=NF;i++) {print $i}}'`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('a\nb\nc');
  });

  it('while loop', async () => {
    const { output } = await run(shell, `echo "test" | awk 'BEGIN{i=1; while(i<=3) {print i; i++}}'`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('1\n2\n3');
  });

  it('next skips to next record', async () => {
    await fs.writeFile('/tmp/awk.txt', '1\n2\n3\n4\n');
    const { output } = await run(shell, `awk '{if ($1 % 2 == 0) next; print}' /tmp/awk.txt`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('1\n3');
  });

  it('delete array element', async () => {
    await fs.writeFile('/tmp/awkdel.txt', 'a\nb\na\nc\n');
    const { output } = await run(shell, `awk '{count[$1]++} END{delete count["b"]; for(k in count) print k, count[k]}' /tmp/awkdel.txt`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toContain('a');
    expect(clean).toContain('2');
  });

  it('key in array membership', async () => {
    const { output } = await run(shell, `echo "test" | awk 'BEGIN{a["x"]=1} {if ("x" in a) print "found"; if ("y" in a) print "also found"}'`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('found');
  });

  it('multiple pattern-action pairs', async () => {
    await fs.writeFile('/tmp/awk.txt', 'abc\ndef\nghi\n');
    const { output } = await run(shell, `awk '/abc/{print "first"} /ghi/{print "third"}' /tmp/awk.txt`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('first\nthird');
  });

  it('conditional pattern', async () => {
    await fs.writeFile('/tmp/awk.txt', '10\n20\n30\n');
    const { output } = await run(shell, `awk '$1 > 15 {print $1}' /tmp/awk.txt`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toBe('20\n30');
  });

  it('BEGIN and END blocks', async () => {
    const { output } = await run(shell, `echo "1\n2\n3" | awk 'BEGIN{print "start"} {sum+=$1} END{print sum}'`);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean).toContain('start');
    expect(clean).toContain('6');
  });
});

// ─── Phase 5: x86 network stubs ──────────────────────────────────────────

describe('x86 network syscall stubs', () => {
  // These tests verify the syscall table entries exist; actual execution
  // requires ELF binaries so we test at the import/module level

  it('syscall module exports LinuxSyscalls', async () => {
    const mod = await import('@shiro/x86/syscalls');
    expect(mod.LinuxSyscalls).toBeDefined();
  });

  it('x86 runtime exports debug functions', async () => {
    const mod = await import('@shiro/x86/runtime');
    expect(mod.executeElf).toBeDefined();
    expect(mod.debugElf).toBeDefined();
    expect(mod.hexDump).toBeDefined();
  });
});

// ─── Phase 5: x86 debug enhancements ────────────────────────────────────

describe('x86 debug tooling', () => {
  it('hexDump formats memory correctly', async () => {
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { hexDump } = await import('@shiro/x86/runtime');
    const mem = new VirtualMemory();
    // Write some bytes
    for (let i = 0; i < 16; i++) {
      mem.write8(0x1000n + BigInt(i), 0x41 + i); // 'A' through 'P'
    }
    const dump = hexDump(mem, 0x1000n, 16);
    expect(dump).toContain('0x00001000');
    expect(dump).toContain('41');
    expect(dump).toContain('|ABCDEFGHIJKLMNOP|');
  });

  it('hexDump shows dots for non-printable', async () => {
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { hexDump } = await import('@shiro/x86/runtime');
    const mem = new VirtualMemory();
    mem.write8(0x2000n, 0x00);
    mem.write8(0x2001n, 0xFF);
    mem.write8(0x2002n, 0x41); // 'A'
    const dump = hexDump(mem, 0x2000n, 3);
    expect(dump).toContain('|..A|');
  });
});

// ─── Phase 6: JIT basic block cache ──────────────────────────────────────

describe('x86 JIT block cache', () => {
  it('BlockCache stores and retrieves blocks', async () => {
    const { BlockCache } = await import('@shiro/x86/jit');
    const cache = new BlockCache();
    const block = {
      startAddr: 0x401000n,
      endAddr: 0x401010n,
      instructions: [],
      execCount: 5,
      compiledFn: null,
      byteHash: 12345,
    };
    cache.put(block);
    const retrieved = cache.get(0x401000n);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.startAddr).toBe(0x401000n);
    expect(retrieved!.execCount).toBe(5);
  });

  it('BlockCache returns null for missing blocks', async () => {
    const { BlockCache } = await import('@shiro/x86/jit');
    const cache = new BlockCache();
    expect(cache.get(0xDEADn)).toBeNull();
  });

  it('BlockCache invalidates on overlapping write', async () => {
    const { BlockCache } = await import('@shiro/x86/jit');
    const cache = new BlockCache();
    cache.put({
      startAddr: 0x401000n,
      endAddr: 0x401020n,
      instructions: [],
      execCount: 10,
      compiledFn: null,
      byteHash: 12345,
    });
    // Write overlapping the block
    cache.invalidate(0x401010n, 4);
    expect(cache.get(0x401000n)).toBeNull();
  });

  it('BlockCache does not invalidate non-overlapping write', async () => {
    const { BlockCache } = await import('@shiro/x86/jit');
    const cache = new BlockCache();
    cache.put({
      startAddr: 0x401000n,
      endAddr: 0x401020n,
      instructions: [],
      execCount: 10,
      compiledFn: null,
      byteHash: 12345,
    });
    // Write outside the block
    cache.invalidate(0x402000n, 4);
    expect(cache.get(0x401000n)).toBeTruthy();
  });

  it('BlockCache reports stats', async () => {
    const { BlockCache } = await import('@shiro/x86/jit');
    const cache = new BlockCache();
    cache.put({ startAddr: 0x1000n, endAddr: 0x1010n, instructions: [], execCount: 5, compiledFn: null, byteHash: 1 });
    cache.put({ startAddr: 0x2000n, endAddr: 0x2010n, instructions: [], execCount: 3, compiledFn: null, byteHash: 2 });
    const stats = cache.stats();
    expect(stats.size).toBe(2);
    expect(stats.totalExecs).toBe(8);
  });

  it('identifyBlock identifies linear code', async () => {
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { identifyBlock } = await import('@shiro/x86/jit');
    const mem = new VirtualMemory();
    // Write a simple sequence: NOP, NOP, RET
    mem.write8(0x1000n, 0x90); // NOP
    mem.write8(0x1001n, 0x90); // NOP
    mem.write8(0x1002n, 0xC3); // RET
    const block = identifyBlock(mem, 0x1000n);
    expect(block.instructions.length).toBe(3);
    expect(block.instructions[2].isReturn).toBe(true);
    expect(block.startAddr).toBe(0x1000n);
  });

  it('identifyBlock stops at branch', async () => {
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { identifyBlock } = await import('@shiro/x86/jit');
    const mem = new VirtualMemory();
    // NOP, JMP rel8 (0xEB 0x00)
    mem.write8(0x1000n, 0x90); // NOP
    mem.write8(0x1001n, 0xEB); // JMP short
    mem.write8(0x1002n, 0x00); // offset 0
    const block = identifyBlock(mem, 0x1000n);
    expect(block.instructions.length).toBe(2);
    expect(block.instructions[1].isBranch).toBe(true);
  });

  it('identifyBlock stops at CALL', async () => {
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { identifyBlock } = await import('@shiro/x86/jit');
    const mem = new VirtualMemory();
    // NOP, CALL rel32 (0xE8 + 4 bytes)
    mem.write8(0x1000n, 0x90); // NOP
    mem.write8(0x1001n, 0xE8); // CALL
    mem.write8(0x1002n, 0x00);
    mem.write8(0x1003n, 0x00);
    mem.write8(0x1004n, 0x00);
    mem.write8(0x1005n, 0x00);
    const block = identifyBlock(mem, 0x1000n);
    expect(block.instructions.length).toBe(2);
    expect(block.instructions[1].isCall).toBe(true);
  });

  it('BlockCache validates block integrity', async () => {
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { BlockCache, identifyBlock } = await import('@shiro/x86/jit');
    const mem = new VirtualMemory();
    mem.write8(0x1000n, 0x90);
    mem.write8(0x1001n, 0xC3);
    const block = identifyBlock(mem, 0x1000n);
    const cache = new BlockCache();
    cache.put(block);
    // Block should be valid
    expect(cache.validate(block, mem)).toBe(true);
    // Modify memory — block should be invalid
    mem.write8(0x1000n, 0xCC);
    expect(cache.validate(block, mem)).toBe(false);
  });

  it('compileBlock produces executable function', async () => {
    const { CPU } = await import('@shiro/x86/cpu');
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { compileBlock } = await import('@shiro/x86/jit');
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const block = {
      startAddr: 0x1000n,
      endAddr: 0x1010n,
      instructions: [{ address: 0x1000n, length: 1, opcode: [0x90], mnemonic: 'NOP', isBranch: false, isCall: false, isReturn: false, isSyscall: false }],
      execCount: 20, // above threshold
      compiledFn: null,
      byteHash: 0,
    };
    const fn = compileBlock(block, cpu, mem);
    expect(fn).toBeDefined();
    expect(typeof fn).toBe('function');
  });

  it('compileBlock returns null for cold blocks', async () => {
    const { CPU } = await import('@shiro/x86/cpu');
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const { compileBlock } = await import('@shiro/x86/jit');
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const block = {
      startAddr: 0x1000n,
      endAddr: 0x1010n,
      instructions: [],
      execCount: 2, // below threshold
      compiledFn: null,
      byteHash: 0,
    };
    const fn = compileBlock(block, cpu, mem);
    expect(fn).toBeNull();
  });
});
