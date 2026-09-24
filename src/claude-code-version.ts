/**
 * Pinned version of the Claude Code npm package.
 *
 * Why pin instead of tracking `latest`:
 *
 * `@anthropic-ai/claude-code@2.1.113` (published 2026-04-17) changed the
 * package from a pure-JS bundle into a native-binary launcher.
 *
 *   <= 2.1.112   bin: { claude: "cli.js" }         — 13.7 MB JS bundle
 *   >= 2.1.113   bin: { claude: "bin/claude.exe" } — 500-byte placeholder
 *
 * On 2.1.113+ the real CLI is a platform-native executable shipped in
 * `@anthropic-ai/claude-code-<platform>` optionalDependencies, and the
 * package's `postinstall` (`node install.cjs`) is what overwrites
 * `bin/claude.exe` with that binary.
 *
 * Shiro's npm does not run postinstall scripts, and there is no native
 * execution in the browser anyway — so installing `latest` symlinks
 * /usr/local/bin/claude at the placeholder stub and `claude` dies with a bare
 * exit 1. 2.1.112 is the last release whose entry point Shiro's Node runtime
 * can actually execute.
 *
 * Before bumping this, verify the target version still ships `cli.js`:
 *   npm view @anthropic-ai/claude-code@<version> bin
 */
export const CLAUDE_CODE_VERSION = '2.1.112';

/**
 * Version the pinned JS build reports to the API.
 *
 * The backend gates newer models on the client version, which 2.1.112 sends
 * in the `x-anthropic-billing-header: cc_version=...` system block and in its
 * User-Agent. Both come from one `VERSION:"x.y.z"` constant that the bundler
 * inlines dozens of times into cli.js, so rewriting that constant at load time
 * is enough for the API to accept models like claude-opus-5-5.
 */
export const CLAUDE_CODE_REPORTED_VERSION = '2.1.280';

/** Default model for Claude Code sessions started in Shiro (ANTHROPIC_MODEL). */
export const CLAUDE_CODE_DEFAULT_MODEL = 'claude-opus-5-5';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** True for the entry script of the Claude Code npm package. */
export function isClaudeCodeScript(scriptPath: string | undefined): boolean {
  return !!scriptPath && scriptPath.includes('/@anthropic-ai/claude-code/');
}

// Models newer than the pinned build knows about (Opus/Sonnet 5+).
const NEWER_MODEL = '/(opus|sonnet)-[5-9]/';

/**
 * 2.1.112 decides model capabilities by name and only recognizes models up to
 * Opus 4.7. For anything newer it fell back to fixed-budget thinking, no effort
 * control, and a "medium" default effort on subscriptions. These rewrites treat
 * Opus/Sonnet 5+ like Opus 4.7: adaptive thinking, effort (incl. xhigh), and the
 * xhigh launch default. Each targets exact 2.1.112 code and is skipped if absent.
 * The last one swaps the file-locked task list for TodoWrite (see comment there).
 */
const CAPABILITY_PATCHES: Array<[string, string]> = [
  // adaptive thinking + effort support (the same gate appears in both checks)
  ['_.includes("opus-4-7")||_.includes("opus-4-6")||_.includes("sonnet-4-6")',
   `_.includes("opus-4-7")||_.includes("opus-4-6")||_.includes("sonnet-4-6")||${NEWER_MODEL}.test(_)`],
  // xhigh effort support
  ['return o5(q).includes("opus-4-7")}', `return /opus-4-7|(opus|sonnet)-[5-9]/.test(o5(q))}`],
  // default effort per model, and the launch default
  ['if(K.includes("opus-4-7"))return"xhigh";', `if(K.includes("opus-4-7")||${NEWER_MODEL}.test(K))return"xhigh";`],
  ['let _=o5(q).includes("opus-4-7")&&!H8().unpinOpus47LaunchEffort',
   `let _=/opus-4-7|(opus|sonnet)-[5-9]/.test(o5(q))&&!H8().unpinOpus47LaunchEffort`],
  // Interactive sessions default to the file-backed task list (TaskCreate etc.),
  // which guards task files with proper-lockfile and hung in Shiro's fs shim. Use
  // the in-memory TodoWrite list instead unless CLAUDE_CODE_ENABLE_TASKS=1.
  ['function kJ(){if(S6(process.env.CLAUDE_CODE_ENABLE_TASKS))return!0;return!I7()}',
   'function kJ(){return S6(process.env.CLAUDE_CODE_ENABLE_TASKS)}'],
  // Display names for the header and /model
  ['case"claude-opus-4-7":return"Opus 4.7"+K;', 'case"claude-opus-5-5":return"Opus 5.5"+K;case"claude-opus-4-7":return"Opus 4.7"+K;'],
  ['if(_.includes("claude-opus-4-7"))return K?"Opus 4.7 (1M context)":"Opus 4.7";',
   'if(_.includes("claude-opus-5-5"))return K?"Opus 5.5 (1M context)":"Opus 5.5";if(_.includes("claude-opus-4-7"))return K?"Opus 4.7 (1M context)":"Opus 4.7";'],
  // The welcome card still announced the Opus 4.7 launch
  ['title:"Opus 4.7 is here"', 'title:"Claude Code in Shiro"'],
  ['"Welcome to Opus 4.7 xhigh!"', '"Running in your browser on Shiro"'],
  ['pdK="Welcome to Opus 4.7 xhigh! · /effort', 'pdK="Running in your browser on Shiro · /effort'],
];

/**
 * Rewrite the Claude Code bundle as it loads: raise the version it reports to
 * CLAUDE_CODE_REPORTED_VERSION (only ever bumps), and teach it about newer models.
 */
export function patchClaudeCodeSource(code: string): string {
  let out = code.replace(/VERSION:"(\d+\.\d+\.\d+)"/g, (match, version: string) =>
    compareVersions(version, CLAUDE_CODE_REPORTED_VERSION) < 0
      ? `VERSION:"${CLAUDE_CODE_REPORTED_VERSION}"`
      : match,
  );
  for (const [from, to] of CAPABILITY_PATCHES) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

/** Package spec to hand to `npm install -g`. */
export const CLAUDE_CODE_PKG = `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`;

export const CLAUDE_CODE_DIR = '/usr/local/lib/node_modules/@anthropic-ai/claude-code';
export const CLAUDE_CODE_CLI_JS = `${CLAUDE_CODE_DIR}/cli.js`;
export const CLAUDE_BIN = '/usr/local/bin/claude';

/** Minimal slice of FileSystem this module needs, so it stays easy to test. */
interface FsLike {
  readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array>;
  stat(path: string): Promise<unknown>;
  readlink(path: string): Promise<string>;
}

/**
 * True only when the pinned, JS-executable build is installed *and* `claude`
 * on PATH actually resolves to it.
 *
 * `which claude` alone is not enough: anyone who ran `sc` while it installed
 * `latest` has a /usr/local/bin/claude symlink persisted in IndexedDB pointing
 * at the native-binary placeholder, so a `which`-only guard would skip the
 * repair install forever and leave them broken across reloads.
 *
 * A `cli.js` existence check is not enough either: npm installs over the top of
 * the existing package directory without cleaning it, so a cli.js left behind
 * by an older install survives a `latest` install that repoints the symlink at
 * bin/claude.exe. The version and the symlink target are the honest signals.
 */
export async function isClaudeCodeInstalled(fs: FsLike): Promise<boolean> {
  try {
    const raw = (await fs.readFile(`${CLAUDE_CODE_DIR}/package.json`, 'utf8')) as string;
    const pkg = JSON.parse(raw);
    if (pkg.version !== CLAUDE_CODE_VERSION) return false;
    if (typeof pkg.bin?.claude !== 'string' || !pkg.bin.claude.endsWith('cli.js')) return false;
    await fs.stat(CLAUDE_CODE_CLI_JS);
    const target = await fs.readlink(CLAUDE_BIN);
    return target === CLAUDE_CODE_CLI_JS || target.endsWith('/@anthropic-ai/claude-code/cli.js');
  } catch {
    return false;
  }
}

/**
 * Build the command `sc`, `cw`, and `builder` hand to a spawned shell:
 * install first when the pinned build isn't already wired up, then launch.
 */
export async function claudeLaunchCmd(fs: FsLike, claudeArgs = ''): Promise<string> {
  const launch = `claude --dangerously-skip-permissions${claudeArgs}`;
  if (await isClaudeCodeInstalled(fs)) return launch;
  return `npm install -g ${CLAUDE_CODE_PKG} && ${launch}`;
}

/** npm registry tarball for the pinned build. */
export const CLAUDE_CODE_TARBALL_URL =
  `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${CLAUDE_CODE_VERSION}.tgz`;

/** Files from the tarball Shiro needs; vendor/ only holds native binaries. */
const CLAUDE_CODE_FILES = ['package.json', 'cli.js', 'LICENSE.md', 'README.md'];

interface InstallFs extends FsLike {
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

let installing: Promise<void> | null = null;

/**
 * Install the pinned Claude Code build straight from its npm tarball, the way
 * `npm install -g` would, minus the native vendor/ binaries Shiro can't run.
 * Concurrent callers share one download.
 */
export function installClaudeCode(fs: InstallFs): Promise<void> {
  installing ??= (async () => {
    const { extractTarGz } = await import('./utils/tar-utils');
    const resp = await fetch(CLAUDE_CODE_TARBALL_URL);
    if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
    const entries = await extractTarGz(new Uint8Array(await resp.arrayBuffer()));
    await fs.mkdir(CLAUDE_CODE_DIR, { recursive: true });
    for (const entry of entries) {
      const name = entry.name.replace(/^package\//, '');
      if (entry.type === 'file' && entry.data && CLAUDE_CODE_FILES.includes(name)) {
        await fs.writeFile(`${CLAUDE_CODE_DIR}/${name}`, entry.data);
      }
    }
    await fs.mkdir('/usr/local/bin', { recursive: true });
    try { await fs.unlink(CLAUDE_BIN); } catch { /* not there yet */ }
    await fs.symlink(CLAUDE_CODE_CLI_JS, CLAUDE_BIN);
  })().finally(() => { installing = null; });
  return installing;
}

/** Install the pinned build unless it is already wired up. */
export async function ensureClaudeCodeInstalled(fs: InstallFs): Promise<void> {
  if (await isClaudeCodeInstalled(fs)) return;
  await installClaudeCode(fs);
  if (!(await isClaudeCodeInstalled(fs))) throw new Error('install did not produce a runnable claude');
}
