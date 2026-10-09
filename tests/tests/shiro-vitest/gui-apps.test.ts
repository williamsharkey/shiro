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
    return {
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
      apps: { xdemo: { description: 'demo', toolkit: 'x11', bin: '/usr/bin/xdemo', packages: ['libdemo1', 'xdemo'], size: 0, closureSize: 0, dropped: [] } },
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
