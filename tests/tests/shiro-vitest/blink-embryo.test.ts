/**
 * A Blink process whose engine goes away mid-fork (an engine abort while
 * dpkg forked) leaves a child it never started. That child must die rather
 * than hold the parent's fds open: apt waited forever for EOF on dpkg's
 * --status-fd pipe with no CPU in use.
 */
import { describe, it, expect } from 'vitest';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { wireWorker } from '@shiro/x86-engine/blink';

describe('Blink fork children the engine never started', () => {
  it('die when the engine worker ends, closing the pipe they held; started children are left alone', async () => {
    const kernel = new Kernel({ registerWithProcessTable: false });
    const apt = kernel.spawn({ path: 'apt', cwd: '/', run: () => new Promise<number>(() => {}) });
    const data = new Uint8Array(64);
    expect(await kernel.syscall(apt, A.SYS_pipe2, [0], data)).toBe(0);
    const [rfd, wfd] = [new DataView(data.buffer).getInt32(0, true), new DataView(data.buffer).getInt32(4, true)];
    // dpkg inherits the write end, then forks (the child is an embryo until the engine starts it)
    const dpkg = kernel.spawn({ path: 'dpkg', cwd: '/', parent: apt, run: () => new Promise<number>(() => {}) });
    await kernel.syscall(apt, A.SYS_close, [wfd], data);
    const embryo = kernel.vfork(dpkg);
    const started = kernel.vfork(dpkg);
    kernel.startEmbryo(started, () => new Promise<number>(() => {}));

    let terminated = false;
    const w: any = { postMessage() {}, onMessage() {}, onError() {}, terminate: () => { terminated = true; } };
    wireWorker(dpkg, w, kernel, []);
    // the engine aborts: the process exits and its worker is terminated
    await kernel.exit(dpkg, W(134));
    w.terminate();
    expect(terminated).toBe(true);
    await new Promise((r) => setTimeout(r, 1200));
    expect(embryo.state).toBe('zombie');
    expect(started.state).toBe('running');
    // with the embryo gone only `started` holds the write end
    await kernel.exit(started, 0);
    expect(await kernel.syscall(apt, A.SYS_read, [rfd, 16], data)).toBe(0); // EOF
  });

  it("an engine crash kills the fork children it hosted (they ran in the dead instance) but not before", async () => {
    const kernel = new Kernel({ registerWithProcessTable: false });
    const dpkg = kernel.spawn({ path: 'dpkg', cwd: '/', run: () => new Promise<number>(() => {}) });
    let send: (m: unknown) => void = () => {};
    let errored: (e: unknown) => void = () => {};
    const w: any = { postMessage() {}, onMessage: (cb: any) => { send = cb; }, onError: (cb: any) => { errored = cb; }, terminate() {} };
    wireWorker(dpkg, w, kernel, []);
    const a = kernel.vfork(dpkg);
    send({ type: 'blink-hosted', pid: a.pid });
    // the parent exiting normally leaves a hosted child running (daemon())
    await kernel.exit(dpkg, 0);
    w.terminate();
    await new Promise((r) => setTimeout(r, 1200));
    expect(a.state).toBe('running');
    // the instance aborts: blink-abort (host.mjs's fail) or a worker error
    send({ type: 'blink-abort', text: 'aborted: ' });
    await new Promise((r) => setTimeout(r, 10));
    expect(a.state).toBe('zombie');

    const parent2 = kernel.spawn({ path: 'dpkg', cwd: '/', run: () => new Promise<number>(() => {}) });
    const w2: any = { postMessage() {}, onMessage: (cb: any) => { send = cb; }, onError: (cb: any) => { errored = cb; }, terminate() {} };
    wireWorker(parent2, w2, kernel, []);
    const b = kernel.vfork(parent2);
    send({ type: 'blink-hosted', pid: b.pid });
    errored(new Error('memory access out of bounds'));
    await new Promise((r) => setTimeout(r, 10));
    expect(b.state).toBe('zombie');
  });
});

function W(code: number) { return (code & 0xff) << 8; }
