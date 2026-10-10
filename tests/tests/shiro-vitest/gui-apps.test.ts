/**
 * Debian GUI app installer (src/gui/apps.ts): content-addressed .deb fetch
 * (sha256 checked), ar + data.tar.xz unpacking into the filesystem, the
 * status file, and launching the installed ELF on Xshiro :0. The .debs are
 * built here with dpkg-deb (skipped without it); the app is the raw-protocol
 * client from fixtures/x86/xclient.c.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell } from './helpers';

const work = mkdtempSync(join(tmpdir(), 'shiro-gui-apps-'));
const FIX = resolve(__dirname, 'fixtures/x86');

function build(): Record<string, Uint8Array> | null {
  try {
    execFileSync('gcc', ['-static', '-O1', '-o', join(work, 'xclient'), join(FIX, 'xclient.c')], { stdio: 'pipe' });
    const mk = (name: string, files: (root: string) => void) => {
      const root = join(work, name);
      mkdirSync(join(root, 'DEBIAN'), { recursive: true });
      writeFileSync(join(root, 'DEBIAN/control'), `Package: ${name}\nVersion: 1.0\nArchitecture: amd64\nMaintainer: t <t@t>\nDescription: test\n`);
      files(root);
      execFileSync('dpkg-deb', ['-Zxz', '--root-owner-group', '--build', root, join(work, `${name}.deb`)], { stdio: 'pipe' });
      return new Uint8Array(readFileSync(join(work, `${name}.deb`)));
    };
    // stands in for glib-compile-schemas: records that it ran, and its argument
    writeFileSync(join(work, 'marker.c'), '#include <fcntl.h>\n#include <string.h>\n#include <unistd.h>\nint main(int c, char **v) { int fd = open("/tmp/trigger-ran", O_WRONLY | O_CREAT | O_TRUNC, 0644); write(fd, v[1], strlen(v[1])); return 0; }\n');
    execFileSync('gcc', ['-static', '-O1', '-o', join(work, 'marker'), join(work, 'marker.c')], { stdio: 'pipe' });
    return {
      'schemademo': mk('schemademo', (r) => {
        mkdirSync(join(r, 'usr/share/glib-2.0/schemas'), { recursive: true });
        writeFileSync(join(r, 'usr/share/glib-2.0/schemas/org.demo.gschema.xml'), '<schemalist/>');
        mkdirSync(join(r, 'usr/bin'), { recursive: true });
        writeFileSync(join(r, 'usr/bin/glib-compile-schemas'), readFileSync(join(work, 'marker')));
        chmodSync(join(r, 'usr/bin/glib-compile-schemas'), 0o755);
      }),
      // gdk-pixbuf: its own loaders come with a prebuilt loaders.cache (an overlay); another package's loader runs the trigger
      'libgdk-pixbuf-2.0-0': mk('libgdk-pixbuf-2.0-0', (r) => {
        mkdirSync(join(r, 'usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders'), { recursive: true });
        writeFileSync(join(r, 'usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-png.so'), 'loader');
        writeFileSync(join(r, 'usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders'), readFileSync(join(work, 'marker')));
        chmodSync(join(r, 'usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders'), 0o755);
      }),
      'loaderdemo': mk('loaderdemo', (r) => {
        mkdirSync(join(r, 'usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders'), { recursive: true });
        writeFileSync(join(r, 'usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-demo.so'), 'loader');
      }),
      'libdemo1': mk('libdemo1', (r) => {
        mkdirSync(join(r, 'usr/lib/x86_64-linux-gnu'), { recursive: true });
        writeFileSync(join(r, 'usr/lib/x86_64-linux-gnu/libdemo.so.1.0'), 'not really a library');
        symlinkSync('libdemo.so.1.0', join(r, 'usr/lib/x86_64-linux-gnu/libdemo.so.1'));
        mkdirSync(join(r, 'usr/share/doc/libdemo1'), { recursive: true });
        writeFileSync(join(r, 'usr/share/doc/libdemo1/README'), 'skipped');
      }),
      'xdemo': mk('xdemo', (r) => {
        mkdirSync(join(r, 'usr/bin'), { recursive: true });
        writeFileSync(join(r, 'usr/bin/xdemo'), readFileSync(join(work, 'xclient')));
        chmodSync(join(r, 'usr/bin/xdemo'), 0o755);
      }),
    };
  } catch {
    return null;
  }
}

const debs = build();

describe.skipIf(!debs)('GUI apps from .deb packages', () => {
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  let manifest: any;
  beforeAll(async () => {
    manifest = {
      suite: 'test', arch: 'amd64', mirror: '', snapshot: '',
      packages: Object.fromEntries(Object.entries(debs!).map(([n, b]) => [n, { version: '1.0', filename: `pool/main/x/${n}/${n}_1.0_amd64.deb`, sha256: sha(b), size: b.length }])),
      apps: {
        xdemo: { description: 'demo', toolkit: 'x11', bin: '/usr/bin/xdemo', packages: ['libdemo1', 'xdemo'], size: 0, closureSize: 0, dropped: [] },
        schemas: { description: 'demo', toolkit: 'gtk3', bin: '/usr/bin/glib-compile-schemas', packages: ['schemademo'], size: 0, closureSize: 0, dropped: [] },
        pixbuf: { description: 'demo', toolkit: 'gtk3', bin: '/usr/bin/true', packages: ['libgdk-pixbuf-2.0-0'], size: 0, closureSize: 0, dropped: [] },
        loader: { description: 'demo', toolkit: 'gtk3', bin: '/usr/bin/true', packages: ['libgdk-pixbuf-2.0-0', 'loaderdemo'], size: 0, closureSize: 0, dropped: [] },
      },
    };
    const { configureGuiApps } = await import('@shiro/gui/apps');
    configureGuiApps({ manifest, fetchDeb: async (p) => debs![p.filename.split('/')[3]] });
    const { configureXSession } = await import('@shiro/x11/session');
    configureXSession({ headless: true, width: 1024, height: 768 });
  });

  it('reads ar members and the xz data.tar of a .deb', async () => {
    const { arMembers, debEntries } = await import('@shiro/gui/apps');
    expect([...arMembers(debs!.libdemo1).keys()]).toEqual(['debian-binary', 'control.tar.xz', 'data.tar.xz']);
    const paths = (await debEntries(debs!.libdemo1)).map((e) => e.path);
    expect(paths).toContain('usr/lib/x86_64-linux-gnu/libdemo.so.1');
  });

  it('installs an app, then launches it on the display', async () => {
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { registerBlinkLoader } = await import('@shiro/x86-engine/blink');
    const { startDisplay } = await import('@shiro/x11/display');
    const { getXSession, resetXSession } = await import('@shiro/x11/session');
    const { installApp, isAppInstalled, launchApp } = await import('@shiro/gui/apps');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    registerBlinkLoader(kernel);
    const phases: string[] = [];
    const r = await installApp(fs, kernel, 'xdemo', (p) => phases.push(p.phase));
    expect(r.fetched).toBe(2);
    expect(phases).toContain('done');
    expect(await fs.readFile('/usr/lib/x86_64-linux-gnu/libdemo.so.1', 'utf8')).toBe('not really a library');
    expect((await fs.lstat('/usr/lib/x86_64-linux-gnu/libdemo.so.1')).isSymbolicLink()).toBe(true);
    expect(await fs.exists('/usr/share/doc/libdemo1/README')).toBe(false);
    expect(await isAppInstalled(fs, 'xdemo')).toBe(true);
    const again = await installApp(fs, kernel, 'xdemo');
    expect(again.skipped).toBe(2);

    resetXSession(0);
    const display = await startDisplay(kernel, 0);
    const sess = await getXSession(0);
    const mapped: any[] = [];
    sess.server.hooks = { topMapped: (w) => mapped.push(w) };
    const app = await launchApp(kernel, 'xdemo');
    const t0 = Date.now();
    while (!app.output().includes('drawn') && Date.now() - t0 < 30_000) await new Promise((res) => setTimeout(res, 20));
    expect(mapped.length).toBe(1);
    sess.server.movePointer(mapped[0].x + 5, mapped[0].y + 5, mapped[0]);
    sess.server.button(true, 1); sess.server.button(false, 1);
    expect(await app.exited).toBe(0);
    display.stop();
  }, 120_000);

  it('runs a trigger only when a package puts files in its directory', async () => {
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { registerBlinkLoader } = await import('@shiro/x86-engine/blink');
    const { installApp } = await import('@shiro/gui/apps');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    registerBlinkLoader(kernel);
    await installApp(fs, kernel, 'schemas');
    expect(await fs.readFile('/tmp/trigger-ran', 'utf8')).toBe('/usr/share/glib-2.0/schemas');
    await fs.unlink('/tmp/trigger-ran');
    await fs.rm('/var/lib/shiro-gui/status.json').catch(() => {}); // test shells share one filesystem
    const r = await installApp(fs, kernel, 'xdemo');
    expect(r.skipped).toBe(0);
    expect(await fs.exists('/tmp/trigger-ran')).toBe(false);
    // gdk-pixbuf's own loaders: covered by the overlay
    await installApp(fs, kernel, 'pixbuf');
    expect(await fs.exists('/tmp/trigger-ran')).toBe(false);
    await installApp(fs, kernel, 'loader');
    expect(await fs.readFile('/tmp/trigger-ran', 'utf8')).toBe('--update-cache');
  }, 120_000);

  it('shares one install between callers and reports what is left to download', async () => {
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { installApp, pendingDownload, installInProgress } = await import('@shiro/gui/apps');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const size = debs!.libdemo1.length + debs!.xdemo.length;
    await fs.rm('/var/lib/shiro-gui/status.json').catch(() => {}); // test shells share one filesystem
    expect(await pendingDownload(fs, 'xdemo')).toEqual({ packages: 2, bytes: size });
    const a: string[] = [], b: string[] = [];
    const p1 = installApp(fs, kernel, 'xdemo', (p) => a.push(p.phase));
    const p2 = installApp(fs, kernel, 'xdemo', (p) => b.push(p.phase));
    expect(installInProgress('xdemo')).toBeDefined();
    expect(await p1).toBe(await p2);
    expect(a).toContain('done');
    expect(b).toContain('done');
    expect(installInProgress('xdemo')).toBeUndefined();
    expect(await pendingDownload(fs, 'xdemo')).toEqual({ packages: 0, bytes: 0 });
  });

  it('applies overlays: files, and tar archives of symlinks', async () => {
    const { configureGuiApps, installApp } = await import('@shiro/gui/apps');
    const root = join(work, 'ov');
    mkdirSync(join(root, 'etc/ssl/certs'), { recursive: true });
    symlinkSync('demo.pem', join(root, 'etc/ssl/certs/abcd1234.0'));
    execFileSync('tar', ['-C', root, '--owner=0', '--group=0', '-cf', join(work, 'ov.tar'), 'etc/ssl/certs/abcd1234.0']);
    const tar = new Uint8Array(readFileSync(join(work, 'ov.tar')));
    const file = new TextEncoder().encode('bundle\n');
    const blobs: Record<string, Uint8Array> = { [sha(tar)]: tar, [sha(file)]: file };
    const m = JSON.parse(JSON.stringify(manifest));
    m.overlays = [
      { path: '/etc/ssl/certs/ca-certificates.crt', sha256: sha(file), size: file.length, when: 'libdemo1' },
      { path: '/', tar: true, sha256: sha(tar), size: tar.length, when: 'libdemo1' },
    ];
    configureGuiApps({ manifest: m, fetchDeb: async (p) => blobs[p.sha256] ?? debs![p.filename.split('/')[3]] });
    try {
      const { fs } = await createTestShell();
      const { Kernel } = await import('@shiro/kernel/kernel');
      const kernel = new Kernel({ fs, registerWithProcessTable: false });
      await fs.rm('/var/lib/shiro-gui/status.json').catch(() => {}); // test shells share one filesystem
      await installApp(fs, kernel, 'xdemo');
      expect(await fs.readFile('/etc/ssl/certs/ca-certificates.crt', 'utf8')).toBe('bundle\n');
      expect(await fs.readlink('/etc/ssl/certs/abcd1234.0')).toBe('demo.pem');
    } finally {
      configureGuiApps({ manifest, fetchDeb: async (p) => debs![p.filename.split('/')[3]] });
    }
  });

  it('rejects a package whose sha256 does not match', async () => {
    const { configureGuiApps, installApp } = await import('@shiro/gui/apps');
    const bad = JSON.parse(JSON.stringify(manifest));
    bad.packages.xdemo.sha256 = '0'.repeat(64);
    bad.packages.xdemo.version = '2.0'; // not the installed version: fetch again
    configureGuiApps({ manifest: bad });
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    await expect(installApp(fs, kernel, 'xdemo')).rejects.toThrow(/sha256 mismatch/);
    configureGuiApps({ manifest });
  });
});

describe('GUI apps: the GL environment (docs/research/GL.md)', () => {
  it('gives apps that link libglvnd libGLX_tabcomputer and its vendor name, only while GLX is on', async () => {
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { glEnv } = await import('@shiro/gui/apps');
    const glx = await import('@shiro/x11/glx');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const app = (packages: string[]) => ({ description: '', toolkit: 'qt5', bin: '/usr/bin/x', packages, size: 0, closureSize: 0, dropped: [] }) as never;
    const LIB = '/usr/lib/x86_64-linux-gnu/libGLX_tabcomputer.so.0';
    const realFetch = globalThis.fetch;
    let body = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    const asked: string[] = [];
    globalThis.fetch = (async (u: string) => { asked.push(String(u)); return new Response(body); }) as typeof fetch;
    try {
      glx.resetGLX();
      expect(await glEnv(kernel, app(['libgl1', 'libglx0', 'libglvnd0']))).toEqual({});   // GLX off: Mesa as before
      glx.enableGLX();
      expect(await glEnv(kernel, app(['libgtk-3-0']))).toEqual({});                       // no libglvnd: nothing to load it
      expect(asked).toEqual([]);
      expect(await glEnv(kernel, app(['libgl1', 'libglx0', 'libglvnd0']))).toEqual({ __GLX_VENDOR_LIBRARY_NAME: 'tabcomputer' });
      expect(asked[0]).toMatch(/gui\/lib\/libGLX_tabcomputer\.so\.0$/);
      expect([...(await fs.readFile(LIB)) as Uint8Array]).toEqual([...body]);
      // a dev server's index.html for a missing file is not a library: the installed one stays
      body = new TextEncoder().encode('<!doctype html>');
      expect(await glEnv(kernel, app(['libglx0']))).toEqual({ __GLX_VENDOR_LIBRARY_NAME: 'tabcomputer' });
      expect(((await fs.readFile(LIB)) as Uint8Array)[1]).toBe(0x45);
      await fs.unlink(LIB);
      expect(await glEnv(kernel, app(['libglx0']))).toEqual({});
    } finally {
      globalThis.fetch = realFetch;
      glx.resetGLX();
    }
  });
});
