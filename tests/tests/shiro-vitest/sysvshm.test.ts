/**
 * System V shared memory bookkeeping (src/kernel/sysvshm.ts), through the
 * kernel's syscalls: the cases LTP's shmget01-05 and shmctl01/02/04 check that
 * don't need the engine's mapping, plus attach counts across fork, exec and
 * exit (PostgreSQL's postmaster interlock reads shm_nattch).
 */
import { describe, it, expect } from 'vitest';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { IPC_PRIVATE, IPC_CREAT, IPC_EXCL, IPC_RMID, IPC_SET, IPC_STAT, IPC_INFO, SHM_RDONLY } from '@shiro/kernel/sysvshm';

function setup() {
  const kernel = new Kernel({ registerWithProcessTable: false });
  const spawn = (uid: number) => kernel.spawn({ path: 'p', cwd: '/tmp', uid, run: () => new Promise<number>(() => {}) });
  const root = spawn(0);
  const data = new Uint8Array(256);
  const dv = new DataView(data.buffer);
  const sys = (proc: typeof root, nr: number, a: number[]) => kernel.syscall(proc, nr, a, data);
  const shmget = (proc: typeof root, key: number, size: number, flg: number) => sys(proc, A.SYS_shmget, [key, size, 0, flg]);
  const stat = async (proc: typeof root, id: number) => {
    const r = await sys(proc, A.SYS_shmctl, [id, IPC_STAT]);
    if (r < 0) return r;
    return {
      key: dv.getInt32(0, true), uid: dv.getUint32(4, true), mode: dv.getUint16(20, true),
      size: Number(dv.getBigUint64(48, true)), cpid: dv.getInt32(80, true), lpid: dv.getInt32(84, true),
      nattch: Number(dv.getBigUint64(88, true)),
    };
  };
  return { kernel, spawn, root, sys, shmget, stat, dv };
}

describe('SysV shared memory', () => {
  it('shmget creates, finds by key and refuses what Linux refuses (LTP shmget01-05)', async () => {
    const { root, shmget } = setup();
    const id = await shmget(root, 0x5150, 4096, IPC_CREAT | IPC_EXCL | 0o600);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(await shmget(root, 0x5150, 4096, 0)).toBe(id);                       // found by key
    expect(await shmget(root, 0x5150, 100, 0)).toBe(id);                        // smaller size is fine
    expect(await shmget(root, 0x5150, 8192, 0)).toBe(-A.EINVAL);                // bigger isn't
    expect(await shmget(root, 0x5150, 4096, IPC_CREAT | IPC_EXCL | 0o600)).toBe(-A.EEXIST);
    expect(await shmget(root, 0x7777, 4096, 0)).toBe(-A.ENOENT);                // no IPC_CREAT
    expect(await shmget(root, 0x7778, 0, IPC_CREAT | 0o600)).toBe(-A.EINVAL);   // size 0
    const p1 = await shmget(root, IPC_PRIVATE, 64, 0o600);
    const p2 = await shmget(root, IPC_PRIVATE, 64, 0o600);
    expect(p1).not.toBe(p2);                                                    // IPC_PRIVATE: always new
  });

  it('permissions: another user without access gets EACCES; the owner and root pass', async () => {
    const { spawn, root, shmget } = setup();
    const owner = spawn(1000);
    await shmget(owner, 0x1001, 4096, IPC_CREAT | 0o600);
    expect(await shmget(spawn(1001), 0x1001, 4096, 0o600)).toBe(-A.EACCES);
    expect(await shmget(owner, 0x1001, 4096, 0o600)).toBeGreaterThanOrEqual(0);
    expect(await shmget(root, 0x1001, 4096, 0o600)).toBeGreaterThanOrEqual(0);
  });

  it('IPC_STAT, IPC_SET and IPC_RMID with destroy on the last detach (LTP shmctl01/02/04)', async () => {
    const { kernel, root, sys, shmget, stat, dv } = setup();
    const id = await shmget(root, 0x2002, 10000, IPC_CREAT | 0o640);
    let st = await stat(root, id);
    expect(st).toMatchObject({ key: 0x2002, uid: 0, mode: 0o640, size: 10000, cpid: root.pid, nattch: 0 });
    // IPC_SET changes the mode bits
    dv.setUint16(20, 0o600, true);
    expect(await sys(root, A.SYS_shmctl, [id, IPC_SET])).toBe(0);
    expect((await stat(root, id) as { mode: number }).mode).toBe(0o600);
    // Attached by the engine: nattch counts, the size comes back
    expect(await sys(root, A.SYS_shiro_shmat, [id, 0])).toBe(0);
    expect(Number(dv.getBigUint64(0, true))).toBe(10000);
    st = await stat(root, id);
    expect(st).toMatchObject({ nattch: 1, lpid: root.pid });
    // Removed while attached: still there, key gone, SHM_DEST set
    expect(await sys(root, A.SYS_shmctl, [id, IPC_RMID])).toBe(0);
    st = await stat(root, id);
    expect(st).toMatchObject({ key: IPC_PRIVATE, nattch: 1 });
    expect((st as { mode: number }).mode & 0o1000).toBe(0o1000);
    expect(await shmget(root, 0x2002, 10000, 0)).toBe(-A.ENOENT);               // the key is free again
    // The last detach destroys it
    expect(await sys(root, A.SYS_shiro_shmdt, [id])).toBe(0);
    expect(await stat(root, id)).toBe(-A.EINVAL);
    expect(await sys(root, A.SYS_shiro_shmdt, [id])).toBe(-A.EINVAL);
    expect(await sys(root, A.SYS_shmctl, [0, IPC_INFO])).toBeGreaterThanOrEqual(0);
    void kernel;
  });

  it('fork inherits attachments, exec and exit drop them (shm_nattch as PostgreSQL reads it)', async () => {
    const { kernel, spawn, root, sys, shmget, stat } = setup();
    const id = await shmget(root, 0x3003, 56, IPC_CREAT | IPC_EXCL | 0o600);
    expect(await sys(root, A.SYS_shiro_shmat, [id, 0])).toBe(0);
    const child = kernel.vfork(root);
    expect((await stat(root, id) as { nattch: number }).nattch).toBe(2);
    await kernel.exit(child, 0);
    expect((await stat(root, id) as { nattch: number }).nattch).toBe(1);
    // A read-only attach needs only read permission
    const reader = spawn(1000);
    expect(await sys(reader, A.SYS_shiro_shmat, [id, SHM_RDONLY])).toBe(-A.EACCES);  // 0600, other user
    await kernel.exit(root, 0);
    expect((await stat(spawn(0), id) as { nattch: number }).nattch).toBe(0);
  });
});
