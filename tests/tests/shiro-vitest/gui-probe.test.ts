import { it } from 'vitest';
import { readdirSync, lstatSync, readlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { createTestShell } from './helpers';

/**
 * Manual probe (skipped unless GUI_PROBE_ROOT is set): load a Debian rootfs
 * (scripts/gui/debfetch.py) into the test FS, start Xshiro :0 headless, run
 * an X client in Blink, and report map/first-draw times, X request counts,
 * the syscalls in flight every 5 s, and a PNG of each toplevel.
 *
 *   GUI_PROBE_ROOT=/tmp/rootfs-gtk GUI_PROBE_ARGV=/usr/bin/l3afpad GUI_PROBE_TIMEOUT=30000 \
 *   GUI_PROBE_ENV=NO_AT_BRIDGE=1 GUI_PROBE_PRE='cmd args;cmd2' GUI_PROBE_OUT=/tmp \
 *     npx vitest run --config vitest.config.ts tests/shiro-vitest/gui-probe.test.ts
 */
const ROOT = process.env.GUI_PROBE_ROOT!;
async function load(fs: any, host: string, guest: string) {
  for (const n of readdirSync(host)) {
    const h = join(host, n), g = guest + '/' + n;
    if (/^\/usr\/share\/(man|doc|locale|info|groff)|\/dri$|libLLVM|libz3|libgallium/.test(g)) continue;
    const st = lstatSync(h);
    if (st.isSymbolicLink()) { try { await fs.symlink(readlinkSync(h), g); } catch {} }
    else if (st.isDirectory()) { await fs.mkdir(g, { recursive: true }); await load(fs, h, g); }
    else await fs.writeFile(g, readFileSync(h), { mode: st.mode & 0o777 });
  }
}
function png(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(width, 0); ih.writeUInt32BE(height, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
it.skipIf(!ROOT)('probe', async () => {
  const { fs } = await createTestShell();
  let t = Date.now();
  await load(fs, ROOT, '');
  console.log('load ms', Date.now() - t);
  const { Kernel } = await import('@shiro/kernel/kernel');
  const { BufferFile } = await import('@shiro/kernel/fd');
  const { registerBlinkLoader } = await import('@shiro/x86-engine/blink');
  const { startDisplay } = await import('@shiro/x11/display');
  const { getXSession } = await import('@shiro/x11/session');
  const { composeTop } = await import('@shiro/x11/compose');
  const kernel = new Kernel({ fs, registerWithProcessTable: false });
  registerBlinkLoader(kernel);
  (await import('@shiro/kernel/pty')).attachKernelTty(kernel);
  await startDisplay(kernel, 0);
  const lastCall = new Map<number, string>();
  const origSys = kernel.syscall.bind(kernel);
  const inflight = new Map<number, string>(); let callId = 0;
  (globalThis as any).__inflight = inflight;
  (kernel as any).syscall = (proc: any, nr: number, args: any, data: any) => {
    const id = ++callId; const d = proc.pid + ':' + nr + '(' + Array.from(args as ArrayLike<number>).slice(0, 6).join(',') + ')@' + (Date.now() - t);
    inflight.set(id, d); lastCall.set(proc.pid, d);
    const r = origSys(proc, nr, args, data); r.then(() => inflight.delete(id), () => inflight.delete(id)); return r; };
  (globalThis as any).__lastCall = lastCall;
  const tops: any[] = [];
  await fs.mkdir('/var/cache/fontconfig', { recursive: true }); await fs.mkdir('/root/.cache', { recursive: true }); await fs.mkdir('/tmp', { recursive: true });
  for (const pre of (process.env.GUI_PROBE_PRE || '').split(';').filter(Boolean)) {
    const pa = pre.trim().split(' ');
    const po = new BufferFile(null);
    const t0 = Date.now();
    const pp = kernel.spawn({ path: pa[0], argv: pa, cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/root' }, fds: { 0: new BufferFile(''), 1: po, 2: po } });
    const st = await pp.wait();
    console.log('pre', pre, 'status', st, 'ms', Date.now() - t0, po.text().slice(0, 500));
  }
  const out = new BufferFile(null);
  t = Date.now();
  const argv = (process.env.GUI_PROBE_ARGV || '/usr/bin/xeyes').split(' ');
  const p = kernel.spawn({ path: argv[0], argv, cwd: '/', env: { DISPLAY: ':0', PATH: '/usr/bin:/bin', HOME: '/root', ...(process.env.GUI_PROBE_ENV ? Object.fromEntries(process.env.GUI_PROBE_ENV.split(',').map((kv) => kv.split('='))) : {}) }, fds: { 0: new BufferFile(''), 1: out, 2: out } });
  const sessP = (async () => { for (;;) { const s = await Promise.race([getXSession(0), new Promise((r) => setTimeout(() => r(null), 100))]) as any; if (s) return s; } })();
  const sess = await sessP;
  let mappedAt = 0;
  sess.server.debugErrors = true; sess.server.log = (m: string) => console.log('X:', m);
  const counts = new Map<string, number>();
  const exts = new Map([...sess.server.extensions.values()].map((e: any) => [e.major, e.name]));
  sess.server.trace = (c: any, op: number, data: number, len: number) => {
    const k = op === -1 ? `ERROR ${data} on ${len >> 8}.${len & 255}` : op >= 128 ? `${exts.get(op)}.${data}` : String(op);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if ([62, 70, 72, 139].includes(op) || (exts.get(op) === 'RENDER' && data === 8)) { const now = Date.now() - t; (globalThis as any).__firstDraw ??= now; (globalThis as any).__lastDraw = now; }
  };
  setTimeout(() => console.log('requests', JSON.stringify([...counts].sort((a, b) => b[1] - a[1]))), +(process.env.GUI_PROBE_TIMEOUT || 20000) - 500);
  sess.server.hooks = { topMapped: (w: any) => { tops.push(w); if (!mappedAt) mappedAt = Date.now(); console.log('mapped', w.id.toString(16), w.width, w.height, 'at ms', Date.now() - t); } };
  const to = +(process.env.GUI_PROBE_TIMEOUT || 20000);
  const done = p.wait();
  const sampler = setInterval(() => console.log('t', Date.now() - t, 'inSyscall', (p as any).inSyscall, 'syscalls', (p as any).syscalls, 'inflight', JSON.stringify([...((globalThis as any).__inflight as Map<number,string>).values()]), 'last', JSON.stringify([...((globalThis as any).__lastCall as Map<number,string>)]), 'procs', [...(kernel as any).procs?.values?.() ?? []].map((q: any) => q.pid + ':' + q.comm + ':' + q.inSyscall).join(' ')), 5000);
  await Promise.race([done, new Promise((r) => setTimeout(r, to))]);
  for (const w of tops) {
    const buf = { data: new Uint8ClampedArray(w.width * w.height * 4), width: w.width, height: w.height };
    composeTop(w, buf, { x: 0, y: 0, w: w.width, h: w.height });
    writeFileSync(`${process.env.GUI_PROBE_OUT || '/tmp'}/probe-${w.id.toString(16)}.png`, png(w.width, w.height, buf.data));
  }
  clearInterval(sampler);
  console.log('firstDraw ms', (globalThis as any).__firstDraw, 'lastDraw ms', (globalThis as any).__lastDraw);
  kernel.kill(p.pid, 9);
  console.log('exit', p.exitStatus, 'ms', Date.now() - t, '\n' + out.text().slice(0, 3000));
}, 600_000);
