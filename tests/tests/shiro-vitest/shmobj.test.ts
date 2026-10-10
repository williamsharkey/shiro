/**
 * Shared objects across engine instances (src/kernel/shmobj.ts): the kernel
 * half of docs/research/SHARED_MAPPINGS.md, with fake instances standing in
 * for Blink workers, and the mechanism itself (one SharedArrayBuffer, atomics
 * and futex-style waits across two real workers).
 */
import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { SharedObjects, type ShmObjMessage } from '@shiro/kernel/shmobj';
import { IPC_PRIVATE } from '@shiro/kernel/sysvshm';
import { createTestShell } from './helpers';

describe('SharedObjects (kernel half)', () => {
  it('one instance maps fast; a second makes it remote after the first publishes', async () => {
    const sent: [number, ShmObjMessage][] = [];
    const objs = new SharedObjects((i, m) => sent.push([i, m]));
    expect(await objs.map(1, 'k', 4096)).toEqual({ id: 1, remote: false });
    expect(await objs.map(1, 'k', 4096)).toEqual({ id: 1, remote: false }); // same instance again
    expect(sent).toEqual([]);
    let done = false;
    const second = objs.map(2, 'k', 4096, () => new Uint8Array([7, 8, 9])).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false); // waiting for instance 1 to publish
    expect(sent.map(([i, m]) => [i, m.type])).toEqual([[1, 'blink-shmobj'], [1, 'blink-publish']]);
    const sab = (sent[0][1] as { sab: SharedArrayBuffer }).sab;
    expect(Array.from(new Uint8Array(sab, 0, 3))).toEqual([7, 8, 9]); // seeded from the file
    expect(objs.published(1, 1)).toBe(0);
    expect(await second).toEqual({ id: 1, remote: true });
    expect(sent.map(([i, m]) => [i, m.type])).toEqual([[1, 'blink-shmobj'], [1, 'blink-publish'], [2, 'blink-shmobj']]);
    expect((sent[2][1] as { sab: SharedArrayBuffer }).sab).toBe(sab); // the same buffer
    // a third instance: already remote, no publish round
    expect(await objs.map(3, 'k', 4096)).toEqual({ id: 1, remote: true });
    expect(objs.published(1, 1)).toBe(-22);
  });

  it('the last unmap writes a file object back; a gone instance counts as unmapped; a silent holder times out', async () => {
    const sent: [number, ShmObjMessage][] = [];
    const objs = new SharedObjects((i, m) => sent.push([i, m]));
    objs.publishTimeoutMs = 50;
    let written: Uint8Array | null = null;
    await objs.map(1, 'f', 16, undefined, (b) => { written = b; });
    const r = await objs.map(2, 'f', 16); // instance 1 never answers
    expect(r).toEqual({ id: 1, remote: true });
    const sab = objs.bufferFor('f')!;
    new Uint8Array(sab)[0] = 42;
    expect(await objs.unmap(1, 1)).toBe(0);
    expect(written).toBe(null);
    await objs.instanceGone(2);
    expect(written![0]).toBe(42);
    expect(objs.list()).toEqual([]);
    expect(await objs.unmap(2, 1)).toBe(-22);
  });

  it('eager: the first map is remote at once, no publish round', async () => {
    const sent: [number, ShmObjMessage][] = [];
    const remotes: SharedArrayBuffer[] = [];
    const objs = new SharedObjects((i, m) => sent.push([i, m]));
    const r = await objs.map(1, 'e', 64, () => new Uint8Array([5]), undefined, { eager: true, onRemote: (b) => remotes.push(b) });
    expect(r).toEqual({ id: 1, remote: true });
    expect(sent.map(([i, m]) => [i, m.type])).toEqual([[1, 'blink-shmobj']]);
    expect(remotes.length).toBe(1);
    expect(new Uint8Array(remotes[0])[0]).toBe(5);
    expect(await objs.map(2, 'e', 64, undefined, undefined, { eager: true })).toEqual({ id: 1, remote: true });
    expect(sent.map(([, m]) => m.type)).toEqual(['blink-shmobj', 'blink-shmobj']); // still no publish
  });

  it('two workers on one object: atomics and wait/notify cross (what Blink\'s remote pages do)', async () => {
    const sab = new SharedArrayBuffer(64);
    const code = `
      const { workerData, parentPort } = require('node:worker_threads');
      const i32 = new Int32Array(workerData.sab);
      if (workerData.role === 'waiter') {
        // sem_wait: take one when there is one, else futex-wait on the word
        for (;;) {
          const v = Atomics.load(i32, 0);
          if (v > 0 && Atomics.compareExchange(i32, 0, v, v - 1) === v) break;
          Atomics.wait(i32, 0, v, 5000);
        }
        parentPort.postMessage('took');
      } else {
        for (let k = 0; k < 1000; k++) Atomics.add(i32, 1, 1);
        Atomics.add(i32, 0, 1);  // sem_post
        Atomics.notify(i32, 0, 1);
        parentPort.postMessage('posted');
      }`;
    const run = (role: string) => new Promise<string>((resolve, reject) => {
      const w = new Worker(code, { eval: true, workerData: { sab, role } });
      w.once('message', (m) => { void w.terminate(); resolve(m); });
      w.once('error', reject);
    });
    const waiter = run('waiter');
    await new Promise((r) => setTimeout(r, 30));
    const [a, b] = await Promise.all([run('poster'), run('poster')]);
    expect([a, b]).toEqual(['posted', 'posted']);
    expect(await waiter).toBe('took');
    const i32 = new Int32Array(sab);
    expect(i32[1]).toBe(2000); // no lost updates
    expect(i32[0]).toBe(1);
  });
});

describe('SharedObjects through the kernel (SYS_shiro_shmobj_*)', () => {
  it('a /dev/shm file and a SysV segment; processes of two instances', async () => {
    const { fs } = await createTestShell();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const inbox: Record<number, ShmObjMessage[]> = { };
    const inst = (n: number) => { const id = kernel.registerEngineInstance((m) => (inbox[id] ??= []).push(m)); return id; };
    const ia = inst(1), ib = inst(2);
    const spawn = (i: number) => {
      const p = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, run: () => new Promise<number>(() => {}) });
      p.data.engineInstance = i;
      return p;
    };
    const a = spawn(ia), b = spawn(ib);
    await fs.mkdir('/dev/shm', { recursive: true }).catch(() => {});
    await fs.writeFile('/dev/shm/sem.x', new Uint8Array(32).fill(1));
    const open = async (p: typeof a, path: string) => {
      const d = new Uint8Array(256); const e = new TextEncoder().encode(path); d.set(e);
      return kernel.syscall(p, A.SYS_openat, [A.AT_FDCWD, e.length, A.O_RDWR, 0], d);
    };
    const map = async (p: typeof a, h: number, kind: number, len: number) => {
      const d = new Uint8Array(8);
      const id = await kernel.syscall(p, A.SYS_shiro_shmobj_map, [h, kind, len, 0], d);
      return { id, remote: new DataView(d.buffer).getInt32(0, true) };
    };
    const fa = await open(a, '/dev/shm/sem.x'), fb = await open(b, '/dev/shm/sem.x');
    const m1 = await map(a, fa, 0, 32);
    expect(m1.remote).toBe(0);
    const pending = map(b, fb, 0, 32);
    await new Promise((r) => setTimeout(r, 20));
    expect(inbox[ia]?.map((m) => m.type)).toEqual(['blink-shmobj', 'blink-publish']);
    expect(await kernel.syscall(a, A.SYS_shiro_shmobj_published, [m1.id], new Uint8Array(8))).toBe(0);
    const m2 = await pending;
    expect(m2).toEqual({ id: m1.id, remote: 1 });
    const sab = (inbox[ib][0] as { sab: SharedArrayBuffer }).sab;
    expect(new Uint8Array(sab)[0]).toBe(1);
    new Uint8Array(sab)[0] = 99; // a store through a remote page
    expect(await kernel.syscall(a, A.SYS_shiro_shmobj_unmap, [m1.id], new Uint8Array(8))).toBe(0);
    await kernel.engineInstanceGone(ib);
    expect(((await fs.readFile('/dev/shm/sem.x')) as Uint8Array)[0]).toBe(99); // written back
    // not shareable: an ordinary file
    await fs.writeFile('/tmp/plain', 'x');
    expect((await map(a, await open(a, '/tmp/plain'), 0, 1)).id).toBe(-A.EINVAL);
    // a SysV segment
    const shmid = await kernel.syscall(a, A.SYS_shmget, [IPC_PRIVATE, 4096, 0, 0o600], new Uint8Array(8));
    expect((await map(a, shmid, 1, 0)).remote).toBe(0);
    // kind flags other than eager are EINVAL
    expect((await map(a, shmid, 1 | 0x200, 0)).id).toBe(-A.EINVAL);
    // no engine instance: not for this process
    const c = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, run: () => new Promise<number>(() => {}) });
    expect(await kernel.syscall(c, A.SYS_shiro_shmobj_map, [shmid, 1, 0, 0], new Uint8Array(8))).toBe(-A.ENOSYS);
  });
});

describe('SharedObjects: a memfd passed between instances', () => {
  it('maps eagerly; read/write on the fd and the buffer agree; the bytes stay after the last unmap', async () => {
    const { fs } = await createTestShell();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const inbox: Record<number, ShmObjMessage[]> = {};
    const inst = () => { const id = kernel.registerEngineInstance((m) => (inbox[id] ??= []).push(m)); return id; };
    const ia = inst(), ib = inst();
    const spawn = (i: number) => {
      const p = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, run: () => new Promise<number>(() => {}) });
      p.data.engineInstance = i;
      return p;
    };
    const a = spawn(ia), b = spawn(ib);
    const d = new Uint8Array(4096);
    const name = new TextEncoder().encode('fonts'); d.set(name);
    const fa = await kernel.syscall(a, A.SYS_memfd_create, [name.length, 0], d);
    expect(fa).toBeGreaterThanOrEqual(0);
    d.set(new TextEncoder().encode('hello'));
    expect(await kernel.syscall(a, A.SYS_write, [fa, 5], d)).toBe(5);
    // SCM_RIGHTS: b gets the same description
    const fb = b.fds.alloc(a.fds.get(fa)!);
    const map = async (p: typeof a, fd: number, len: number) => {
      const out = new Uint8Array(8);
      const id = await kernel.syscall(p, A.SYS_shiro_shmobj_map, [fd, A.SHMOBJ_EAGER, len, 0], out);
      return { id, remote: new DataView(out.buffer).getInt32(0, true) };
    };
    const m1 = await map(a, fa, 4096);
    expect(m1.remote).toBe(1);
    expect(inbox[ia].map((m) => m.type)).toEqual(['blink-shmobj']);
    const sab = (inbox[ia][0] as { sab: SharedArrayBuffer }).sab;
    expect(sab.byteLength).toBe(4096);
    expect(new TextDecoder().decode(new Uint8Array(sab, 0, 5))).toBe('hello');
    expect(await map(b, fb, 4096)).toEqual({ id: m1.id, remote: 1 });
    expect((inbox[ib][0] as { sab: SharedArrayBuffer }).sab).toBe(sab);
    // a store through a mapping is what read() sees, and a write() is what the mapping sees
    new Uint8Array(sab)[0] = 0x4a; // 'J'
    expect(await kernel.syscall(b, A.SYS_pread64, [fb, 5, 0, 0], d)).toBe(5);
    expect(new TextDecoder().decode(d.subarray(0, 5))).toBe('Jello');
    d.set(new TextEncoder().encode('!'));
    expect(await kernel.syscall(a, A.SYS_pwrite64, [fa, 1, 5, 0], d)).toBe(1);
    expect(new Uint8Array(sab)[5]).toBe(0x21);
    // the last unmap: private again, with the final bytes
    expect(await kernel.syscall(a, A.SYS_shiro_shmobj_unmap, [m1.id], d)).toBe(0);
    await kernel.engineInstanceGone(ib);
    new Uint8Array(sab)[0] = 0; // no longer the file's memory
    expect(await kernel.syscall(a, A.SYS_pread64, [fa, 6, 0, 0], d)).toBe(6);
    expect(new TextDecoder().decode(d.subarray(0, 6))).toBe('Jello!');
  });
});
