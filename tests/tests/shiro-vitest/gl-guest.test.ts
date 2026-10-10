import { it, expect } from 'vitest';
import { readdirSync, lstatSync, readlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTestShell } from './helpers';
import { mockWebGL2 } from './gl-mock';

/**
 * libGLX_tabcomputer in Blink (docs/research/GL.md): glxinfo and glxgears
 * from Debian's mesa-utils, with libglvnd, against headless Xshiro and
 * glshiro on a recording WebGL2 stand-in. Skipped unless GL_PROBE_ROOT is a
 * rootfs with them (scripts/gui/debfetch.py: mesa-utils-bin libgl1 libglx0,
 * SKIP=libglx-mesa0,libgl1-mesa-dri) and the vendor library built into
 * public/gui/lib (scripts/gl/build.sh).
 */
const ROOT = process.env.GL_PROBE_ROOT;
const LIB = join(__dirname, '../../../public/gui/lib/libGLX_tabcomputer.so.0');

async function load(fs: any, host: string, guest: string) {
  for (const n of readdirSync(host)) {
    const h = join(host, n), g = guest + '/' + n;
    if (/^\/usr\/share\/(man|doc|locale|info)/.test(g)) continue;
    const st = lstatSync(h);
    if (st.isSymbolicLink()) { try { await fs.symlink(readlinkSync(h), g); } catch { /* exists */ } }
    else if (st.isDirectory()) { await fs.mkdir(g, { recursive: true }); await load(fs, h, g); }
    else await fs.writeFile(g, readFileSync(h), { mode: st.mode & 0o777 });
  }
}

async function setup() {
  const { fs } = await createTestShell();
  await load(fs, ROOT!, '');
  await fs.writeFile('/usr/lib/x86_64-linux-gnu/libGLX_tabcomputer.so.0', readFileSync(LIB), { mode: 0o755 });
  await fs.mkdir('/tmp', { recursive: true });
  const { Kernel } = await import('@shiro/kernel/kernel');
  const { BufferFile } = await import('@shiro/kernel/fd');
  const { registerBlinkLoader } = await import('@shiro/x86-engine/blink');
  const { startDisplay } = await import('@shiro/x11/display');
  const { getXSession, configureXSession } = await import('@shiro/x11/session');
  const { installGLX } = await import('@shiro/gl/glx-ext');
  const { startGLServer } = await import('@shiro/gl/server');
  const { Executor } = await import('@shiro/gl/exec');
  const kernel = new Kernel({ fs, registerWithProcessTable: false });
  registerBlinkLoader(kernel);
  (await import('@shiro/kernel/pty')).attachKernelTty(kernel);
  configureXSession({ headless: true });
  await startDisplay(kernel, 0);
  const { server } = await getXSession(0);
  installGLX(server);
  const mock = mockWebGL2();
  const frames: { xid: number; width: number; height: number }[] = [];
  const execs: InstanceType<typeof Executor>[] = [];
  await startGLServer(kernel, async (send) => {
    const ex = new Executor(mock.gl, {
      send, presentMode: 'pixels',
      drawableSize: (xid) => { try { const d = server.drawable(xid); return { width: d.pix.width, height: d.pix.height }; } catch { return null; } },
      present: (xid, f) => frames.push({ xid, width: f.width, height: f.height }),
      log: (m) => console.log(m),
    });
    execs.push(ex);
    return { run: (b) => ex.run(b), close() {}, commands: () => ex.executed, frames: () => ex.frames };
  });
  const run = async (argv: string[], ms: number, env: Record<string, string> = {}) => {
    const out = new BufferFile(null);
    const p = kernel.spawn({ path: argv[0], argv, cwd: '/', env: { DISPLAY: ':0', PATH: '/usr/bin:/bin', HOME: '/root', __GLX_VENDOR_LIBRARY_NAME: 'tabcomputer', ...env }, fds: { 0: new BufferFile(''), 1: out, 2: out } });
    const t0 = Date.now();
    const status = await Promise.race([p.wait(), new Promise<number>((r) => setTimeout(() => { p.kill?.(9); r(-1); }, ms))]);
    return { status, out: out.text(), ms: Date.now() - t0 };
  };
  return { run, mock, frames, execs };
}

it.skipIf(!ROOT || !existsSync(LIB))('glxinfo and glxgears through glshiro', async () => {
  const { run, mock, frames, execs } = await setup();
  const info = await run(['/usr/bin/glxinfo.x86_64-linux-gnu'], 120_000);
  console.log(`glxinfo: status ${info.status} in ${info.ms} ms`);
  expect(info.out).toContain('OpenGL vendor string: tabcomputer');
  expect(info.out).toContain('OpenGL version string: 2.1 tabcomputer');
  expect(info.out).toContain('OpenGL core profile version string: 3.3 (Core Profile) tabcomputer');
  expect(info.status).toBe(0);
  mock.clear();
  // glxgears prints its rate every 5 s: run it ~12 s
  const gears = await run(['/usr/bin/glxgears.x86_64-linux-gnu'], 12_000);
  console.log(gears.out);
  const ex = execs[execs.length - 1];
  console.log(`glxgears: ${frames.length} frames, ${ex.executed} commands, ${mock.count('drawElements')} drawElements`);
  expect(frames.length).toBeGreaterThan(3);
  expect(frames[0]).toMatchObject({ width: 300, height: 300 });
  expect(mock.count('drawElements') + mock.count('drawArrays')).toBeGreaterThan(frames.length);
}, 200_000);

/** Transport numbers (scripts/gl/probes/glbench.c in the rootfs's /usr/bin): round trips, bulk MB/s, small calls/s. */
it.skipIf(!ROOT || !existsSync(LIB) || !existsSync(join(ROOT ?? '', 'usr/bin/glbench')))('glbench', async () => {
  const { run } = await setup();
  const r = await run(['/usr/bin/glbench', '3'], 120_000);
  console.log(r.out);
  expect(r.out).toMatch(/upload [\d.]+ MB\/s/);
}, 200_000);
