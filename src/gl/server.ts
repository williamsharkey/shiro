/**
 * glshiro: the page's GL server as a kernel process. It listens on the
 * AF_UNIX socket /tmp/.tabcomputer-gl/0, where libGLX_tabcomputer (the guest's
 * glvnd vendor library, scripts/gl/) sends its GL command batches, and runs
 * each connection's stream on a WebGL2 executor (exec.ts). Frames go to the
 * X window through Xshiro (present.ts). Small and loaded at boot; the
 * executor is imported on the first connection.
 */
import type { Kernel } from '../kernel/kernel';
import { netStackOf, installNet, KSocket, type UnixOps } from '../kernel/net';
import { AF_UNIX, SOCK_STREAM } from '../kernel/abi';
import type { Process } from '../kernel/process';

export const GL_SOCKET = '/tmp/.tabcomputer-gl/0';
const MAGIC = 0x4c474354;

export interface GLServerHandle {
  proc: Process;
  connections: number;
  /** live connections: pid of the guest and its executor's stats */
  clients: Set<{ commands: () => number; frames: () => number }>;
  stop(): void;
}

let running: GLServerHandle | null = null;
export function getGLServer(): GLServerHandle | null { return running; }

/** What a connection needs from its executor; exec.ts provides the real one. */
export interface Backend {
  run(batch: ArrayBuffer): boolean;
  close(): void;
  commands(): number;
  frames(): number;
}
export type BackendFactory = (send: (data: Uint8Array) => void) => Promise<Backend>;

export async function startGLServer(kernel: Kernel, factory?: BackendFactory, path = GL_SOCKET): Promise<GLServerHandle> {
  if (running) return running;
  if (!netStackOf(kernel)) installNet(kernel);
  const stack = netStackOf(kernel)!;
  const fs = kernel.fs;
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (fs) {
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    if (await fs.exists(path)) await fs.unlink(path).catch(() => {});
  }
  const ops: UnixOps = {
    resolve: (p) => p,
    exists: async (p) => !!fs && (await fs.exists(p)),
    create: async (p) => { if (fs) await fs.writeFile(p, new Uint8Array(0)); return 0; },
  };
  const s = stack.socket(AF_UNIX, SOCK_STREAM);
  if (typeof s === 'number' || !(s instanceof KSocket)) throw new Error(`glshiro: socket: ${s}`);
  const r = await stack.bindUnix(s, { family: AF_UNIX, address: path, port: 0 }, ops);
  if (r < 0) throw new Error(`glshiro: bind ${path}: errno ${-r}`);
  s.listen(64);
  let stopped = false;
  let wake: () => void = () => {};
  const done = new Promise<void>((res) => { wake = res; });
  const handle: GLServerHandle = {
    proc: null as unknown as Process,
    connections: 0,
    clients: new Set(),
    stop() {
      if (stopped) return;
      stopped = true;
      void s.close();
      running = null;
      wake();
    },
  };
  const make = factory ?? defaultFactory;
  handle.proc = kernel.spawn({
    path: 'glshiro',
    argv: ['glshiro', path],
    env: {},
    run: async (p) => {
      s.ownerPid = p.pid;
      void (async () => {
        while (!stopped) {
          const c = await s.accept();
          if (typeof c === 'number') { if (stopped) return; await new Promise((res) => setTimeout(res, 50)); continue; }
          handle.connections++;
          void serve(c, make, handle);
        }
      })();
      p.onTerminate(() => handle.stop());
      await done;
      return 0;
    },
  });
  void handle.proc.wait().then(() => handle.stop());
  running = handle;
  return handle;
}

async function defaultFactory(send: (data: Uint8Array) => void): Promise<Backend> {
  const { createWebGLBackend } = await import('./present');
  return createWebGLBackend(send);
}

async function serve(sock: KSocket, make: BackendFactory, handle: GLServerHandle): Promise<void> {
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  const send = (d: Uint8Array) => { chain = chain.then(() => (closed ? 0 : sock.send(d))); };
  let backend: Backend;
  try {
    backend = await make(send);
  } catch (e) {
    console.warn('[glshiro]', e);
    void sock.close();
    return;
  }
  const stats = { commands: () => backend.commands(), frames: () => backend.frames() };
  handle.clients.add(stats);
  // reassemble batches: u32 magic, u32 context, u32 bytes
  let pending = new Uint8Array(1 << 20);
  let have = 0;
  const buf = new Uint8Array(1 << 20);
  try {
    for (;;) {
      const n = await sock.recv(buf);
      if (n <= 0) break;
      if (have + n > pending.length) {
        let size = pending.length * 2;
        while (size < have + n) size *= 2;
        const np = new Uint8Array(size);
        np.set(pending.subarray(0, have));
        pending = np;
      }
      pending.set(buf.subarray(0, n), have);
      have += n;
      const dv = new DataView(pending.buffer);
      let off = 0;
      let end = 0;
      while (have - off >= 12) {
        if (dv.getUint32(off, true) !== MAGIC) throw new Error('bad batch header');
        const len = dv.getUint32(off + 8, true);
        if (len < 12) throw new Error('bad batch length');
        if (have - off < len) break;
        off += len;
        end = off;
      }
      if (end) {
        // whole batches in one piece; the executor decodes them in order
        if (!backend.run(pending.slice(0, end).buffer)) throw new Error('the GL stream broke');
        pending.copyWithin(0, end, have);
        have -= end;
      }
    }
  } catch (e) {
    console.warn('[glshiro]', (e as Error).message);
  } finally {
    handle.clients.delete(stats);
    backend.close();
    closed = true;
    void chain.then(() => sock.close());
  }
}
