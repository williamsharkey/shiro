import { describe, it, expect } from 'vitest';
import { preconfigureProgram } from '@shiro/debian/preconfigure';

function stdin(text: string) {
  let pending = new TextEncoder().encode(text);
  let reads = 0;
  return {
    get reads() { return reads; },
    get left() { return pending.length; },
    tryRead(buf: Uint8Array) {
      reads++;
      const n = Math.min(buf.length, pending.length);
      buf.set(pending.subarray(0, n));
      pending = pending.subarray(n);
      return n;
    },
  };
}

describe('shiro-dpkg-preconfigure (apt-utils hook)', () => {
  it('under DEBIAN_FRONTEND=noninteractive drains apt\'s list and succeeds without running Debian\'s script', async () => {
    const input = stdin('/var/cache/apt/archives/hello_2.10-5_amd64.deb\n'.repeat(5000));
    const spawned: unknown[] = [];
    const proc: any = { argv: ['/usr/bin/shiro-dpkg-preconfigure', '/usr/sbin/dpkg-preconfigure', '--apt'], env: { DEBIAN_FRONTEND: 'noninteractive' }, cwd: '/', fds: new Map([[0, input]]) };
    const kernel: any = { spawn: (o: unknown) => { spawned.push(o); return { pid: 9 }; } };
    expect(await preconfigureProgram(proc, kernel)).toBe(0);
    expect(input.left).toBe(0); // read to EOF: apt never sees EPIPE
    expect(spawned).toHaveLength(0);
  });

  it('otherwise runs dpkg-preconfigure.debian with the same arguments and returns its status', async () => {
    const calls: any[] = [];
    const proc: any = { argv: ['/usr/bin/shiro-dpkg-preconfigure', '/usr/sbin/dpkg-preconfigure', '--apt', '-p', 'high'], env: { DEBIAN_FRONTEND: 'readline' }, cwd: '/root', fds: new Map() };
    const kernel: any = {
      spawn: (o: any) => { calls.push(o); return { pid: 42 }; },
      waitpid: async (pid: number) => ({ pid, status: 3 << 8 }), // exit 3
    };
    expect(await preconfigureProgram(proc, kernel)).toBe(3);
    expect(calls[0].path).toBe('/usr/sbin/dpkg-preconfigure.debian');
    expect(calls[0].argv).toEqual(['/usr/sbin/dpkg-preconfigure', '--apt', '-p', 'high']);
    expect(calls[0].parent).toBe(proc);
    expect(calls[0].env.DEBIAN_FRONTEND).toBe('readline');
    // killed by a signal: 128 + signo, as a shell reports it
    kernel.waitpid = async (pid: number) => ({ pid, status: 15 });
    expect(await preconfigureProgram(proc, kernel)).toBe(143);
  });
});
