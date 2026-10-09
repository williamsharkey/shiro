/**
 * File identity at the VFS and kernel level, as native programs see it (Claude
 * Code's Bun binary checks its temp and task dirs by st_dev/st_ino and by
 * realpath through /proc/self/fd). fixtures/x86/fileid.c runs under Blink:
 * stat/lstat/fstat (O_DIRECTORY, O_PATH)/statx/newfstatat/getdents agree,
 * through symlinked dirs too; inodes follow renames and differ between files;
 * O_CREAT|O_EXCL, O_NOFOLLOW, O_TMPFILE, renameat2(RENAME_NOREPLACE), linkat,
 * mkdirat; a 0700 dir reports its owner and mode. Then the numbers must be the
 * same after a "reload" (a new FileSystem on the same IndexedDB).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run } from './helpers';

const FIX = resolve(__dirname, 'fixtures/x86');
const bin = join(mkdtempSync(join(tmpdir(), 'shiro-fileid-')), 'fileid');
const haveBin = (() => {
  try { execFileSync('gcc', ['-static', '-O1', '-o', bin, 'fileid.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 }); return true; } catch { return false; }
})();

async function setup() {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/home/user/work', { recursive: true });
  await fs.writeFile('/home/user/work/prog', readFileSync(bin), { mode: 0o755 });
  await shell.execute('cd /home/user/work', () => {});
  return { fs, shell };
}

describe('file identity (x86 under Blink)', () => {
  it.skipIf(!haveBin)('stat family, getdents, rename, exclusive create, realpath, owner and mode', async () => {
    const { fs, shell } = await setup();
    await fs.rm('/home/user/work/d', { recursive: true }).catch(() => {});
    const r = await run(shell, './prog');
    const out = r.output.replace(/\r\n/g, '\n');
    expect(out.split('\n').filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(out).toContain('\n0 failed\n');

    // the same numbers after a reload: a new FileSystem reading the same IndexedDB
    const paths = ['d', 'd/f2', 'd/sub', 'dl', '/tmp/claude-1000', '/home/user/work'];
    const ids = async (sh: typeof shell) => (await run(sh, `./prog ids ${paths.join(' ')}`)).output.replace(/\r\n/g, '\n');
    const before = await ids(shell);
    expect(before).not.toContain('missing');
    await fs.sync();
    const again = await setup();
    expect(await ids(again.shell)).toBe(before);
    // a process started in a directory reached through a symlink (the shell's logical $PWD) has the physical cwd
    const cw = (await run(again.shell, 'cd /home/user/work/dl && ../prog cwd')).output.replace(/\r\n/g, '\n');
    expect(cw).toBe('getcwd /home/user/work/d\nfd /home/user/work/d\nsame 1\n');
    await run(again.shell, 'cd /home/user/work');
    // node programs (makeStat) see the kernel's numbers
    const st = await again.fs.stat('/home/user/work/d/f2');
    expect(before).toContain(`d/f2 1:${st.ino}\n`);
  }, 120_000);
});

describe('FileSystem inode numbers', () => {
  it('are kept by writes and renames (with the children of a renamed dir), and are new for a new file', async () => {
    const { fs } = await createTestShell();
    await fs.mkdir('/tmp/id/a/b', { recursive: true });
    await fs.writeFile('/tmp/id/a/b/f', 'one');
    const ino = (p: string) => fs.inoOf(p);
    const [a, b, f] = [ino('/tmp/id/a'), ino('/tmp/id/a/b'), ino('/tmp/id/a/b/f')];
    expect(new Set([a, b, f]).size).toBe(3);
    await fs.writeFile('/tmp/id/a/b/f', 'two');
    await fs.chmod('/tmp/id/a/b/f', 0o600);
    expect(ino('/tmp/id/a/b/f')).toBe(f);
    await fs.rename('/tmp/id/a', '/tmp/id/z');
    expect([ino('/tmp/id/z'), ino('/tmp/id/z/b'), ino('/tmp/id/z/b/f')]).toEqual([a, b, f]);
    await fs.unlink('/tmp/id/z/b/f');
    await fs.writeFile('/tmp/id/z/b/f', 'three');
    expect(ino('/tmp/id/z/b/f')).not.toBe(f);
    // a node stored without a number (an older install, a rootfs placeholder) keeps a path-derived one through a rename
    fs.putNodes([{ path: '/tmp/id/old', type: 'file', content: new Uint8Array(1), mode: 0o644, mtime: 0, ctime: 0, size: 1 }]);
    (fs as any).cache.get('/tmp/id/old').ino = undefined;
    const old = ino('/tmp/id/old');
    expect(ino('/tmp/id/old')).toBe(old);
    await fs.rename('/tmp/id/old', '/tmp/id/new');
    expect(ino('/tmp/id/new')).toBe(old);
  });
});
