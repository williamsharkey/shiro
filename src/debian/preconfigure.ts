/**
 * /usr/sbin/dpkg-preconfigure, as apt-utils' 70debconf hook runs it before
 * every dpkg run (`dpkg-preconfigure --apt`, the .deb list on stdin). Under
 * DEBIAN_FRONTEND=noninteractive it has nothing to ask, but under the x86
 * engine it still cost ~20 s per install (Perl and debconf start, then
 * apt-extracttemplates re-reads apt's cache). Then this drains stdin (apt
 * writes the list into the pipe and must not get SIGPIPE) and succeeds; each
 * package's templates and config script load at configure time through
 * debconf's confmodule, the path Debian takes without apt-utils. Any other
 * frontend runs Debian's script (dpkg-preconfigure.debian) with the same
 * arguments and stdio. Only the environment variable counts: a debconf
 * database set to noninteractive still runs the real script (correct, slow).
 */
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { WIFEXITED, WEXITSTATUS } from '../kernel/abi';

const DEBIAN_SUFFIX = '.debian';

/** Runner for `shiro-dpkg-preconfigure` (registered as a kernel program command). */
export async function preconfigureProgram(proc: Process, kernel: Kernel): Promise<number> {
  // Run through the stub: argv is [interpreter, /usr/sbin/dpkg-preconfigure, ...args]
  const script = proc.argv[1]?.startsWith('/') ? proc.argv[1] : '/usr/sbin/dpkg-preconfigure';
  const args = proc.argv.slice(2);
  if (proc.env.DEBIAN_FRONTEND === 'noninteractive') {
    const f = proc.fds.get(0);
    const buf = new Uint8Array(65536);
    while (f) {
      let n = f.tryRead?.(buf);
      if (n === undefined) n = await f.read(buf, proc.syscallSignal);
      if (n <= 0) break;
    }
    return 0;
  }
  const child = kernel.spawn({ path: script + DEBIAN_SUFFIX, argv: [script, ...args], env: proc.env, cwd: proc.cwd, parent: proc, inheritSignals: true });
  const r = await kernel.waitpid(child.pid, 0, proc);
  if (r.pid < 0) return 127;
  return WIFEXITED(r.status) ? WEXITSTATUS(r.status) : 128 + (r.status & 0x7f);
}
