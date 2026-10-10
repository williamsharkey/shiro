/**
 * PostgreSQL's WAL segment life, replayed through the kernel's syscalls (what
 * initdb's bootstrap does under Blink, from its SHIRO_BLINK_MMLOG=3 log):
 * create xlogtemp.N, zero-fill 16 MiB in 256 KiB pwrites, fsync, close,
 * rename it into place, open it, write() page 0, fsync, close, open it again,
 * pwrite 0xb2000 bytes at 0 and a page at 0xb0000, fsync, close. Every byte
 * written must read back. initdb's post-bootstrap found the first 0xfd0 bytes
 * of page 0 zero ("invalid magic number 0000 in WAL segment"); this shows the
 * kernel and the file layer keep them, with or without pauses for write-back.
 * (The zeros arrived in the pool channel's data area with the 0xb2000-byte
 * pwrite, before the kernel saw it: an engine-side transfer bug.)
 */
import { describe, it, expect } from 'vitest';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { createTestShell } from './helpers';

const enc = new TextEncoder();

describe('a WAL segment written as PostgreSQL does', () => {
  it.each([0, 30, 400])('keeps every byte through create, zero-fill, rename, write(), reopen and pwrite (%i ms between steps)', async (pause) => {
    const gap = () => new Promise((r) => setTimeout(r, pause));
    const { fs } = await createTestShell();
    await fs.mkdir('/tmp/pgdata/pg_wal', { recursive: true });
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const proc = kernel.spawn({ path: 'postgres', cwd: '/tmp/pgdata', run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(1 << 20);
    const sys = (nr: number, args: number[]) => kernel.syscall(proc, nr, args, data);
    const open = async (path: string, flags: number) => { const b = enc.encode(path); data.set(b); return sys(A.SYS_openat, [A.AT_FDCWD, b.length, flags, 0o600]); };
    const write = async (fd: number, bytes: Uint8Array, off: number | null) => {
      let done = 0;
      while (done < bytes.length) {
        const n = Math.min(bytes.length - done, data.length);
        data.set(bytes.subarray(done, done + n));
        const at = off === null ? -1 : off + done;
        const r = at < 0 ? await sys(A.SYS_write, [fd, n]) : await sys(A.SYS_pwrite64, [fd, n, at >>> 0, Math.floor(at / 2 ** 32)]);
        expect(r).toBe(n);
        done += n;
      }
    };
    const page = (magic: number, fill: number, len = 8192) => {
      const p = new Uint8Array(len).fill(fill);
      p[0] = magic & 0xff; p[1] = magic >> 8;
      return p;
    };
    const SEG = '/tmp/pgdata/pg_wal/000000010000000000000001';
    const TMP = '/tmp/pgdata/pg_wal/xlogtemp.115';

    // XLogFileInit: zero-fill the temp file, fsync, close, rename into place
    let fd = await open(TMP, A.O_RDWR | A.O_CREAT | A.O_EXCL);
    expect(fd).toBeGreaterThanOrEqual(0);
    const zeros = new Uint8Array(0x40000);
    for (let off = 0; off < 16 << 20; off += zeros.length) await write(fd, zeros, off);
    expect(await sys(A.SYS_fsync, [fd])).toBe(0);
    expect(await sys(A.SYS_close, [fd])).toBe(0);
    const from = enc.encode(TMP), to = enc.encode(SEG);
    data.set(from); data.set(to, from.length);
    expect(await sys(A.SYS_rename, [from.length, to.length])).toBe(0);
    await gap();

    // BootStrapXLOG: open, write() the first page, fsync, close
    await gap();
    fd = await open(SEG, A.O_RDWR);
    expect(fd).toBeGreaterThanOrEqual(0);
    await write(fd, page(0xd116, 0x11), null);
    expect(await sys(A.SYS_fsync, [fd])).toBe(0);
    expect(await sys(A.SYS_close, [fd])).toBe(0);

    // XLogWrite: reopen, write the WAL buffers from offset 0, then a later page
    await gap();
    fd = await open(SEG, A.O_RDWR);
    const run = page(0xd116, 0x22, 0xb2000);
    await write(fd, run, 0);
    await gap();
    await write(fd, page(0xd116, 0x33), 0xb0000);
    expect(await sys(A.SYS_fsync, [fd])).toBe(0);
    expect(await sys(A.SYS_close, [fd])).toBe(0);

    const want = new Uint8Array(16 << 20);
    want.set(run, 0);
    want.set(page(0xd116, 0x33), 0xb0000);
    await gap();
    const got = await fs.readFile(SEG) as Uint8Array;
    expect(got.length).toBe(16 << 20);
    const firstBad = got.findIndex((b, i) => b !== want[i]);
    expect(firstBad).toBe(-1);
    expect(await fs.exists(TMP)).toBe(false);
  }, 120000);
});
