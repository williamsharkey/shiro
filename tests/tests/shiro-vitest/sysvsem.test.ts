/**
 * System V semaphores (src/kernel/sysvsem.ts) through the kernel's syscalls:
 * semget's keys and flags, semop's all-or-nothing blocking (IPC_NOWAIT,
 * EINTR, EIDRM, semtimedop's timeout), semctl's commands, SEM_UNDO at exit,
 * and sets shared across fork (Audacity's single-instance lock, PostgreSQL).
 */
import { describe, it, expect } from 'vitest';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { IPC_PRIVATE, IPC_CREAT, IPC_EXCL, IPC_RMID, IPC_SET, IPC_STAT, IPC_INFO } from '@shiro/kernel/sysvshm';
import {
  IPC_NOWAIT, SEM_UNDO, GETVAL, GETALL, SETVAL, SETALL, GETPID, GETNCNT, GETZCNT, SEM_INFO, SEMVMX, SEMOPM,
} from '@shiro/kernel/sysvsem';

type Op = [num: number, op: number, flg?: number];

function setup() {
  const kernel = new Kernel({ registerWithProcessTable: false });
  const spawn = (uid = 1000) => kernel.spawn({ path: 'p', cwd: '/tmp', uid, run: () => new Promise<number>(() => {}) });
  const p = spawn();
  type P = typeof p;
  const semget = (proc: P, key: number, nsems: number, flg: number) => kernel.syscall(proc, A.SYS_semget, [key, nsems, flg], new Uint8Array(8));
  const sembuf = (ops: Op[]) => {
    const b = new Uint8Array(Math.max(6, ops.length * 6));
    const dv = new DataView(b.buffer);
    ops.forEach(([num, op, flg = 0], i) => { dv.setUint16(i * 6, num, true); dv.setInt16(i * 6 + 2, op, true); dv.setInt16(i * 6 + 4, flg, true); });
    return b;
  };
  const semop = (proc: P, id: number, ops: Op[]) => kernel.syscall(proc, A.SYS_semop, [id, ops.length], sembuf(ops));
  const semtimedop = (proc: P, id: number, ops: Op[], ms: number) =>
    kernel.syscall(proc, A.SYS_semtimedop, [id, ops.length, 1, Math.floor(ms / 1000), (ms % 1000) * 1e6], sembuf(ops));
  const semctl = (proc: P, id: number, num: number, cmd: number, val = 0, data = new Uint8Array(256)) =>
    kernel.syscall(proc, A.SYS_semctl, [id, num, cmd, val], data);
  const getall = async (proc: P, id: number, n: number) => {
    const d = new Uint8Array(n * 2);
    expect(await semctl(proc, id, 0, GETALL, 0, d)).toBe(0);
    return Array.from({ length: n }, (_, i) => new DataView(d.buffer).getUint16(i * 2, true));
  };
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  return { kernel, spawn, p, semget, semop, semtimedop, semctl, getall, tick };
}

describe('SysV semaphores', () => {
  it('semget: keys, IPC_PRIVATE, IPC_CREAT|IPC_EXCL, nsems limits', async () => {
    const { p, semget } = setup();
    const id = await semget(p, 0x5e3, 3, IPC_CREAT | IPC_EXCL | 0o600);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(await semget(p, 0x5e3, 0, 0)).toBe(id);              // found by key, nsems 0 ok
    expect(await semget(p, 0x5e3, 2, 0)).toBe(id);              // fewer is fine
    expect(await semget(p, 0x5e3, 4, 0)).toBe(-A.EINVAL);       // more isn't
    expect(await semget(p, 0x5e3, 3, IPC_CREAT | IPC_EXCL | 0o600)).toBe(-A.EEXIST);
    expect(await semget(p, 0x777, 1, 0)).toBe(-A.ENOENT);
    expect(await semget(p, 0x778, 0, IPC_CREAT | 0o600)).toBe(-A.EINVAL);
    expect(await semget(p, 0x779, 32001, IPC_CREAT | 0o600)).toBe(-A.EINVAL);
    const a = await semget(p, IPC_PRIVATE, 1, 0o600);
    const b = await semget(p, IPC_PRIVATE, 1, 0o600);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).not.toBe(a);
  });

  it('semctl SETVAL/GETVAL/SETALL/GETALL/GETPID and IPC_STAT', async () => {
    const { p, semget, semctl, getall } = setup();
    const id = await semget(p, IPC_PRIVATE, 3, 0o640);
    expect(await getall(p, id, 3)).toEqual([0, 0, 0]);
    expect(await semctl(p, id, 1, SETVAL, 5)).toBe(0);
    expect(await semctl(p, id, 1, GETVAL)).toBe(5);
    expect(await semctl(p, id, 1, GETPID)).toBe(p.pid);
    expect(await semctl(p, id, 3, GETVAL)).toBe(-A.EINVAL);
    expect(await semctl(p, id, 0, SETVAL, SEMVMX + 1)).toBe(-A.ERANGE);
    expect(await semctl(p, id, 0, SETVAL, -1)).toBe(-A.ERANGE);
    const vals = new Uint8Array(6);
    new DataView(vals.buffer).setUint16(0, 7, true);
    new DataView(vals.buffer).setUint16(4, 9, true);
    expect(await semctl(p, id, 0, SETALL, 0, vals)).toBe(0);
    expect(await getall(p, id, 3)).toEqual([7, 0, 9]);
    const ds = new Uint8Array(104);
    expect(await semctl(p, id, 0, IPC_STAT, 0, ds)).toBe(0);
    const dv = new DataView(ds.buffer);
    expect(dv.getUint32(4, true)).toBe(1000);                    // uid
    expect(dv.getUint16(20, true)).toBe(0o640);                  // mode
    expect(Number(dv.getBigUint64(80, true))).toBe(3);           // sem_nsems
    expect(Number(dv.getBigInt64(64, true))).toBeGreaterThan(0); // sem_ctime
    const info = new Uint8Array(40);
    expect(await semctl(p, 0, 0, IPC_INFO, 0, info)).toBeGreaterThanOrEqual(0);
    expect(new DataView(info.buffer).getInt32(20, true)).toBe(SEMOPM);
    expect(await semctl(p, 0, 0, SEM_INFO, 0, info)).toBeGreaterThanOrEqual(0);
  });

  it('semop is all or nothing; IPC_NOWAIT is EAGAIN; errors for bad ops', async () => {
    const { p, semget, semop, getall } = setup();
    const id = await semget(p, IPC_PRIVATE, 2, 0o600);
    expect(await semop(p, id, [[0, 2], [1, 1]])).toBe(0);
    expect(await getall(p, id, 2)).toEqual([2, 1]);
    // the second can't apply: neither does
    expect(await semop(p, id, [[0, -1], [1, -5, IPC_NOWAIT]])).toBe(-A.EAGAIN);
    expect(await getall(p, id, 2)).toEqual([2, 1]);
    expect(await semop(p, id, [[0, 0, IPC_NOWAIT]])).toBe(-A.EAGAIN); // wait-for-zero on 2
    expect(await semop(p, id, [[2, 1]])).toBe(-A.EFBIG);
    expect(await semop(p, id, [])).toBe(-A.EINVAL);
    expect(await semop(p, 12345, [[0, 1]])).toBe(-A.EINVAL);
    expect(await semop(p, id, [[0, SEMVMX]])).toBe(-A.ERANGE);
    expect(await getall(p, id, 2)).toEqual([2, 1]);
  });

  it('a blocked semop waits for another process (GETNCNT/GETZCNT count it) and then applies', async () => {
    const { spawn, p, semget, semop, semctl, getall, tick } = setup();
    const q = spawn();
    const id = await semget(p, 0x10c4, 1, IPC_CREAT | 0o600);
    let done = false;
    const down = semop(q, id, [[0, -1]]).then((r) => { done = true; return r; });
    await tick();
    expect(done).toBe(false);
    expect(await semctl(p, id, 0, GETNCNT)).toBe(1);
    expect(await semop(p, id, [[0, 1]])).toBe(0);
    expect(await down).toBe(0);
    expect(await getall(p, id, 1)).toEqual([0]);
    expect(await semctl(p, id, 0, GETPID)).toBe(q.pid);
    expect(await semctl(p, id, 0, GETNCNT)).toBe(0);
    // wait-for-zero
    await semctl(p, id, 0, SETVAL, 1);
    const zero = semop(q, id, [[0, 0]]);
    await tick();
    expect(await semctl(p, id, 0, GETZCNT)).toBe(1);
    await semop(p, id, [[0, -1]]);
    expect(await zero).toBe(0);
  });

  it('a signal ends a blocked semop with EINTR; IPC_RMID with EIDRM; semtimedop times out with EAGAIN', async () => {
    const { kernel, spawn, p, semget, semop, semtimedop, semctl, tick } = setup();
    const q = spawn();
    const id = await semget(p, IPC_PRIVATE, 1, 0o666);
    const intr = semop(q, id, [[0, -1]]);
    await tick();
    kernel.kill(q.pid, A.SIGUSR1); // caught or not, the wait ends
    expect(await intr).toBe(-A.EINTR);
    const r = spawn();
    const gone = semop(r, id, [[0, -1]]);
    await tick();
    expect(await semctl(p, id, 0, IPC_RMID)).toBe(0);
    expect(await gone).toBe(-A.EIDRM);
    expect(await semctl(p, id, 0, GETVAL)).toBe(-A.EINVAL);
    const id2 = await semget(p, IPC_PRIVATE, 1, 0o600);
    const t0 = Date.now();
    expect(await semtimedop(p, id2, [[0, -1]], 60)).toBe(-A.EAGAIN);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    await semctl(p, id2, 0, SETVAL, 1);
    expect(await semtimedop(p, id2, [[0, -1]], 1000)).toBe(0);
  });

  it('SEM_UNDO: a process\'s adjustments are undone when it exits (the single-instance lock pattern)', async () => {
    const { kernel, spawn, p, semget, semop, semctl, getall } = setup();
    const id = await semget(p, 0xa0d, 2, IPC_CREAT | 0o600);
    await semctl(p, id, 0, SETVAL, 1);
    const holder = spawn();
    expect(await semop(holder, id, [[0, -1, SEM_UNDO | IPC_NOWAIT], [1, 3, SEM_UNDO]])).toBe(0);
    expect(await getall(p, id, 2)).toEqual([0, 3]);
    // a second instance can't take it
    expect(await semop(spawn(), id, [[0, -1, SEM_UNDO | IPC_NOWAIT]])).toBe(-A.EAGAIN);
    await kernel.exit(holder, 0);
    expect(await getall(p, id, 2)).toEqual([1, 0]);
    expect(await semctl(p, id, 0, GETPID)).toBe(holder.pid);
    // SETVAL clears the adjustments it overrides
    const h2 = spawn();
    expect(await semop(h2, id, [[0, -1, SEM_UNDO]])).toBe(0);
    await semctl(p, id, 0, SETVAL, 0);
    await kernel.exit(h2, 0);
    expect(await semctl(p, id, 0, GETVAL)).toBe(0);
  });

  it('fork: the child uses the same sets, but doesn\'t inherit SEM_UNDO adjustments', async () => {
    const { kernel, p, semget, semop, semctl } = setup();
    const id = await semget(p, IPC_PRIVATE, 1, 0o600);
    await semctl(p, id, 0, SETVAL, 2);
    expect(await semop(p, id, [[0, -1, SEM_UNDO]])).toBe(0);
    const child = kernel.vfork(p);
    expect(await semop(child, id, [[0, -1]])).toBe(0);
    expect(await semctl(child, id, 0, GETVAL)).toBe(0);
    await kernel.exit(child, 0);
    expect(await semctl(p, id, 0, GETVAL)).toBe(0); // the child had nothing to undo
  });

  it('permissions: others need read (GETVAL) and write (semop that changes, SETVAL); owner sets mode with IPC_SET', async () => {
    const { spawn, p, semget, semop, semctl } = setup();
    const id = await semget(p, IPC_PRIVATE, 1, 0o644);
    const other = spawn(1001);
    expect(await semctl(other, id, 0, GETVAL)).toBe(0);
    expect(await semop(other, id, [[0, 1]])).toBe(-A.EACCES);
    expect(await semctl(other, id, 0, SETVAL, 1)).toBe(-A.EACCES);
    expect(await semctl(other, id, 0, IPC_RMID)).toBe(-A.EPERM);
    const ds = new Uint8Array(104);
    await semctl(p, id, 0, IPC_STAT, 0, ds);
    new DataView(ds.buffer).setUint16(20, 0o666, true);
    expect(await semctl(other, id, 0, IPC_SET, 0, ds)).toBe(-A.EPERM);
    expect(await semctl(p, id, 0, IPC_SET, 0, ds)).toBe(0);
    expect(await semop(other, id, [[0, 1]])).toBe(0);
    const root = spawn(0);
    expect(await semctl(root, id, 0, IPC_RMID)).toBe(0);
  });
});
