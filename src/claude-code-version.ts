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
