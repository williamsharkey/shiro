import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

describe('fd duplication redirects', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    await fs.mkdir('/tmp/fdtest', { recursive: true });
  });

  async function exec(cmd: string) {
    let out = '', err = '';
    await shell.execute(`cd /tmp/fdtest && ${cmd}`, s => { out += s; }, s => { err += s; });
    return { out, err, files: await fs.readdir('/tmp/fdtest') };
  }

  it('>&2 writes to stderr, not a file named &2', async () => {
    const r = await exec('echo oops >&2');
    expect(r.err).toContain('oops');
    expect(r.out).toBe('');
    expect(r.files).not.toContain('&2');
  });

  it('1>&2 treats 1 as the stdout fd', async () => {
    const r = await exec('echo oops 1>&2');
    expect(r.err).toBe('oops\r\n');
    expect(r.files).not.toContain('&2');
  });

  it('1>file writes the file without a stray argument', async () => {
    await exec('echo hi 1>out.txt');
    expect(await fs.readFile('/tmp/fdtest/out.txt', 'utf8')).toBe('hi\n');
  });
});
