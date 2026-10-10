/**
 * System V message queues (src/kernel/sysvmsg.ts) through the kernel's
 * syscalls, /proc/sysvipc/{shm,sem,msg}, and the ipcs/ipcrm builtins.
 */
import { describe, it, expect } from 'vitest';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { IPC_PRIVATE, IPC_CREAT, IPC_EXCL, IPC_RMID, IPC_SET, IPC_STAT } from '@shiro/kernel/sysvshm';
import { IPC_NOWAIT, MSG_NOERROR, MSG_EXCEPT, MSG_COPY, MSGMNB } from '@shiro/kernel/sysvmsg';
import { createTestShell, run } from './helpers';

function setup() {
  const kernel = new Kernel({ registerWithProcessTable: false });
  const spawn = (uid = 1000) => kernel.spawn({ path: 'p', cwd: '/tmp', uid, run: () => new Promise<number>(() => {}) });
  const p = spawn();
  type P = typeof p;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const msgget = (proc: P, key: number, flg: number) => kernel.syscall(proc, A.SYS_msgget, [key, flg], new Uint8Array(8));
  const msgsnd = (proc: P, id: number, type: number, text: string, flg = 0) => {
    const t = enc.encode(text);
    const d = new Uint8Array(8 + t.length);
    new DataView(d.buffer).setBigInt64(0, BigInt(type), true);
    d.set(t, 8);
    return kernel.syscall(proc, A.SYS_msgsnd, [id, t.length, flg], d);
  };
  const msgrcv = async (proc: P, id: number, size: number, typ: number, flg = 0) => {
    const d = new Uint8Array(8 + Math.max(size, 0) + 8);
    const r = await kernel.syscall(proc, A.SYS_msgrcv, [id, size, typ | 0, typ < 0 ? -1 : 0, flg], d);
    if (r < 0) return r;
    return { type: Number(new DataView(d.buffer).getBigInt64(0, true)), text: dec.decode(d.subarray(8, 8 + r)) };
  };
  const msgctl = (proc: P, id: number, cmd: number, data = new Uint8Array(128)) => kernel.syscall(proc, A.SYS_msgctl, [id, cmd], data);
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  return { kernel, spawn, p, msgget, msgsnd, msgrcv, msgctl, tick };
}

describe('SysV message queues', () => {
  it('msgget: keys, IPC_PRIVATE, IPC_CREAT|IPC_EXCL', async () => {
    const { p, msgget } = setup();
    const id = await msgget(p, 0x3a5, IPC_CREAT | IPC_EXCL | 0o600);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(await msgget(p, 0x3a5, 0)).toBe(id);
    expect(await msgget(p, 0x3a5, IPC_CREAT | IPC_EXCL | 0o600)).toBe(-A.EEXIST);
    expect(await msgget(p, 0x3a6, 0)).toBe(-A.ENOENT);
    expect(await msgget(p, IPC_PRIVATE, 0o600)).not.toBe(await msgget(p, IPC_PRIVATE, 0o600));
  });

  it('msgrcv by type: 0 the first, > 0 that type (MSG_EXCEPT: not it), < 0 the lowest up to |type|', async () => {
    const { p, msgget, msgsnd, msgrcv } = setup();
    const id = await msgget(p, IPC_PRIVATE, 0o600);
    for (const [t, s] of [[3, 'c'], [1, 'a'], [2, 'b'], [1, 'a2']] as const) expect(await msgsnd(p, id, t, s)).toBe(0);
    expect(await msgrcv(p, id, 64, 2)).toEqual({ type: 2, text: 'b' });
    expect(await msgrcv(p, id, 64, -5)).toEqual({ type: 1, text: 'a' });       // lowest type first, FIFO within it
    expect(await msgrcv(p, id, 64, 1, MSG_EXCEPT)).toEqual({ type: 3, text: 'c' });
    expect(await msgrcv(p, id, 64, 0)).toEqual({ type: 1, text: 'a2' });
    expect(await msgrcv(p, id, 64, 0, IPC_NOWAIT)).toBe(-A.ENOMSG);
  });

  it('E2BIG for a short buffer unless MSG_NOERROR; MSG_COPY leaves the message; bad sends are EINVAL', async () => {
    const { p, msgget, msgsnd, msgrcv } = setup();
    const id = await msgget(p, IPC_PRIVATE, 0o600);
    await msgsnd(p, id, 7, 'hello world');
    expect(await msgrcv(p, id, 5, 0, IPC_NOWAIT)).toBe(-A.E2BIG);
    expect(await msgrcv(p, id, 5, 0, IPC_NOWAIT | MSG_COPY)).toBe(-A.E2BIG);
    expect(await msgrcv(p, id, 64, 0, IPC_NOWAIT | MSG_COPY)).toEqual({ type: 7, text: 'hello world' });
    expect(await msgrcv(p, id, 5, 0, MSG_NOERROR)).toEqual({ type: 7, text: 'hello' });
    expect(await msgsnd(p, id, 0, 'x')).toBe(-A.EINVAL);   // mtype < 1
    expect(await msgsnd(p, id, 1, 'x'.repeat(8193))).toBe(-A.EINVAL);
  });

  it('a receiver blocks until a message comes; a sender blocks while the queue is full', async () => {
    const { spawn, p, msgget, msgsnd, msgrcv, msgctl, tick } = setup();
    const q = spawn();
    const id = await msgget(p, IPC_PRIVATE, 0o666);
    let got: unknown = null;
    const recv = msgrcv(q, id, 64, 5).then((r) => { got = r; return r; });
    await tick();
    await msgsnd(p, id, 4, 'not this one');
    await tick();
    expect(got).toBe(null);
    await msgsnd(p, id, 5, 'this');
    expect(await recv).toEqual({ type: 5, text: 'this' });
    // fill the queue: IPC_SET a small msg_qbytes
    const ds = new Uint8Array(120);
    await msgctl(p, id, IPC_STAT, ds);
    new DataView(ds.buffer).setBigUint64(88, 8n, true);
    expect(await msgctl(p, id, IPC_SET, ds)).toBe(0);
    await msgrcv(p, id, 64, 4); // empty it
    expect(await msgsnd(p, id, 1, '12345678')).toBe(0);
    expect(await msgsnd(p, id, 1, 'x', IPC_NOWAIT)).toBe(-A.EAGAIN);
    let sent = false;
    const send = msgsnd(q, id, 1, 'x').then((r) => { sent = true; return r; });
    await tick();
    expect(sent).toBe(false);
    await msgrcv(p, id, 64, 0);
    expect(await send).toBe(0);
  });

  it('IPC_STAT counts; a signal ends a blocked msgrcv with EINTR, IPC_RMID with EIDRM', async () => {
    const { kernel, spawn, p, msgget, msgsnd, msgrcv, msgctl, tick } = setup();
    const id = await msgget(p, IPC_PRIVATE, 0o640);
    await msgsnd(p, id, 1, 'abc');
    await msgsnd(p, id, 2, 'de');
    const ds = new Uint8Array(120);
    expect(await msgctl(p, id, IPC_STAT, ds)).toBe(0);
    const dv = new DataView(ds.buffer);
    expect(dv.getUint16(20, true)).toBe(0o640);
    expect(Number(dv.getBigUint64(72, true))).toBe(5);       // msg_cbytes
    expect(Number(dv.getBigUint64(80, true))).toBe(2);       // msg_qnum
    expect(Number(dv.getBigUint64(88, true))).toBe(MSGMNB);  // msg_qbytes
    expect(dv.getInt32(96, true)).toBe(p.pid);               // msg_lspid
    const q = spawn();
    const id2 = await msgget(p, IPC_PRIVATE, 0o666);
    const intr = msgrcv(q, id2, 64, 0);
    await tick();
    kernel.kill(q.pid, A.SIGUSR1);
    expect(await intr).toBe(-A.EINTR);
    const r = spawn();
    const gone = msgrcv(r, id2, 64, 0);
    await tick();
    expect(await msgctl(spawn(1001), id2, IPC_RMID)).toBe(-A.EPERM);
    expect(await msgctl(p, id2, IPC_RMID)).toBe(0);
    expect(await gone).toBe(-A.EIDRM);
    expect(await msgsnd(p, id2, 1, 'x')).toBe(-A.EINVAL);
  });
});

describe('/proc/sysvipc and ipcs/ipcrm', () => {
  it('lists every kind; ipcrm removes by id and key', async () => {
    const { shell, fs } = await createTestShell();
    const { ipcsCmd, ipcrmCmd } = await import('@shiro/commands/ipcs');
    shell.commands.register(ipcsCmd);
    shell.commands.register(ipcrmCmd);
    const { kernelForContext } = await import('@shiro/wasi/run-command');
    const kernel = kernelForContext({ fs, shell } as any);
    const p = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, run: () => new Promise<number>(() => {}) });
    const msqid = await kernel.syscall(p, A.SYS_msgget, [0x1234, IPC_CREAT | 0o600], new Uint8Array(8));
    const semid = await kernel.syscall(p, A.SYS_semget, [0x2345, 2, IPC_CREAT | 0o644], new Uint8Array(8));
    const shmid = await kernel.syscall(p, A.SYS_shmget, [0x3456, 4096, 0, IPC_CREAT | 0o600], new Uint8Array(8));
    // as kernel programs (util-linux's ipcs) read them
    const readK = async (path: string) => {
      const b = new TextEncoder().encode(path);
      const d = new Uint8Array(65536);
      d.set(b);
      const fd = await kernel.syscall(p, A.SYS_openat, [A.AT_FDCWD, b.length, A.O_RDONLY, 0], d);
      expect(fd).toBeGreaterThanOrEqual(0);
      const n = await kernel.syscall(p, A.SYS_read, [fd, 65536], d);
      await kernel.syscall(p, A.SYS_close, [fd], new Uint8Array(8));
      return new TextDecoder().decode(d.subarray(0, n));
    };
    const procMsg = await readK('/proc/sysvipc/msg');
    expect(procMsg.split('\n')[0]).toMatch(/^\s+key\s+msqid perms\s+cbytes\s+qnum lspid lrpid/);
    expect(procMsg).toMatch(new RegExp(`^\\s+4660\\s+${msqid}\\s+600 `, 'm'));
    expect(await readK('/proc/sysvipc/sem')).toMatch(new RegExp(`^\\s+9029\\s+${semid}\\s+644\\s+2 `, 'm'));
    expect(await readK('/proc/sysvipc/shm')).toMatch(new RegExp(`^\\s+13398\\s+${shmid}\\s+600\\s+4096 `, 'm'));
    const r = await run(shell, 'ipcs');
    expect(r.output).toContain('------ Message Queues --------');
    expect(r.output).toMatch(/0x00001234 +\d+ +user +600/);
    expect(r.output).toMatch(/0x00002345 +\d+ +user +644 +2/);
    expect(r.output).toMatch(/0x00003456 +\d+ +user +600 +4096/);
    expect((await run(shell, `ipcrm -q ${msqid} -S 0x2345`)).exitCode).toBe(0);
    const after = (await run(shell, 'ipcs -q -s')).output;
    expect(after).not.toContain('0x00001234');
    expect(after).not.toContain('0x00002345');
    expect((await run(shell, 'ipcrm -m 999999')).exitCode).toBe(1);
    expect((await run(shell, 'ipcrm -a')).exitCode).toBe(0);
    expect((await run(shell, 'ipcs -m')).output).not.toContain('0x00003456');
  });
});
