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

  it('kind | 0x100 (Blink\'s way): remote from the first mapping; a memfd is one object however its fd travels', async () => {
    const { fs } = await createTestShell();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const inbox: Record<number, ShmObjMessage[]> = { };
    const inst = () => { const id = kernel.registerEngineInstance((m) => (inbox[id] ??= []).push(m)); return id; };
    const ia = inst(), ib = inst();
    const spawn = (i: number) => {
      const p = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, run: () => new Promise<number>(() => {}) });
      p.data.engineInstance = i;
      return p;
    };
    const a = spawn(ia), b = spawn(ib);
    const map = async (p: typeof a, fd: number, len: number) => {
      const d = new Uint8Array(8);
      const id = await kernel.syscall(p, A.SYS_shiro_shmobj_map, [fd, 0x100, len, 0], d);
      return { id, remote: new DataView(d.buffer).getInt32(0, true) };
    };
    const name = new TextEncoder().encode('fonts');
    const fd = await kernel.syscall(a, A.SYS_memfd_create, [name.length, 0], name);
    expect(await kernel.syscall(a, A.SYS_write, [fd, 5], new TextEncoder().encode('hello'))).toBe(5);
    // the first mapper is remote at once: no publish round to wait for
    const m1 = await map(a, fd, 4096);
    expect(m1.remote).toBe(1);
    expect(inbox[ia].map((m) => m.type)).toEqual(['blink-shmobj']);
    const sab = (inbox[ia][0] as { sab: SharedArrayBuffer }).sab;
    expect(sab.byteLength).toBe(8192); // the bytes, then a page of control words
    expect(new TextDecoder().decode(new Uint8Array(sab, 0, 5))).toBe('hello'); // seeded from the memfd
    // the same file in another process (SCM_RIGHTS or exec give it the same open file)
    const fb = b.fds.alloc(a.fds.get(fd)!, 0, false);
    expect(await map(b, fb, 4096)).toEqual({ id: m1.id, remote: 1 });
    expect((inbox[ib][0] as { sab: SharedArrayBuffer }).sab).toBe(sab);
    new Uint8Array(sab).set(new TextEncoder().encode('HELLO'));
    await kernel.engineInstanceGone(ia);
    await kernel.engineInstanceGone(ib);
    const back = new Uint8Array(5);
    expect(await kernel.syscall(a, A.SYS_pread64, [fd, 5, 0, 0], back)).toBe(5);
    expect(new TextDecoder().decode(back)).toBe('HELLO'); // written back to the memfd
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
    expect(sab.byteLength).toBe(4096 + 4096); // the bytes (whole pages), then the control page
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

describe('SharedObjects: a /dev/shm file mapped remote', () => {
  // conformance's report: shm_open, ftruncate, mmap MAP_SHARED, p[1] = 'a', munmap, pread
  it('pread sees the mapping, the mapping sees pwrite, an fd opened later too; the bytes stay after the last unmap', async () => {
    const { fs } = await createTestShell();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const inbox: Record<number, ShmObjMessage[]> = {};
    const ia = kernel.registerEngineInstance((m) => (inbox[ia] ??= []).push(m));
    const a = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, run: () => new Promise<number>(() => {}) });
    a.data.engineInstance = ia;
    await fs.mkdir('/dev/shm', { recursive: true }).catch(() => {});
    await fs.writeFile('/dev/shm/coh', new Uint8Array(12288));
    const d = new Uint8Array(256);
    const open = async () => {
      const e = new TextEncoder().encode('/dev/shm/coh'); d.set(e);
      return kernel.syscall(a, A.SYS_openat, [A.AT_FDCWD, e.length, A.O_RDWR, 0], d);
    };
    const pread = async (fd: number, off: number) => {
      const b = new Uint8Array(1);
      return (await kernel.syscall(a, A.SYS_pread64, [fd, 1, off, 0], b)) === 1 ? String.fromCharCode(b[0]) : '?';
    };
    const fd = await open();
    const out = new Uint8Array(8);
    const id = await kernel.syscall(a, A.SYS_shiro_shmobj_map, [fd, A.SHMOBJ_EAGER, 12288, 0], out);
    expect(new DataView(out.buffer).getInt32(0, true)).toBe(1);
    const sab = (inbox[ia][0] as { sab: SharedArrayBuffer }).sab;
    const mem = new Uint8Array(sab);
    mem[1] = 0x61; // 'a' through the mapping
    expect(await pread(fd, 1)).toBe('a');
    d[0] = 0x77; // 'w' through the fd
    expect(await kernel.syscall(a, A.SYS_pwrite64, [fd, 1, 2, 0], d)).toBe(1);
    expect(mem[2]).toBe(0x77);
    // shm_open, mmap, close, then shm_open again: the new inode reads the mapping too
    expect(await kernel.syscall(a, A.SYS_close, [fd], d)).toBe(0);
    mem[3] = 0x7a; // 'z'
    const fd2 = await open();
    expect(await pread(fd2, 3)).toBe('z');
    // munmap: the fd keeps the final bytes (the pwrite included), and so does the file
    expect(await kernel.syscall(a, A.SYS_shiro_shmobj_unmap, [id], d)).toBe(0);
    mem.fill(0, 0, 8); // no longer the file's memory
    expect([await pread(fd2, 1), await pread(fd2, 2), await pread(fd2, 3)].join('')).toBe('awz');
    expect(await kernel.syscall(a, A.SYS_close, [fd2], d)).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(Array.from((await fs.readFile('/dev/shm/coh') as Uint8Array).subarray(1, 4))).toEqual([0x61, 0x77, 0x7a]);
    await kernel.engineInstanceGone(ia);
    kernel.dispose();
  });
  it('the same with a 6 MiB file (a big file the kernel holds as pages): pages not yet written back, the mapping, pwrite and munmap agree', async () => {
    const { fs } = await createTestShell();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const inbox: Record<number, ShmObjMessage[]> = {};
    const ia = kernel.registerEngineInstance((m) => (inbox[ia] ??= []).push(m));
    const a = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, run: () => new Promise<number>(() => {}) });
    a.data.engineInstance = ia;
    const SZ = 6 << 20, HI = (5 << 20) + 77;
    await fs.mkdir('/dev/shm', { recursive: true }).catch(() => {});
    await fs.writeFile('/dev/shm/big', new Uint8Array(SZ));
    expect(fs.blobOf('/dev/shm/big')).toBeTruthy();
    const d = new Uint8Array(256);
    const open = async () => {
      const e = new TextEncoder().encode('/dev/shm/big'); d.set(e);
      return kernel.syscall(a, A.SYS_openat, [A.AT_FDCWD, e.length, A.O_RDWR, 0], d);
    };
    const pread = async (fd: number, off: number) => {
      const b = new Uint8Array(1);
      return (await kernel.syscall(a, A.SYS_pread64, [fd, 1, off, 0], b)) === 1 ? String.fromCharCode(b[0]) : '?';
    };
    const pwrite = (fd: number, off: number, c: string) => { d[0] = c.charCodeAt(0); return kernel.syscall(a, A.SYS_pwrite64, [fd, 1, off, 0], d); };
    const fd = await open();
    expect(await pwrite(fd, HI, 'p')).toBe(1); // a page written, not yet back in the FileSystem
    const out = new Uint8Array(8);
    const id = await kernel.syscall(a, A.SYS_shiro_shmobj_map, [fd, A.SHMOBJ_EAGER, SZ, 0], out);
    expect(new DataView(out.buffer).getInt32(0, true)).toBe(1);
    const mem = new Uint8Array((inbox[ia][0] as { sab: SharedArrayBuffer }).sab);
    expect(String.fromCharCode(mem[HI])).toBe('p'); // the buffer starts with the inode's pages
    mem[HI + 1] = 0x61; // 'a' through the mapping
    expect(await pread(fd, HI + 1)).toBe('a');
    expect(await pwrite(fd, HI + 2, 'w')).toBe(1);
    expect(String.fromCharCode(mem[HI + 2])).toBe('w');
    expect(await kernel.syscall(a, A.SYS_close, [fd], d)).toBe(0);
    mem[HI + 3] = 0x7a; // 'z'
    const fd2 = await open();
    expect(await pread(fd2, HI + 3)).toBe('z');
    expect(await kernel.syscall(a, A.SYS_shiro_shmobj_unmap, [id], d)).toBe(0);
    mem.fill(0, HI, HI + 8); // no longer the file's memory
    expect((a.fds.get(fd2) as any).ino.blob).toBeTruthy(); // pages again, not a whole copy
    expect([await pread(fd2, HI), await pread(fd2, HI + 1), await pread(fd2, HI + 2), await pread(fd2, HI + 3)].join('')).toBe('pawz');
    expect(await pwrite(fd2, SZ - 1, 'e')).toBe(1); // still writable after the detach
    expect(await kernel.syscall(a, A.SYS_close, [fd2], d)).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    await fs.sync();
    const back = await fs.readFile('/dev/shm/big') as Uint8Array;
    expect(back.length).toBe(SZ);
    expect(String.fromCharCode(...back.subarray(HI, HI + 4), back[SZ - 1])).toBe('pawze');
    expect(back.subarray(0, HI).every((x) => x === 0)).toBe(true);
    expect(fs.blobOf('/dev/shm/big')).toBeTruthy(); // stored as blocks again
    // A mapping of less than the file: the inode stays pages, and munmap writes the mapping back into them
    const fd3 = await open();
    const id2 = await kernel.syscall(a, A.SYS_shiro_shmobj_map, [fd3, A.SHMOBJ_EAGER, 12288, 0], out);
    expect(id2).toBeGreaterThan(0);
    const mem2 = new Uint8Array((inbox[ia].filter((m) => (m as { id?: number }).id === id2 && 'sab' in m).pop() as { sab: SharedArrayBuffer }).sab);
    mem2[5] = 0x6d; // 'm'
    expect(await kernel.syscall(a, A.SYS_shiro_shmobj_unmap, [id2], d)).toBe(0);
    expect([await pread(fd3, 5), await pread(fd3, HI)].join('')).toBe('mp');
    expect(await kernel.syscall(a, A.SYS_close, [fd3], d)).toBe(0);
    await kernel.engineInstanceGone(ia);
    kernel.dispose();
  });
  it('a /dev/shm file with two names: an fd opened through the other name while mapped uses the mapping', async () => {
    const { fs } = await createTestShell();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const inbox: Record<number, ShmObjMessage[]> = {};
    const ia = kernel.registerEngineInstance((m) => (inbox[ia] ??= []).push(m));
    const a = kernel.spawn({ path: 'p', cwd: '/tmp', uid: 1000, run: () => new Promise<number>(() => {}) });
    a.data.engineInstance = ia;
    await fs.mkdir('/dev/shm', { recursive: true }).catch(() => {});
    await fs.writeFile('/dev/shm/two', new Uint8Array(8192));
    await fs.link('/dev/shm/two', '/dev/shm/two.link');
    const d = new Uint8Array(256);
    const open = async (p: string) => { const e = new TextEncoder().encode(p); d.set(e); return kernel.syscall(a, A.SYS_openat, [A.AT_FDCWD, e.length, A.O_RDWR, 0], d); };
    const fd = await open('/dev/shm/two');
    const out = new Uint8Array(8);
    const id = await kernel.syscall(a, A.SYS_shiro_shmobj_map, [fd, A.SHMOBJ_EAGER, 8192, 0], out);
    const mem = new Uint8Array((inbox[ia][0] as { sab: SharedArrayBuffer }).sab);
    mem[7] = 0x6c; // 'l' through the mapping
    expect(await kernel.syscall(a, A.SYS_close, [fd], d)).toBe(0);
    const fd2 = await open('/dev/shm/two.link'); // the other name, opened while mapped
    const b = new Uint8Array(1);
    expect(await kernel.syscall(a, A.SYS_pread64, [fd2, 1, 7, 0], b)).toBe(1);
    expect(b[0]).toBe(0x6c);
    d[0] = 0x6b; // 'k' through it
    expect(await kernel.syscall(a, A.SYS_pwrite64, [fd2, 1, 8, 0], d)).toBe(1);
    expect(mem[8]).toBe(0x6b);
    expect(await kernel.syscall(a, A.SYS_shiro_shmobj_unmap, [id], d)).toBe(0);
    expect(await kernel.syscall(a, A.SYS_close, [fd2], d)).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(Array.from((await fs.readFile('/dev/shm/two') as Uint8Array).subarray(7, 9))).toEqual([0x6c, 0x6b]);
    expect(Array.from((await fs.readFile('/dev/shm/two.link') as Uint8Array).subarray(7, 9))).toEqual([0x6c, 0x6b]);
    await kernel.engineInstanceGone(ia);
    kernel.dispose();
  });
});
