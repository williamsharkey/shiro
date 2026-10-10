/**
 * The X display as a kernel process: `Xshiro :N` listens on the AF_UNIX
 * socket /tmp/.X11-unix/XN (and the abstract name libxcb tries first) in the
 * kernel's NetStack, so any kernel process — x86-64 ELF in Blink, WASM —
 * connects with DISPLAY=:N. This module is small and loaded at boot; the
 * server itself (src/x11/session.ts: protocol, fonts, rootless windows) is
 * imported on the first connection.
 */
import type { Kernel } from '../kernel/kernel';
import { netStackOf, installNet, KSocket, type UnixOps } from '../kernel/net';
import { AF_UNIX, SOCK_STREAM } from '../kernel/abi';
import type { Process } from '../kernel/process';

export interface DisplayHandle {
  display: number;
  proc: Process;
  /** Connections accepted so far. */
  connections: number;
  stop(): void;
}

const displays = new Map<number, DisplayHandle>();

export function getDisplay(n = 0): DisplayHandle | undefined { return displays.get(n); }

/** Start (or return) the X display `:n` in `kernel`. */
export async function startDisplay(kernel: Kernel, n = 0): Promise<DisplayHandle> {
  const existing = displays.get(n);
  if (existing) return existing;
  if (!netStackOf(kernel)) installNet(kernel);
  const stack = netStackOf(kernel)!;
  const fs = kernel.fs;
  const path = `/tmp/.X11-unix/X${n}`;
  if (fs) {
    await fs.mkdir('/tmp/.X11-unix', { recursive: true }).catch(() => {});
    if (await fs.exists(path)) await fs.unlink(path).catch(() => {});
  }
  const ops: UnixOps = {
    resolve: (p) => p,
    exists: async (p) => !!fs && (await fs.exists(p)),
    create: async (p) => { if (fs) await fs.writeFile(p, new Uint8Array(0)); return 0; },
  };
  const listeners: KSocket[] = [];
  for (const address of [path, `\0${path}`]) {
    const s = stack.socket(AF_UNIX, SOCK_STREAM);
    if (typeof s === 'number' || !(s instanceof KSocket)) throw new Error(`Xshiro: socket: ${s}`);
    const r = await stack.bindUnix(s, { family: AF_UNIX, address, port: 0 }, ops);
    if (r < 0) throw new Error(`Xshiro: bind ${address.replace('\0', '@')}: errno ${-r}`);
    s.listen(64);
    listeners.push(s);
  }
  let stopped = false;
  let wake: () => void = () => {};
  const done = new Promise<void>((res) => { wake = res; });
  const handle: DisplayHandle = {
    display: n,
    proc: null as unknown as Process,
    connections: 0,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const l of listeners) void l.close();
      displays.delete(n);
      wake();
    },
  };
  const proc = kernel.spawn({
    path: 'Xshiro',
    argv: ['Xshiro', `:${n}`],
    env: { DISPLAY: `:${n}` },
    run: async (p) => {
      for (const l of listeners) l.ownerPid = p.pid;
      for (const l of listeners) void acceptLoop(l, handle, kernel, () => stopped);
      p.onTerminate(() => handle.stop());
      await done;
      return 0;
    },
  });
  handle.proc = proc;
  void proc.wait().then(() => handle.stop());
  displays.set(n, handle);
  return handle;
}

async function acceptLoop(listener: KSocket, handle: DisplayHandle, kernel: Kernel, stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    const s = await listener.accept();
    if (typeof s === 'number') { if (stopped()) return; await new Promise((r) => setTimeout(r, 50)); continue; }
    handle.connections++;
    void serveClient(s, handle.display, kernel);
  }
}

async function serveClient(sock: KSocket, display: number, kernel: Kernel): Promise<void> {
  const { getXSession } = await import('./session');
  const { server } = await getXSession(display);
  // GL apps (docs/research/GL.md): GLX and libGLX_tabcomputer when the page has WebGL2
  await (await import('../gl/setup')).prepareGL(kernel, server);
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  const client = server.connect({
    write: (d) => { chain = chain.then(() => (closed ? 0 : sock.send(d))); },
    close: () => { closed = true; void chain.then(() => sock.close()); },
  });
  const buf = new Uint8Array(256 * 1024);
  for (;;) {
    const n = await sock.recv(buf);
    if (n <= 0) break;
    client.receive(buf.subarray(0, n));
  }
  server.disconnect(client);
  closed = true;
  void sock.close();
}
