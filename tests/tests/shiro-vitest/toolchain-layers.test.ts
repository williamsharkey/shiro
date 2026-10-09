/**
 * Toolchain layers (docs/DEBIAN.md "Toolchain layers"): a layer packed by
 * scripts/debian/pack-layer.mjs from a base tree and the same tree with a
 * package "installed", applied onto a fresh Debian rootfs with `toolchain
 * install`. Then dpkg must agree (status, file lists, diversions, apt's
 * auto marks), and apt must install one more package on top: a local .deb
 * built in the tab that depends on the layer's package.
 *
 * TABCOMPUTER_TEST_LAYERS=DIR (a build-layers.sh output) also applies the
 * real `c` layer and compiles hello.c with Debian's gcc.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run as runRaw } from './helpers';
import { compareVersions } from '@shiro/debian/layers';

// Kernel programs' output comes through a pty (\r\n)
const run = async (...a: Parameters<typeof runRaw>) => {
  const r = await runRaw(...a);
  return { ...r, output: r.output.replace(/\r\n/g, '\n') };
};

const ROOT = resolve(__dirname, '../../..');
const haveRootfs = existsSync(resolve(ROOT, 'public/debian/rootfs.json'));

describe('dpkg version comparison', () => {
  it('orders versions as dpkg does', () => {
    const lt = (a: string, b: string) => { expect(compareVersions(a, b)).toBeLessThan(0); expect(compareVersions(b, a)).toBeGreaterThan(0); };
    lt('1.0', '1.1');
    lt('1.0~rc1', '1.0');
    lt('1.0', '1.0+b1');
    lt('1.0-1', '1.0-2');
    lt('1.9', '1.10');
    lt('2.41-11', '2.41-12');
    lt('9.9', '1:0.1');
    lt('14.2.0-19', '14.2.0-19+deb13u1');
    lt('1.0a', '1.0b');
    lt('1.0', '1.0a');
    lt('21.0.8+9-1~deb13u1', '21.0.12.1+1-1~deb13u1');
    expect(compareVersions('1.0-1', '1.0-1')).toBe(0);
    expect(compareVersions('0:1.0', '1.0')).toBe(0);
    expect(compareVersions('1.01', '1.1')).toBe(0);
  });
});

/** A tree with one more package, tc-hello (and its dependency tc-lib), "installed" the way dpkg would leave it. */
function addFakePackages(root: string): void {
  const w = (p: string, text: string, mode = 0o644) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text, { mode });
  };
  w('/usr/bin/tc-hello', '#!/bin/sh\necho "hello from the layer: $(cat /usr/share/tc-lib/greeting)"\n', 0o755);
  w('/usr/share/tc-lib/greeting', 'layered\n');
  w('/var/lib/dpkg/info/tc-hello.list', '/.\n/usr\n/usr/bin\n/usr/bin/tc-hello\n');
  const md5 = (p: string) => createHash('md5').update(readFileSync(join(root, p))).digest('hex') + '  ' + p.slice(1) + '\n';
  w('/var/lib/dpkg/info/tc-hello.md5sums', md5('/usr/bin/tc-hello'));
  w('/var/lib/dpkg/info/tc-lib.md5sums', md5('/usr/share/tc-lib/greeting'));
  w('/var/lib/dpkg/info/tc-lib.list', '/.\n/usr\n/usr/share\n/usr/share/tc-lib\n/usr/share/tc-lib/greeting\n');
  // What maintainer scripts leave behind: an alternative, a package diversion, apt's auto mark
  mkdirSync(join(root, 'var/lib/dpkg/alternatives'), { recursive: true });
  w('/var/lib/dpkg/alternatives/tc-hi', 'auto\n/usr/bin/tc-hi\n\n/usr/bin/tc-hello\n50\n\n');
  symlinkSync('/usr/bin/tc-hello', join(root, 'etc/alternatives/tc-hi'));
  symlinkSync('/etc/alternatives/tc-hi', join(root, 'usr/bin/tc-hi'));
  appendFileSync(join(root, 'var/lib/dpkg/diversions'), '/usr/bin/tc-old\n/usr/bin/tc-old.distrib\ntc-hello\n');
  const ext = join(root, 'var/lib/apt/extended_states');
  appendFileSync(ext, (existsSync(ext) && readFileSync(ext, 'utf8').trim() ? '\n' : '') + 'Package: tc-lib\nArchitecture: all\nAuto-Installed: 1\n');
  const stanza = (name: string, extra = '') => `Package: ${name}\nStatus: install ok installed\nPriority: optional\nSection: misc\nInstalled-Size: 1\nMaintainer: tabcomputer tests <tests@tabcomputer.invalid>\nArchitecture: all\nVersion: 1.0-1\n${extra}Description: toolchain layer test package\n`;
  const status = join(root, 'var/lib/dpkg/status');
  writeFileSync(status, readFileSync(status, 'utf8').replace(/\n*$/, '\n\n') + stanza('tc-hello', 'Depends: tc-lib\n') + '\n' + stanza('tc-lib'));
}

describe.skipIf(!haveRootfs)('toolchain layers', () => {
  let dir: string;
  const saved = process.env.TABCOMPUTER_DEBIAN_LAYERS_URL;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-layers-'));
    const base = join(dir, 'base'), tree = join(dir, 'tree'), out = join(dir, 'layers');
    execFileSync('node', [join(ROOT, 'scripts/debian/unpack-rootfs.mjs'), join(ROOT, 'public/debian'), base]);
    cpSync(base, tree, { recursive: true, verbatimSymlinks: true });
    addFakePackages(tree);
    const baseId = JSON.parse(readFileSync(join(ROOT, 'public/debian/rootfs.json'), 'utf8')).id;
    const spec = join(dir, 'spec.json');
    writeFileSync(spec, JSON.stringify({ format: 1, layers: { hello: { title: 'Hello', description: 'test layer', packages: ['tc-hello'], check: 'tc-hello' } } }));
    execFileSync('node', [join(ROOT, 'scripts/debian/pack-layer.mjs'), base, tree, out, '--id', 'hello', '--base-id', baseId, '--snapshot', 'test', '--recipe', 'test']);
    execFileSync('node', [join(ROOT, 'scripts/debian/pack-layer.mjs'), '--catalog', out, '--spec', spec]);
    process.env.TABCOMPUTER_DEBIAN_LAYERS_URL = 'file://' + out + '/';
  }, 120000);
  afterAll(() => {
    if (saved === undefined) delete process.env.TABCOMPUTER_DEBIAN_LAYERS_URL; else process.env.TABCOMPUTER_DEBIAN_LAYERS_URL = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('packs only what the install changed, with owners and merged databases', async () => {
    const { gunzipSync } = await import('node:zlib');
    const m = JSON.parse(readFileSync(join(dir, 'layers/hello/layer.json'), 'utf8'));
    const ix = JSON.parse(gunzipSync(readFileSync(join(dir, 'layers', m.index))).toString());
    expect(ix.packages.map((p: any) => p.name)).toEqual(['tc-hello', 'tc-lib']);
    const paths = ix.entries.map((e: any[]) => e[0]);
    expect(paths).toContain('/usr/bin/tc-hello');
    expect(paths).toContain('/etc/alternatives/tc-hi');
    expect(paths).not.toContain('/var/lib/dpkg/status');
    expect(paths).not.toContain('/usr/bin/dpkg');
    const owner = (p: string) => ix.entries.find((e: any[]) => e[0] === p).at(-1);
    expect(ix.packages[owner('/usr/bin/tc-hello')].name).toBe('tc-hello');
    expect(ix.packages[owner('/var/lib/dpkg/info/tc-lib.list')].name).toBe('tc-lib');
    expect(owner('/etc/alternatives/tc-hi')).toBe(-1);
    expect(Object.keys(ix.merged).sort()).toEqual(['/var/lib/apt/extended_states', '/var/lib/dpkg/diversions']);
    const cat = JSON.parse(readFileSync(join(dir, 'layers/index.json'), 'utf8'));
    expect(cat.layers[0]).toMatchObject({ name: 'hello', title: 'Hello', requested: ['tc-hello'] });
  });

  it('applies onto a fresh rootfs; dpkg and apt agree, and apt installs a package on top', async () => {
    const { fs, shell } = await createTestShell();
    expect((await run(shell, 'debian install')).exitCode).toBe(0);
    const before = await fs.readFile('/var/lib/dpkg/diversions', 'utf8') as string;
    // `toolchain list` knows the catalog's set; only the test spec's
    // ids are installable by name, so apply through the module here
    const { applyLayer, appliedLayers } = await import('@shiro/debian/layers');
    const r = await applyLayer(fs, 'hello');
    expect(r.installed).toEqual(['tc-hello', 'tc-lib']);
    expect(Object.keys(await appliedLayers(fs))).toEqual(['hello']);

    expect((await run(shell, '/usr/bin/tc-hello')).output).toBe('hello from the layer: layered\n');
    expect((await run(shell, 'readlink /usr/bin/tc-hi')).output.trim()).toBe('/etc/alternatives/tc-hi');
    // The machine's diversions (the overlay's) are kept, the package's added
    const divs = await fs.readFile('/var/lib/dpkg/diversions', 'utf8') as string;
    expect(divs.startsWith(before)).toBe(true);
    expect(divs).toContain('/usr/bin/tc-old\n/usr/bin/tc-old.distrib\ntc-hello\n');

    // Debian's dpkg (in Blink) reads the merged database
    expect((await run(shell, "dpkg-query -W -f='${Package} ${Version} ${Status}\\n' tc-hello tc-lib")).output)
      .toBe('tc-hello 1.0-1 install ok installed\ntc-lib 1.0-1 install ok installed\n');
    expect((await run(shell, 'dpkg -S /usr/bin/tc-hello')).output.trim()).toBe('tc-hello: /usr/bin/tc-hello');
    expect((await run(shell, 'dpkg-query -W -f=\'${Package}\\n\' dpkg apt bash')).output.split('\n').filter(Boolean)).toHaveLength(3);
    const audit = await run(shell, 'dpkg --audit');
    expect(audit.output).toBe('');
    expect(audit.exitCode).toBe(0);
    expect((await run(shell, 'apt-mark showauto tc-lib')).output.trim()).toBe('tc-lib');
    const verify = await run(shell, 'dpkg --verify tc-hello tc-lib');
    expect(verify.output).toBe('');
    expect(verify.exitCode).toBe(0);

    // Applying again changes nothing
    const again = await applyLayer(fs, 'hello');
    expect(again.installed).toEqual([]);
    expect(again.kept).toEqual(['tc-hello', 'tc-lib']);

    // apt installs one more package, whose dependency the layer provides
    const pkg = '/tmp/tc-extra';
    await fs.mkdir(`${pkg}/DEBIAN`, { recursive: true });
    await fs.mkdir(`${pkg}/usr/bin`, { recursive: true });
    await fs.writeFile(`${pkg}/DEBIAN/control`, 'Package: tc-extra\nVersion: 1.0\nArchitecture: all\nMaintainer: tabcomputer tests <tests@tabcomputer.invalid>\nDepends: tc-hello (>= 1.0)\nDescription: depends on the layer\n');
    await fs.writeFile(`${pkg}/usr/bin/tc-extra`, '#!/bin/sh\nexec tc-hello\n', { mode: 0o755 });
    const build = await run(shell, `dpkg-deb --root-owner-group -Zgzip --build ${pkg} /tmp/tc-extra.deb 2>&1`);
    expect(build.exitCode).toBe(0);
    const inst = await run(shell, 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/tc-extra.deb 2>&1');
    expect(inst.output).toContain('Setting up tc-extra');
    expect(inst.output).not.toMatch(/tc-hello|tc-lib/.source + ' \\(1\\.0-1\\) \\.\\.\\.'); // not reinstalled
    expect(inst.exitCode).toBe(0);
    expect((await run(shell, 'tc-extra')).output).toBe('hello from the layer: layered\n');
    expect((await run(shell, 'dpkg --audit')).output).toBe('');
  }, 900000);
});

const realLayers = process.env.TABCOMPUTER_TEST_LAYERS;
describe.skipIf(!haveRootfs || !realLayers)('the real c layer (TABCOMPUTER_TEST_LAYERS)', () => {
  it('toolchain install c, then gcc hello.c && ./a.out', async () => {
    process.env.TABCOMPUTER_DEBIAN_LAYERS_URL = 'file://' + resolve(realLayers!) + '/';
    try {
      const { shell } = await createTestShell();
      const inst = await run(shell, 'toolchain install c');
      expect(inst.exitCode).toBe(0);
      expect((await run(shell, 'dpkg --audit')).output).toBe('');
      expect((await run(shell, "dpkg-query -W -f='${Status}' gcc-14")).output).toBe('install ok installed');
      // Debian's gcc, not tabcomputer's builtin compiler
      expect((await run(shell, 'gcc --version')).output).toMatch(/^gcc \(Debian 14\./);
      expect((await run(shell, "printf '#include <stdio.h>\\nint main(void){puts(\"hi\");}\\n' > /tmp/h.c && cd /tmp && gcc h.c && ./a.out")).output).toBe('hi\n');
    } finally { delete process.env.TABCOMPUTER_DEBIAN_LAYERS_URL; }
  }, 1800000);
});
