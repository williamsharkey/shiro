import { it, expect, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import { batch, concat, messages, opOf } from './gl-encode';
import { message, MSG_REPLY, u32s } from '@shiro/gl/wire';

/**
 * glshiro's socket server (src/gl/server.ts): a kernel process on an
 * AF_UNIX socket that reassembles batches from the byte stream for each
 * connection's backend and sends the backend's replies back.
 */
let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

async function setup() {
  const { fs } = await createTestShell();
  const { Kernel } = await import('@shiro/kernel/kernel');
  const { netStackOf, installNet } = await import('@shiro/kernel/net');
  const { AF_UNIX, SOCK_STREAM } = await import('@shiro/kernel/abi');
  const { startGLServer, getGLServer } = await import('@shiro/gl/server');
  const kernel = new Kernel({ fs, registerWithProcessTable: false });
  installNet(kernel);
  const stack = netStackOf(kernel)!;
  const backends: { batches: Uint8Array[]; closed: boolean; send: (d: Uint8Array) => void }[] = [];
  const path = '/tmp/.tabcomputer-gl/test';
  const handle = await startGLServer(kernel, async (send) => {
    const b = { batches: [] as Uint8Array[], closed: false, send };
    backends.push(b);
    return {
      run(buf) {
        // reply to each batch with its byte count; a batch for context 99 breaks the stream
        const dv = new DataView(buf);
        for (let o = 0; o < buf.byteLength; o += dv.getUint32(o + 8, true)) {
          if (dv.getUint32(o + 4, true) === 99) return false;
          const len = dv.getUint32(o + 8, true);
          b.batches.push(new Uint8Array(buf, o, len));
          send(message(MSG_REPLY, u32s(len)));
        }
        return true;
      },
      close() { b.closed = true; },
      commands: () => b.batches.length,
      frames: () => 0,
    };
  }, path);
  stop = () => handle.stop();
  const ops = { resolve: (p: string) => p, exists: async (p: string) => fs.exists(p), create: async () => 0 };
  const connect = async () => {
    const s = stack.socket(AF_UNIX, SOCK_STREAM) as InstanceType<typeof import('@shiro/kernel/net').KSocket>;
    const r = await stack.connectUnix(s, { family: AF_UNIX, address: path, port: 0 }, ops);
    expect(r).toBe(0);
    const got: Uint8Array[] = [];
    const read = async (bytes: number) => {
      let n = got.reduce((a, g) => a + g.length, 0);
      const buf = new Uint8Array(4096);
      while (n < bytes) {
        const k = await s.recv(buf);
        if (k <= 0) break;
        got.push(buf.slice(0, k)); n += k;
      }
      return messages(got);
    };
    return { s, read };
  };
  return { handle, backends, connect, getGLServer, fs, path };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

it('listens on its socket as a kernel process', async () => {
  const t = await setup();
  expect(t.getGLServer()).toBe(t.handle);
  expect(await t.fs.exists(t.path)).toBe(true);
  expect(t.handle.proc.pid).toBeGreaterThan(0);
});

it('reassembles batches split anywhere in the stream and replies in order', async () => {
  const t = await setup();
  const c = await t.connect();
  const b1 = batch(1, [['glClear', 0x4000], ['glFlush']]);
  const b2 = batch(2, [['glColor4fv', new Float32Array([1, 2, 3, 4])]]);
  const b3 = batch(1, [['glShaderSource', 3, new Uint8Array(70_000).fill(65)]]);
  const all = concat(b1, b2, b3);
  // byte by byte for the headers, then odd-sized pieces
  for (let i = 0; i < 20; i++) await c.s.send(all.subarray(i, i + 1));
  for (let i = 20; i < all.length; i += 997) await c.s.send(all.subarray(i, Math.min(all.length, i + 997)));
  const replies = await c.read(3 * 12);
  expect(replies.map((m) => [m.kind, new DataView(m.payload.buffer).getUint32(0, true)])).toEqual([
    [MSG_REPLY, b1.length], [MSG_REPLY, b2.length], [MSG_REPLY, b3.length],
  ]);
  await until(() => t.backends[0].batches.length === 3);
  expect(concat(...t.backends[0].batches)).toEqual(all);
  expect(t.handle.clients.size).toBe(1);
  expect(t.handle.connections).toBe(1);
  expect(opOf('glClear')).toBeGreaterThan(0);
});

it('gives each connection its own backend and closes it when the guest goes', async () => {
  const t = await setup();
  const a = await t.connect();
  const b = await t.connect();
  await a.s.send(batch(1, [['glFlush']]));
  await b.s.send(batch(1, [['glFlush'], ['glFlush']]));
  await a.read(12); await b.read(12);
  expect(t.backends).toHaveLength(2);
  await a.s.close();
  await until(() => t.backends.some((x) => x.closed));
  expect(t.handle.clients.size).toBe(1);
  await b.s.close();
  await until(() => t.backends.every((x) => x.closed));
  expect(t.handle.clients.size).toBe(0);
});

it('drops a connection whose stream is broken', async () => {
  const t = await setup();
  const bad = await t.connect();
  const bytes = batch(1, [['glFlush']]);
  new DataView(bytes.buffer).setUint32(0, 0xdeadbeef, true);
  await bad.s.send(bytes);
  await until(() => t.backends[0]?.closed === true);
  // and a batch the backend refuses
  const refused = await t.connect();
  await refused.s.send(batch(99, [['glFlush']]));
  await until(() => t.backends[1]?.closed === true);
  // the server still takes new connections
  const good = await t.connect();
  await good.s.send(batch(1, [['glFlush']]));
  expect((await good.read(12))).toHaveLength(1);
});

it('turns GL on for an X server only with WebGL2, writing the vendor library once', async () => {
  const { fs } = await createTestShell();
  const { Kernel } = await import('@shiro/kernel/kernel');
  const { XServer } = await import('@shiro/x11/server');
  const { prepareGL, installVendorLibrary, VENDOR_LIBRARY } = await import('@shiro/gl/setup');
  const kernel = new Kernel({ fs, registerWithProcessTable: false });
  const off = new XServer({ width: 100, height: 100 });
  expect(await prepareGL(kernel, off, false)).toBe(false);
  expect(off.extensions.has('GLX')).toBe(false);
  let fetches = 0;
  const lib = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
  expect(await installVendorLibrary(kernel, async () => { fetches++; return lib; })).toBe(true);
  expect(new Uint8Array(await fs.readFile(VENDOR_LIBRARY) as Uint8Array)).toEqual(lib);
  // unreachable: keeps the one it has
  expect(await installVendorLibrary(kernel, async () => null)).toBe(true);
  expect(fetches).toBe(1);
});
