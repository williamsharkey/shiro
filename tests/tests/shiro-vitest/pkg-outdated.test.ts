/**
 * Stale prebuilt packages (williamsharkey/tabcomputer#15): `pkg outdated`,
 * `pkg upgrade --dry-run`, "installed X, index Y" in `pkg list`/`available`,
 * doctor's packages line, and the boot upgrade of builds the index marks
 * broken (`broken` in an index entry).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import { parseIndex, readStatus, outdatedPackages, upgradeBrokenPackages, PKG_LISTS_DIR } from '@shiro/pkg-manager';
import { packagesCheck } from '@shiro/commands/doctor';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const served = new Map<string, Uint8Array>();

/** An index list with one package, tcfake, at `version` (its file's bytes name the version). */
function list(version: string, broken?: string[]) {
  const bytes = new TextEncoder().encode(`tcfake ${version}\n`);
  const url = `https://pkg.test.invalid/tcfake-${version}.bin`;
  served.set(url, bytes);
  return {
    format: 1,
    packages: [{
      name: 'tcfake', version, description: 'test package', license: 'MIT', source: 'test', section: 'test',
      origin: 'shiro', abi: 'wasi_snapshot_preview1',
      files: [{ path: 'bin/tcfake.wasm', url, sha256: sha256(bytes), size: bytes.length }],
      bin: { tcfake: { file: 'bin/tcfake.wasm' } },
      ...(broken ? { broken } : {}),
    }],
  };
}

async function sh(shell: Shell, cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('stale prebuilt packages', () => {
  let fs: FileSystem;
  let shell: Shell;
  const setIndex = (doc: unknown) => fs.writeFile(`${PKG_LISTS_DIR}/50-test.json`, JSON.stringify(doc));

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const b = served.get(String(u));
      return b ? new Response(b) : new Response('no route', { status: 404 });
    }));
    ({ fs, shell } = await createTestShell());
    await fs.mkdir(PKG_LISTS_DIR, { recursive: true });
    await setIndex(list('1.0'));
    const r = await sh(shell, 'pkg install tcfake');
    expect(r.code).toBe(0);
    expect((await readStatus(fs)).tcfake.version).toBe('1.0');
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('pkg outdated and apt list --upgradable list installed packages the index has another version of', async () => {
    expect((await sh(shell, 'pkg outdated')).out).toBe('All packages are up to date.\n');
    await setIndex(list('1.0-1'));
    const r = await sh(shell, 'pkg outdated');
    expect(r.out).toMatch(/^ {2}tcfake +installed 1\.0, index 1\.0-1\n1 upgradable: pkg upgrade\n$/);
    expect((await sh(shell, 'apt list --upgradable')).out).toContain('tcfake        installed 1.0, index 1.0-1');
    expect(await outdatedPackages(fs)).toEqual([{ name: 'tcfake', installed: '1.0', available: '1.0-1', broken: false }]);
  });

  it('pkg list and pkg available show "installed X, index Y" when they differ', async () => {
    expect((await sh(shell, 'pkg list')).out).not.toContain('index');
    await setIndex(list('1.0-1'));
    expect((await sh(shell, 'pkg list')).out).toMatch(/tcfake .*\[installed 1\.0, index 1\.0-1\]\n\n1 upgradable: pkg upgrade\n/);
    expect((await sh(shell, 'pkg available')).out).toMatch(/tcfake .*\[ok, installed 1\.0, index 1\.0-1\]/);
  });

  it('pkg upgrade --dry-run says what would change and changes nothing; pkg upgrade does it', async () => {
    await setIndex(list('1.0-1'));
    const dry = await sh(shell, 'pkg upgrade --dry-run');
    expect(dry.out).toBe('Inst tcfake [1.0] (1.0-1)\n1 upgraded (dry run: nothing was changed)\n');
    expect((await readStatus(fs)).tcfake.version).toBe('1.0');
    expect((await sh(shell, 'apt-get -s upgrade')).out).toContain('Inst tcfake [1.0] (1.0-1)');
    expect((await sh(shell, 'pkg upgrade')).code).toBe(0);
    expect((await readStatus(fs)).tcfake.version).toBe('1.0-1');
    expect(await fs.readFile('/usr/lib/pkg/tcfake/bin/tcfake.wasm', 'utf8')).toBe('tcfake 1.0-1\n');
    expect((await sh(shell, 'pkg outdated')).out).toBe('All packages are up to date.\n');
  });

  it("doctor's packages line: OK when current, WARN with the upgradable list otherwise", async () => {
    const ctx = { fs } as any;
    expect(await packagesCheck(ctx)).toEqual({ label: 'packages', status: 'OK', detail: '1 installed, all at the index versions' });
    await setIndex(list('1.0-1', ['1.0']));
    expect(await packagesCheck(ctx)).toEqual({
      label: 'packages', status: 'WARN',
      detail: '1 upgradable (pkg upgrade): tcfake 1.0 → 1.0-1 · 1 known broken, upgraded at boot',
    });
  });

  it('boot upgrades a package only when the index marks its installed build broken', async () => {
    await setIndex(list('1.0-1'));
    expect(await upgradeBrokenPackages(fs)).toEqual([]);
    expect((await readStatus(fs)).tcfake.version).toBe('1.0');

    await setIndex(list('1.0-1', ['0.9', '1.0']));
    expect((await sh(shell, 'pkg outdated')).out).toContain('(installed build is known broken; upgraded at boot)');
    const log: string[] = [];
    expect(await upgradeBrokenPackages(fs, { log: (l) => log.push(l) })).toEqual(['tcfake']);
    expect(log[0]).toBe('upgrading known-broken packages: tcfake');
    expect((await readStatus(fs)).tcfake.version).toBe('1.0-1');
    expect(await fs.readFile('/usr/lib/pkg/tcfake/bin/tcfake.wasm', 'utf8')).toBe('tcfake 1.0-1\n');
    expect(await upgradeBrokenPackages(fs)).toEqual([]);
  });

  it('a failed download leaves the broken package installed as it was', async () => {
    const doc = list('1.0-1', ['1.0']);
    served.delete(doc.packages[0].files[0].url);
    await setIndex(doc);
    await expect(upgradeBrokenPackages(fs)).rejects.toThrow(/download failed/);
    expect((await readStatus(fs)).tcfake.version).toBe('1.0');
  });

  it('the index format checks broken', () => {
    expect(() => parseIndex(list('2.0', ['1.0']))).not.toThrow();
    expect(() => parseIndex(list('2.0', ['2.0']))).toThrow(/its own version 2\.0 is listed as broken/);
    expect(() => parseIndex(list('2.0', [''] as any))).toThrow(/bad broken/);
    expect(() => parseIndex({ ...list('2.0'), packages: [{ ...list('2.0').packages[0], broken: '1.0' }] })).toThrow(/bad broken/);
  });
});
