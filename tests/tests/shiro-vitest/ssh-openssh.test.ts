/**
 * The builtin ssh is Shiro's tab-to-tab ssh (connection codes from
 * `remote start`); OpenSSH usage goes to OpenSSH when it is installed, and
 * gets an install hint when it isn't.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestShell } from './helpers';

async function run(cmd: string, setup?: (fs: any) => Promise<void>) {
  const { fs, shell } = await createTestShell();
  if (setup) await setup(fs);
  let out = '';
  let err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

describe('ssh: OpenSSH usage vs Shiro peers', () => {
  it('without OpenSSH, OpenSSH-style arguments print a hint instead of trying signaling', async () => {
    for (const cmd of ['ssh -T git@github.com', 'ssh git@github.com', 'ssh example.com', 'ssh host ls -l']) {
      const r = await run(cmd);
      expect(r.code, cmd).toBe(255);
      expect(r.err, cmd).toContain("tabcomputer's tab-to-tab ssh");
      expect(r.err, cmd).toContain('pkg install openssh');
      expect(r.out + r.err, cmd).not.toContain('Connecting to');
    }
  });

  it('with OpenSSH installed (an ELF at /usr/bin/ssh), OpenSSH usage runs it', async () => {
    const elf = new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', 'hello-musl')));
    const r = await run('ssh -T git@github.com', async (fs) => {
      await fs.mkdir('/usr/bin', { recursive: true });
      await fs.writeFile('/usr/bin/ssh', elf, { mode: 0o755 });
    });
    expect(r.out).toBe('Hello, world!\n');
    expect(r.code).toBe(0);
  });

  it('a connection code still goes to the tab-to-tab ssh, OpenSSH or not', async () => {
    const r = await run('ssh fluffy-cloud-shimutako');
    expect(r.err).not.toContain('pkg install openssh');
    expect(r.err).toContain('requires a terminal'); // (no terminal in the test: the WebRTC path)
  });
});
