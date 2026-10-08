/**
 * What boot puts on disk so programs that look commands up on PATH, or
 * stat /bin/sh, find them: a `#!/bin/sh` wrapper per common builtin in
 * /usr/local/bin, plus /bin/sh, /bin/bash and /usr/bin/env. The kernel runs
 * a bin-dir path to a builtin as that builtin (kernel.ts builtinLoader).
 */
import type { FileSystem } from './filesystem';

// This is how an OS advertises its commands — the PATH mechanism, not the builtin registry.
export const SHIM_COMMANDS = [
  'git', 'node', 'npm', 'npx', 'ls', 'cat', 'grep', 'sed', 'find', 'curl',
  'mkdir', 'rm', 'cp', 'mv', 'echo', 'touch', 'chmod', 'head', 'tail',
  'sort', 'uniq', 'wc', 'tr', 'tee', 'diff', 'env', 'which', 'test',
  'sh', 'bash', 'vi', 'nano', 'rg', 'esbuild',
  'mktemp', 'jq', 'tput', 'stty', 'gzip', 'gunzip', 'wget',
  'pgrep', 'pkill', 'nproc', 'getconf', 'ed', 'iconv', 'zip', 'unzip',
  'cc', 'gcc', 'python', 'python3', 'pip', 'pip3', 'sqlite3',
];

export async function createPathShims(fs: FileSystem): Promise<void> {
  await fs.mkdir('/usr/local/bin', { recursive: true });
  for (const cmd of SHIM_COMMANDS) {
    const shimPath = `/usr/local/bin/${cmd}`;
    // Don't overwrite real scripts (like claude bin stub), and leave PATH
    // to a program a package installed (`pkg install sqlite`)
    if (await fs.exists(shimPath) || await fs.exists(`/usr/bin/${cmd}`)) continue;
    await fs.writeFile(shimPath, `#!/bin/sh\n${cmd} "$@"\n`);
  }
  // Create /bin/sh, /bin/bash, /usr/bin/env so stat() checks pass
  await fs.mkdir('/bin', { recursive: true });
  await fs.mkdir('/usr/bin', { recursive: true });
  if (!await fs.exists('/bin/sh')) await fs.writeFile('/bin/sh', '#!/bin/sh\n');
  if (!await fs.exists('/bin/bash')) await fs.writeFile('/bin/bash', '#!/bin/bash\n');
  if (!await fs.exists('/usr/bin/env')) await fs.writeFile('/usr/bin/env', '#!/bin/sh\n');
}
