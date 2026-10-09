/**
 * PATH shims: how Shiro advertises its builtin commands as programs.
 *
 * Every listed builtin gets `/usr/local/bin/NAME` (`#!/bin/sh\nNAME "$@"`),
 * so `which`, `execFile`, and Unix programs that search PATH themselves
 * before exec (GNU make, find -exec, xargs, git, env) find it, and the
 * kernel runs it in a forked shell. A program a package installed in
 * /usr/bin keeps PATH (pkg removes the shim of a command it provides).
 * /bin/sh, /bin/bash and /usr/bin/env exist so stat() checks pass.
 */
import type { FileSystem } from './filesystem';

export const SHIM_COMMANDS = [
  'git', 'node', 'npm', 'npx', 'ls', 'cat', 'grep', 'sed', 'find', 'curl',
  'mkdir', 'rm', 'cp', 'mv', 'echo', 'touch', 'chmod', 'head', 'tail',
  'sort', 'uniq', 'wc', 'tr', 'tee', 'diff', 'env', 'which', 'test',
  'sh', 'bash', 'vi', 'nano', 'rg', 'esbuild',
  'mktemp', 'jq', 'tput', 'stty', 'gzip', 'gunzip', 'wget',
  'pgrep', 'pkill', 'nproc', 'getconf', 'ed', 'iconv', 'zip', 'unzip',
  'cc', 'gcc', 'python', 'python3', 'pip', 'pip3', 'sqlite3',
  // what makefiles, configure scripts and git hooks run
  'printf', 'true', 'false', 'pwd', 'sleep', 'date', 'basename', 'dirname', 'cut', 'ln',
  'readlink', 'realpath', 'xargs', 'expr', 'seq', 'yes', 'uname', 'id', 'whoami', 'hostname',
  'stat', 'du', 'df', 'md5sum', 'sha1sum', 'sha256sum', 'base64', 'od', 'tar', 'awk',
  'kill', 'ps', 'rmdir', 'install', 'cmp', 'patch', 'less', 'more', 'file', 'tree', 'bc',
];

/**
 * Builtins programs look for on PATH in Debian mode too (Debian's minimal
 * system has none of them): the browser opener and the clipboard tools that
 * native Claude Code runs. Their file's `#!` names no real interpreter, so
 * the kernel runs the builtin of that name (kernel.ts builtinLoader) and
 * Debian's sh is never involved; Debian's install leaves them in place.
 */
export const ALWAYS_SHIMS = ['xdg-open', 'sensible-browser', 'xclip', 'xsel', 'pbcopy', 'pbpaste', 'wl-copy'];
/** The `#!` of those files: no such program, so the kernel and the shell run the builtin the file is named after. */
export const BUILTIN_SHIM_INTERP = '/usr/libexec/tabcomputer/builtin';
const alwaysShim = (cmd: string) => `#!${BUILTIN_SHIM_INTERP}\n# The kernel runs tabcomputer's builtin ${cmd} for this path; the file lets PATH searches find it.\n`;

export async function installAlwaysShims(fs: FileSystem): Promise<void> {
  await fs.mkdir('/usr/local/bin', { recursive: true });
  for (const cmd of ALWAYS_SHIMS) {
    const p = `/usr/local/bin/${cmd}`;
    const text = await fs.readFile(p, 'utf8').catch(() => null);
    // Not over a program someone put there (only an older shim of ours)
    if (text === null || (typeof text === 'string' && (text === alwaysShim(cmd) || text === `#!/bin/sh\n${cmd} "$@"\n`))) {
      if (text !== alwaysShim(cmd)) await fs.writeFile(p, alwaysShim(cmd), { mode: 0o755 });
    }
  }
}

export async function installPathShims(fs: FileSystem, commands: { get(name: string): unknown } | null = null): Promise<void> {
  await installAlwaysShims(fs);
  for (const cmd of SHIM_COMMANDS) {
    if (commands && !commands.get(cmd)) continue;
    const shimPath = `/usr/local/bin/${cmd}`;
    // Don't overwrite real scripts (like claude bin stub), and leave PATH
    // to a program a package installed (`pkg install sqlite`)
    if (await fs.exists(shimPath) || await fs.exists(`/usr/bin/${cmd}`)) continue;
    await fs.writeFile(shimPath, `#!/bin/sh\n${cmd} "$@"\n`, { mode: 0o755 });
  }
  await fs.mkdir('/bin', { recursive: true });
  await fs.mkdir('/usr/bin', { recursive: true });
  if (!await fs.exists('/bin/sh')) await fs.writeFile('/bin/sh', '#!/bin/sh\n', { mode: 0o755 });
  if (!await fs.exists('/bin/bash')) await fs.writeFile('/bin/bash', '#!/bin/bash\n', { mode: 0o755 });
  if (!await fs.exists('/usr/bin/env')) await fs.writeFile('/usr/bin/env', '#!/bin/sh\n', { mode: 0o755 });
}

/** The name main.ts and other branches use. */
export const createPathShims = (fs: FileSystem): Promise<void> => installPathShims(fs);
