/**
 * /usr/bin/apt and /usr/bin/apt-get in Debian mode (the overlay diverts
 * Debian's to apt.debian and apt-get.debian): Debian's apt with recovery in
 * front of the commands that change packages, so a browser tab doesn't need
 * a Debian admin's know-how after something went wrong.
 *
 * - dpkg was interrupted (its journal, /var/lib/dpkg/updates, isn't empty):
 *   `dpkg --configure -a` first, as apt's own message says to.
 * - packages left half-installed, unpacked or half-configured: `apt-get -f
 *   install -y` first, as apt's "Try 'apt --fix-broken install'" says to.
 * - the command fails and leaves either behind (an unpack that failed
 *   mid-way, e.g. a transient engine fault): recover, then run it once more.
 *   The archives of the failed run are still in /var/cache/apt/archives, so
 *   the retry doesn't download them again.
 *
 * Everything else (update, search, show, policy, non-root runs) goes straight
 * to Debian's apt. Messages are prefixed with the product name so they read
 * as the system's, not apt's.
 */
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { WIFEXITED, WEXITSTATUS } from '../kernel/abi';

const DEBIAN_SUFFIX = '.debian';
const CHANGES = new Set(['install', 'reinstall', 'remove', 'purge', 'upgrade', 'full-upgrade', 'dist-upgrade', 'autoremove', 'autopurge', 'build-dep', 'satisfy']);
/** dpkg statuses that mean an operation stopped part-way (dpkg --audit lists these). */
const BROKEN = /^(half-installed|unpacked|half-configured)$/;

/** The apt subcommand: the first argument that isn't an option (or an option's value). */
export function aptSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '-c' || a === '-t' || a === '--option' || a === '--config-file' || a === '--target-release') { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/** Packages dpkg left part-way, from /var/lib/dpkg/status. */
export function brokenPackages(status: string): string[] {
  const out: string[] = [];
  for (const stanza of status.split(/\n\n+/)) {
    const name = /^Package: (.+)$/m.exec(stanza)?.[1];
    const st = /^Status: \S+ \S+ (\S+)$/m.exec(stanza)?.[1];
    if (name && st && BROKEN.test(st)) out.push(name);
  }
  return out;
}

async function run(kernel: Kernel, proc: Process, path: string, argv: string[]): Promise<number> {
  const child = kernel.spawn({ path, argv, env: proc.env, cwd: proc.cwd, parent: proc, inheritSignals: true });
  const r = await kernel.waitpid(child.pid, 0, proc);
  if (r.pid < 0) return 127;
  return WIFEXITED(r.status) ? WEXITSTATUS(r.status) : 128 + (r.status & 0x7f);
}

/** Runner for `shiro-apt` (a kernel program command; the stub's argv is [interp, /usr/bin/apt-get, ...args]). */
export async function aptGuardProgram(proc: Process, kernel: Kernel, product = 'tabcomputer'): Promise<number> {
  const script = proc.argv[1]?.startsWith('/') ? proc.argv[1] : '/usr/bin/apt-get';
  const args = proc.argv.slice(2);
  const real = () => run(kernel, proc, script + DEBIAN_SUFFIX, [script, ...args]);
  const sub = aptSubcommand(args);
  const fs = kernel.fs;
  const dry = args.some((a) => /^(-s|--simulate|--just-print|--dry-run|--recon|--no-act|--print-uris|-d|--download-only)$/.test(a));
  if (!fs || proc.uid !== 0 || !sub || !CHANGES.has(sub) || dry) return real();

  const say = async (s: string) => { await proc.fds.get(2)?.write(new TextEncoder().encode(`${product}: ${s}\n`)); };
  const interrupted = async () => ((await fs.readdir('/var/lib/dpkg/updates').catch(() => [] as string[])).length > 0);
  const broken = async () => brokenPackages(String(await fs.readFile('/var/lib/dpkg/status', 'utf8').catch(() => '')));
  const recover = async (): Promise<boolean> => {
    let acted = false;
    if (await interrupted()) {
      await say("dpkg was interrupted; running 'dpkg --configure -a' first");
      await run(kernel, proc, '/usr/bin/dpkg', ['dpkg', '--configure', '-a']);
      acted = true;
    }
    const left = await broken();
    if (left.length) {
      await say(`finishing what an earlier install left part-way (${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}): apt-get -f install`);
      await run(kernel, proc, '/usr/bin/apt-get' + DEBIAN_SUFFIX, ['apt-get', '-f', 'install', '-y']);
      acted = true;
    }
    return acted;
  };

  await recover();
  const code = await real();
  if (code === 0 || !['install', 'reinstall', 'upgrade', 'full-upgrade', 'dist-upgrade'].includes(sub)) return code;
  // A failed run that left dpkg part-way: recover and try once more
  if (!(await interrupted()) && !(await broken()).length) return code;
  await say('the install stopped part-way; recovering and trying once more');
  await recover();
  return real();
}
