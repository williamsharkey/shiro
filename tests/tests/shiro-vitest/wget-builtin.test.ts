/**
 * Shiro's built-in wget (when the wget package isn't installed): `-O -` is
 * standard output in every spelling, and wget's own messages go to stderr.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

describe('built-in wget', () => {
  let shell: Shell;
  let fs: FileSystem;
  const sh = async (cmd: string) => {
    let out = '', err = '';
    const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
    return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
  };
  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('the body\n', { status: 200, headers: { 'content-type': 'text/plain' } })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('-O - writes the document to stdout (-qO-, -qO -, -q -O -, -O-, --output-document=-)', async () => {
    for (const cmd of ['wget -qO- https://example.com/a.txt', 'wget -qO - https://example.com/a.txt', 'wget -q -O - https://example.com/a.txt',
      'wget -O- https://example.com/a.txt', 'wget --output-document=- https://example.com/a.txt', 'wget -q --output-document - https://example.com/a.txt']) {
      const r = await sh(cmd);
      expect(r.code, cmd).toBe(0);
      expect(r.out, cmd).toBe('the body\n');
      expect(await fs.exists('/home/user/a.txt'), cmd).toBe(false);
      expect(await fs.exists('/home/user/-'), cmd).toBe(false);
    }
    expect((await sh('wget -qO- https://example.com/a.txt | wc -l')).out.trim()).toBe('1');
  });

  it('-O FILE, -OFILE and the URL\'s name write files; messages go to stderr', async () => {
    let r = await sh('wget -qOout1.txt https://example.com/a.txt && wget -q -O out2.txt https://example.com/a.txt && cat out1.txt out2.txt');
    expect(r.out).toBe('the body\nthe body\n');
    r = await sh('wget https://example.com/dir/named.txt');
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain("Saving to: 'named.txt'");
    expect(await fs.readFile('/home/user/named.txt', 'utf8')).toBe('the body\n');
    // an option's value isn't taken for the URL
    r = await sh('wget -q --tries 3 -T 5 -O out3.txt https://example.com/a.txt && cat out3.txt');
    expect(r.out).toBe('the body\n');
  });
});
