/**
 * The instructions a coding agent finds in the home directory: one file,
 * ~/AGENTS.md, describing the machine it is actually on, and ~/CLAUDE.md,
 * which imports it (`@AGENTS.md`), so Claude Code reads it with no extra hop.
 *
 * Seeded on every boot, but never over a file the user changed: the hashes of
 * what was seeded are kept in /var/lib/tabcomputer/seeded.json, and a file is
 * replaced only while it still hashes to what we wrote. Installs from before
 * that manifest are recognized by the exact texts older builds seeded. Those
 * builds also wrote ~/NEO.md and ~/.shiro-context.json, which are removed when
 * they are still as written and left alone otherwise.
 */
import type { FileSystem } from './filesystem';
import { activeProfile } from './profile';
import { type ShiroRuntimeContext, parseRuntimeContext } from './seed-runtime-context';

export const AGENTS_PATH = '/home/user/AGENTS.md';
export const CLAUDE_PATH = '/home/user/CLAUDE.md';
export const MANIFEST_PATH = '/var/lib/tabcomputer/seeded.json';
const OLD_NEO_PATH = '/home/user/NEO.md';
const OLD_CONTEXT_PATH = '/home/user/.shiro-context.json';

/** Where each product's source lives (not checked out on the machine). */
const SOURCE: Record<string, string> = {
  shiro: 'https://github.com/williamsharkey/shiro',
  tabcomputer: 'https://github.com/williamsharkey/tabcomputer',
};

/** sha256 of the AGENTS.md and CLAUDE.md texts earlier builds seeded. */
const OLD_SEEDED = new Set([
  '48d10c82579a06f3264a6703cb3a32b4951da31900ff2713769db2f01f5a4eec', // AGENTS.md, "running inside Shiro Browser OS"
  'efcb97c487e617e44606b520e4f7da8a876a86c43b9f8c12e396e6b6214a799c', // AGENTS.md, the same renamed
  '7c740cab9e4ae89d026900d8fc02575164c8773bc2e1708f2b7daf7f605679ce', // CLAUDE.md, "Deprecated. Read AGENTS.md, then NEO.md"
]);

function bootSection(ctx: ShiroRuntimeContext, name: string): string {
  if (!ctx.injected) {
    return `This boot runs on its own page (not injected into another site). \`hc live\` inspects ${name}'s own page.`;
  }
  return [
    `This boot was injected into a host page by \`seed${ctx.mode === 'seed-blob' ? ' blob' : ''}\`:`,
    '',
    `- Host page: ${ctx.hostUrl || '(unknown)'} (origin ${ctx.hostOrigin || 'unknown'}, title "${ctx.hostTitle || ''}")`,
    `- Same-origin access to the host's DOM: ${ctx.sameOriginParentAccess ? 'yes' : 'no'}`,
    '',
    'Start with `hc outer` to inspect the host page, then `hc s`, `hc look`, `hc q <selector>`, `hc @0`.',
    `\`hc live\` inspects ${name}'s own page, not the host.`,
  ].join('\n');
}

/**
 * Known problems an agent here should plan around, rendered into AGENTS.md.
 * Facts about this build only: remove an entry in the change that fixes it.
 * Live state (what is installed, signed in, reachable) is `doctor`'s job.
 */
export const KNOWN_ISSUES: { issue: string; workaround?: string }[] = [
  {
    issue: "Claude Code's Bash tool adds `< /dev/null` only to commands without a `<` of their own, so a command with a here-doc or input redirect inherits the tool's stdin, which never ends; anything else in it that reads stdin (`cat`, `node`, `npx`, `claude --npm`) hangs until the tool's timeout.",
    workaround: 'Wrap a command that may read stdin as `{ cmd; } </dev/null`; a group\'s redirect works.',
  },
  {
    issue: 'Once a `node` has been killed by `timeout`, the tab can wedge so that `node -e CODE`, `node file.js`, `esbuild` and `claude --npm` print nothing and hang, whatever their stdin (tabcomputer#13). `node -v`, `npm init` and `python3` still work.',
    workaround: 'Reload the tab (this ends running agents, including you), or do node work such as `vitest` and `esbuild` in a checkout outside the tab.',
  },
  {
    issue: 'Process odds and ends (tabcomputer#14): `/proc/self/fd/N` links say `/dev/pts/0` even for a pipe or file, and `stat -L` on them can disagree with the link; `/proc/PID/cmdline` holds only argv[0]; the built-in tmux fails `tmux new-session -d` with "not a terminal"; in-page background jobs (`node … &`) have a `/proc/$!` but `ps` doesn\'t list them; exited children of init linger as zombies; `/proc/loadavg` reads 0; `kill PID` on a `bash -c` blocked in a command can leave it running.',
    workaround: 'Use `[ -t N ]` to ask whether an fd is a terminal (it works); for a detached job use `nohup cmd >log 2>&1 &` or `pkg install tmux` for the real tmux; find in-page jobs with `jobs -l` or `ls /proc`; use `kill -9` when `kill` doesn\'t take; ignore `Z` lines in `ps`.',
  },
  {
    issue: '`js-eval` runs the code a second time when it throws, and it cannot run statements, only an expression (tabcomputer#17).',
    workaround: 'Pass one expression: wrap statements in an async IIFE, `js-eval "(async () => { ...; return x; })()"`, and make any patch idempotent (check before you change), since a throw runs it twice.',
  },
  {
    issue: "Images can't be pasted into Claude Code: `xclip` and `xsel` here are text only.",
    workaround: 'Save the image to a file and give its path.',
  },
  {
    issue: "In Debian mode, dpkg-deb's `.xz` decompression sometimes crashes or reports corrupt data under the x86-64 emulator, so `apt install` stops with a dpkg error.",
    workaround: 'Run the install again.',
  },
  {
    issue: '`gh issue view --comments` is not implemented (an unknown-flag error).',
    workaround: 'Use `gh api repos/OWNER/REPO/issues/N/comments --jq ".[].body"`.',
  },
];

function knownIssues(): string {
  return KNOWN_ISSUES.map((k) => `- ${k.issue}${k.workaround ? ` ${k.workaround}` : ''}`).join('\n');
}

/** ~/AGENTS.md for this boot. */
export function buildAgentsMd(ctx: ShiroRuntimeContext): string {
  const p = activeProfile();
  const name = p.name;
  const site = p.brand?.domain ?? 'shiro.computer';
  const source = SOURCE[p.id] ?? SOURCE.tabcomputer;
  const claude = p.shims.claude === 'native'
    ? `- Plain \`claude\` runs Anthropic's native build in the x86-64 emulator. \`claude install\`
  downloads it (about 240 MB) and \`claude update\` fetches a newer one. It is slow: one
  \`claude -p\` request takes a minute or two.
- \`claude --npm\` runs the pinned pure-JavaScript build on ${name}'s Node runtime
  instead: installed at boot, starts fast.`
    : `- Plain \`claude\` runs the pinned pure-JavaScript build on ${name}'s Node runtime.
- \`claude install --native\` then \`claude --native\` runs Anthropic's native build in
  the x86-64 emulator (about 240 MB; one request takes a minute or two).`;
  return `# AGENTS.md

You are on ${name} (${site}): a computer that lives in a browser tab. You are a
coding agent inside it. The kernel, filesystem, shell and programs all run in
this page; there is no VM or server-side machine behind it.

## This boot

${bootSection(ctx, name)}

## Orient yourself

- \`doctor\` prints this tab's state, one OK/WARN/FAIL line per subsystem.
  \`doctor --agents\` checks, step by step, what agent CLIs need from both
  runtimes.
- \`echo $TABCOMPUTER_CLAUDE_BUILD $TABCOMPUTER_CLAUDE_VERSION\` tells you which
  Claude Code you are, when ${name}'s \`claude\` started you. \`native\` is Anthropic's
  binary in the x86-64 emulator: about 2 minutes per request. \`npm\` is the pinned
  pure-JavaScript build on ${name}'s Node runtime: much faster.
- Read "Known issues" below before working around something that fails, and
  check the tracker for newer ones: \`gh issue list -R ${source.replace('https://github.com/', '')}\`.

## The machine

- A Unix kernel written in TypeScript runs in the page: processes, fork/exec,
  pipes, ptys, signals, job control, sockets, \`/proc\`. \`ps\` lists kernel
  processes.
- The shell is ${name}'s own bash-compatible shell, with many builtins:
  coreutils, grep/sed/awk, \`rg\`, \`jq\`, \`git\`, \`gh\`, \`curl\`, \`vi\`, \`nano\`, \`tmux\`.
- Home is \`/home/user\`. Files persist in this browser's storage for this site
  across reloads. They are not synced anywhere else: commit and push work you
  want to keep. You run as uid 1000; \`sudo\` gives root inside ${name}.
- x86-64 Linux programs run in the Blink emulator, compiled to WebAssembly:
  correct, but big programs take seconds to start. WASM programs run directly.
- \`node\`, \`npm\` and \`npx\` are a Node.js-compatible runtime built into the page,
  not real Node. Most pure-JS npm packages work; native addons (\`.node\`) don't.
  Each \`node\` is a real process in a background worker: \`*Sync\` child_process
  calls block, \`ps\` and \`kill\` see it, and a server (\`node server.js\`, \`npm run
  dev\`) stays in the foreground while it listens, as on Linux. Start one with
  \`&\` (\`node server.js > server.log 2>&1 &\`) to keep using the shell, and stop it
  with \`kill %1\`. \`TABCOMPUTER_NODE_WORKER=0\` runs node in the page instead.
- Network: outbound HTTP(S) works. Linux programs get TCP through the site's
  relay when it is on (ports 22, 80, 443, 9418); UDP is DNS only. Nothing on the
  internet can connect in.
- \`/dom\` is the page itself as files (\`ls /dom\`).

## Installing software

- Real Debian: \`debian install\` streams in Debian 13, then \`sudo apt update\` (about
  45 s) and \`sudo apt install -y NAME\` (Debian's own apt and dpkg, x86-64 in the
  emulator: about a minute for a small package, python3 about 4 minutes). 496 of
  popcon's top 500 packages pass a smoke test.
- Whole toolchains: \`toolchain install c\` (gcc, g++, make, gdb, cmake), \`python\`,
  \`go\` (std precompiled), \`tex\`, \`classic\` (Fortran, COBOL, Pascal, Ada), \`node\`
  or \`java\` puts the Debian packages in place in seconds instead of apt's minutes;
  dpkg knows them, so apt keeps working. \`toolchain list\` shows the sets. The first run of each program
  downloads it (gcc's hello world takes about 9 s from a fresh tab).
- Prebuilt: \`pkg install NAME\` installs one of ${name}'s 72 prebuilt programs
  (WebAssembly or static x86-64: vim, htop, git, python3, jq, curl, make, clang,
  go, ...) in about a second, and they start faster than Debian's. \`pkg available\`
  lists them. Before \`debian install\`, \`apt\` is \`pkg\`; after it, \`apt\` is Debian's.
- \`/usr/bin/NAME\` is whichever was installed last. To go back from Debian's to the
  prebuilt one: \`sudo apt remove -y NAME && pkg install --reinstall NAME\`.
  \`tabcomputer-alternatives --list\` shows which programs are ${name}'s builtins
  and which are Debian's; \`--set NAME debian\` and \`--auto NAME\` switch one.
- \`npm install\` works; \`pip install\` installs pure-Python wheels.
- \`python3\` is Pyodide until a \`pkg\` or Debian python3 is installed.
- \`gui\` lists X11 desktop apps; \`gui NAME\` opens one in a window.

## Useful here

- Web apps: \`npm create vite@latest app -- --template react\`, \`npm i\`, \`npm run dev\`,
  then \`serve open 5173\` shows it in a preview window with hot reload.
- \`serve DIR\` serves a folder in a preview window; a program that \`listen()\`s on
  a port is served the same way. Both are reachable only from this tab.
- \`page :PORT text|click|input|eval ...\` drives that page, so you can test a UI
  without a browser automation tool.
- \`gh auth login\` signs in to GitHub; git and gh then use the token. The built-in
  gh takes \`--body-file FILE\` and \`--json FIELDS --jq EXPR\`; a flag it doesn't
  implement is an error, never silently ignored.
- If a prebuilt package misbehaves, check \`pkg outdated\` and run \`pkg upgrade\` first: fixed builds ship as
  new versions (a stale python3 caused tabcomputer#5).

## What doesn't work

- inotify is ENOSYS for Linux programs (entr, inotifywait). Node's \`fs.watch\`
  works, so nodemon, vite's hot reload and jest --watch do.
- \`time\` reports no user/sys CPU time.
- Docker, VMs, kernel modules, GPU access, a D-Bus session bus.
- \`systemctl\` is a small built-in service manager, not systemd.
- Everything stops when the tab is closed or reloaded, including background jobs.
- Concurrency: an x86-64 process runs one guest thread at a time, and every
  process shares this one browser tab's CPU and memory. The tab uses about 220 MB
  booted; \`apt-get update\` adds about 580 MB at its peak and an install up to
  about 880 MB. Run one \`apt\` or build at a time, at most one subagent, gh and curl
  calls one after another, and at most 4 tool calls in parallel (Claude Code
  here is set to 4). Running the same apt work in four
  tabs at once made each step 1.4–1.7 times slower.

## When something is wrong

- \`doctor\` prints one OK/WARN/FAIL line per subsystem: the build, browser
  isolation, the x86 engine, the network relay, sign-ins, Debian, storage and
  the kernel. It never prints secrets. Run it first.
- \`dmesg\` shows the kernel log; relay refusals land there when curl or git
  only say "Could not connect".
- A command that hangs: press Ctrl-C at the terminal. Linux and WASM programs are
  kernel processes: \`ps\` lists them, \`kill PID\` (or \`kill -9 PID\`) stops
  them; \`node\` is one too. Builtins (the Pyodide \`python3\`, and \`node\` with
  \`TABCOMPUTER_NODE_WORKER=0\`) run inside the page, not as kernel processes.
  Started in the background, one still has a PID (\`$!\`, \`jobs -l\`): \`ps\`
  lists it, it has a \`/proc/PID\`, and \`kill PID\` stops it from any shell. A
  builtin in the foreground has none: Ctrl-C it, or reload.
- \`console -g PATTERN\` searches the page's console log (\`--prev\` includes the
  load before the last reload).
- Report bugs at ${source}/issues (\`gh issue create\` works here): the command,
  what happened, what you expected, and the \`doctor\` output.

## Source

${name} is open source: ${source}. The source is not checked out on this
machine; \`git clone --depth 1 ${source}\` if you need to read it. Its docs/
folder has the details and the measured scoreboards. Where things live:

- the shell: \`src/shell.ts\` and \`src/shell-*.ts\` (some builtins, like \`eval\`,
  are special-cased in shell.ts); other commands: \`src/commands/NAME.ts\` (a few
  files there, like \`eval.ts\`, are unused stubs)
- the kernel (processes, fds, pipes, ptys, signals, sockets, IPC): \`src/kernel/\`;
  \`/proc\`: \`src/kernel/procfs.ts\`
- the filesystem: \`src/filesystem.ts\`; the Node runtime: \`src/node-compat/\`
- WASM programs: \`src/wasi/\`; x86-64 programs: \`src/x86-engine/\` and the Blink
  patches in \`vendor/blink/patches/\`; Debian mode: \`src/debian/\`
- prebuilt packages: \`src/pkg-index.json\`, recipes in \`scripts/pkgbuild/\`

## Known issues

${knownIssues()}

## Claude Code here

${claude}
- Signed out, Claude Code opens the sign-in page in a new browser tab and asks for the
  code it shows; \`claude login\` signs in again.
- Credentials are in \`~/.claude/.credentials.json\`; never print them or any other token.
`;
}

/** ~/CLAUDE.md: Claude Code imports AGENTS.md from it. */
export const CLAUDE_MD = '@AGENTS.md\n';

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ~/NEO.md as builds before AGENTS.md held the boot context wrote it. */
function oldNeoMd(ctx: ShiroRuntimeContext, name: string): string {
  if (!ctx.injected) {
    return `# NEO.md\n\nThis file describes the runtime context for this ${name} boot.\n\n- Mode: standalone\n- Host page DOM bridge: unavailable\n- \`hc live\` inspects ${name}'s own DOM\n- \`hc outer\` is not expected to work in this boot\n`;
  }
  return `# NEO.md

This ${name} instance was spawned from a host page.

- Mode: ${ctx.mode === 'seed-blob' ? 'seed blob injection' : 'seed injection'}
- Host page: ${ctx.hostUrl || '(unknown)'}
- Host origin: ${ctx.hostOrigin || '(unknown)'}
- Host title: ${ctx.hostTitle || '(untitled)'}
- Host DOM bridge: available via \`hc outer\`
- Same-origin parent DOM access: ${ctx.sameOriginParentAccess ? 'yes' : 'no'}

Start with:

1. Run \`hc outer\`
2. Then use \`hc s\`, \`hc look\`, \`hc q <selector>\`, \`hc @0\`

Notes:

- \`hc live\` inspects ${name}'s own DOM, not the host page
- Prefer \`hc outer\` for host-page inspection even in blob mode
- Machine-readable details are in \`/home/user/.shiro-context.json\`
`;
}

type SeedFS = Pick<FileSystem, 'mkdir' | 'readFile' | 'writeFile' | 'unlink'>;

async function readText(fs: SeedFS, path: string): Promise<string | null> {
  try { return await fs.readFile(path, 'utf8') as string; } catch { return null; }
}

/**
 * Write AGENTS.md and CLAUDE.md, replacing earlier seeded versions but never a
 * file the user edited; remove the retired NEO.md/.shiro-context.json the same
 * way. Returns what it did, one line per file it touched or left alone.
 */
export async function seedAgentDocs(fs: SeedFS, ctx: ShiroRuntimeContext): Promise<string[]> {
  const log: string[] = [];
  let manifest: Record<string, string> = {};
  try { manifest = JSON.parse((await readText(fs, MANIFEST_PATH)) ?? '{}') ?? {}; } catch { manifest = {}; }
  const seededByUs = async (path: string, text: string) => {
    const h = await sha256(text);
    return h === manifest[path] || OLD_SEEDED.has(h);
  };

  // Retired files: NEO.md is recognized by regenerating it from the context
  // file written next to it; the context file is machine-written JSON.
  const oldJson = await readText(fs, OLD_CONTEXT_PATH);
  const oldCtx = oldJson === null ? null : parseRuntimeContext(oldJson);
  const jsonIsOurs = oldJson !== null && JSON.stringify(oldCtx, null, 2) === oldJson;
  const neo = await readText(fs, OLD_NEO_PATH);
  if (neo !== null) {
    const basis = jsonIsOurs ? oldCtx! : { ...ctx, injected: false };
    if (['Shiro', 'tabcomputer'].some((n) => oldNeoMd(basis, n) === neo)) {
      await fs.unlink(OLD_NEO_PATH);
      log.push(`removed ${OLD_NEO_PATH} (now part of AGENTS.md)`);
    } else log.push(`kept ${OLD_NEO_PATH} (edited)`);
  }
  if (oldJson !== null) {
    if (jsonIsOurs) { await fs.unlink(OLD_CONTEXT_PATH); log.push(`removed ${OLD_CONTEXT_PATH}`); }
    else log.push(`kept ${OLD_CONTEXT_PATH} (edited)`);
  }

  await fs.mkdir('/home/user', { recursive: true });
  for (const [path, text] of [[AGENTS_PATH, buildAgentsMd(ctx)], [CLAUDE_PATH, CLAUDE_MD]] as const) {
    const have = await readText(fs, path);
    if (have === text) { manifest[path] = await sha256(text); continue; }
    if (have !== null && !(await seededByUs(path, have))) { log.push(`kept ${path} (edited)`); continue; }
    await fs.writeFile(path, text);
    manifest[path] = await sha256(text);
    log.push(`${have === null ? 'wrote' : 'updated'} ${path}`);
  }
  await fs.mkdir('/var/lib/tabcomputer', { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  return log;
}
