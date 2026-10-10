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

async function setup(root = ROOT!) {
  const { fs } = await createTestShell();
  await load(fs, root, '');
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
  const frames: { xid: number; width: number; height: number; t: number }[] = [];
  const execs: InstanceType<typeof Executor>[] = [];
  const logs: string[] = [];
  await startGLServer(kernel, async (send) => {
    const ex = new Executor(mock.gl, {
      send, presentMode: 'pixels',
      drawableSize: (xid) => { try { const d = server.drawable(xid); return { width: d.pix.width, height: d.pix.height }; } catch { return null; } },
      present: (xid, f) => frames.push({ xid, width: f.width, height: f.height, t: Date.now() }),
      log: (m) => { logs.push(m); console.log(m); },
    });
    execs.push(ex);
    return { run: (b) => ex.run(b), close() {}, commands: () => ex.executed, frames: () => ex.frames };
  });
  const run = async (argv: string[], ms: number, env: Record<string, string> = {}) => {
    const out = new BufferFile(null);
    // as in the page, nothing forces the vendor: libglvnd asks Xshiro's GLX (GLX_VENDOR_NAMES_EXT)
    const p = kernel.spawn({ path: argv[0], argv, cwd: '/', env: { DISPLAY: ':0', PATH: '/usr/bin:/bin', HOME: '/root', ...env }, fds: { 0: new BufferFile(''), 1: out, 2: out } });
    const t0 = Date.now();
    const status = await Promise.race([p.wait(), new Promise<number>((r) => setTimeout(() => { p.kill?.(9); r(-1); }, ms))]);
    return { status, out: out.text(), ms: Date.now() - t0 };
  };
  return { run, mock, frames, execs, logs, fs };
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

/**
 * Stage 3 (docs/research/GL.md): OpenSCAD, a GL 2.1 app (Qt 5, GLEW, OpenCSG).
 * SCAD_ROOT is a rootfs with openscad and its libraries but not Mesa's vendor
 * library. Its PNG export renders offscreen through GLX and FBOs and reads back.
 * Fails today before any GL: CGAL checks at startup that SSE arithmetic follows
 * MXCSR's rounding mode (fesetround), and Blink rounds to nearest always.
 */
const SCAD_ROOT = process.env.SCAD_ROOT;
it.skipIf(!SCAD_ROOT || !existsSync(LIB))('OpenSCAD exports a preview through glshiro', async () => {
  const { run, mock, logs, fs } = await setup(SCAD_ROOT);
  await fs.writeFile('/tmp/t.scad', 'difference() { cube(10, center = true); sphere(6.5); }\ntranslate([12, 0, 0]) cylinder(h = 8, r = 3);\n');
  const r = await run(['/usr/bin/openscad', '-o', '/tmp/t.png', '--imgsize=256,256', '/tmp/t.scad'], 600_000, { HOME: '/tmp', QT_QPA_PLATFORM: 'offscreen' });
  console.log(`openscad: status ${r.status} in ${r.ms} ms\n${r.out}`);
  console.log(`GL calls: ${mock.calls.length}, draws ${mock.count('drawArrays') + mock.count('drawElements')}, readPixels ${mock.count('readPixels')}; warnings:\n${[...new Set(logs)].join('\n')}`);
  expect(r.status).toBe(0);
  const png = await fs.readFile('/tmp/t.png') as Uint8Array;
  expect(Array.from(png.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
}, 700_000);

/**
 * Stage 3, another GL 2.1 app: Neverball (SDL 2, fixed-function GL with
 * vertex buffers and textures). NB_ROOT is a rootfs with neverball, its data
 * and libraries, without Mesa's vendor library. Its title screen flies a
 * camera over a level; the frame rate is glshiro's count.
 */
const NB_ROOT = process.env.NB_ROOT;
it.skipIf(!NB_ROOT || !existsSync(LIB))('Neverball draws its title screen through glshiro', async () => {
  const { run, mock, logs, fs, frames, execs } = await setup(NB_ROOT);
  await fs.mkdir('/tmp/home/.neverball', { recursive: true });
  await fs.writeFile('/tmp/home/.neverball/neverballrc', 'fullscreen 0\nwidth 640\nheight 480\nfps 1\naudio_buff 2048\n');
  const seconds = Number(process.env.NB_SECONDS ?? 60);
  const r = await run(['/usr/games/neverball'], seconds * 1000, { HOME: '/tmp/home', SDL_AUDIODRIVER: 'dummy' });
  const ex = execs[execs.length - 1];
  const t = frames.map((f) => f.t);
  console.log(`neverball: status ${r.status} after ${r.ms} ms, ${frames.length} frames, ${ex?.executed ?? 0} commands\n${r.out.slice(-2000)}`);
  if (t.length > 20) console.log(`steady FPS (last half): ${((t.length / 2) / ((t[t.length - 1] - t[Math.floor(t.length / 2)]) / 1000)).toFixed(1)}`);
  console.log(`GL calls: ${mock.calls.length}, draws ${mock.count('drawArrays') + mock.count('drawElements')}, textures ${mock.count('texImage2D')}; warnings:\n${[...new Set(logs)].join('\n')}`);
  expect(frames.length).toBeGreaterThan(10);
}, 900_000);
