/**
 * claude - Run Claude Code in this terminal.
 *
 * Claude Code signs itself in, in the terminal: signed out, it opens the
 * sign-in page in a new browser tab (xdg-open, src/open-url.ts) and asks for
 * the code that page shows. Settings → Accounts has the page's own sign-in
 * panel (src/claude-signin.ts) as an alternative; `claude` never opens it.
 *
 *   claude                   # Interactive session
 *   claude -p "fix the bug"  # Print mode
 *   claude login             # Sign in, or switch accounts (`claude auth login`)
 *
 * Which build plain `claude` runs is the profile's `shims.claude`: tabcomputer
 * runs Anthropic's native binary in the x86-64 emulator, shiro the pinned npm
 * build. Either way:
 *   claude --native ... / claude --npm ...   # pick one for this run (CLAUDE_NATIVE=1/0 too)
 *   claude install [--native|--npm] [ver]    # install that build (native: claude-native.ts)
 */

import { Command } from './index';
import {
  CLAUDE_CODE_CLI_JS,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_REPORTED_VERSION,
  ensureClaudeCodeInstalled,
  isClaudeCodeInstalled,
} from '../claude-code-version';
import { activeProfile } from '../profile';
import { ensureClaudeTransform } from '../claude-transform-cache';

// Flags that make Claude print something and exit instead of starting a session
const INFO_FLAGS = new Set(['-v', '--version', '-h', '--help']);

export function needsSession(args: string[]): boolean {
  if (args.some(a => INFO_FLAGS.has(a))) return false;
  // Subcommands (mcp, config, doctor, ...) take their own flags
  return args.length === 0 || args[0].startsWith('-');
}

/**
 * `claude login` (and `/login`): Claude Code's own sign-in. The native build's
 * `claude auth login` asks for the code to paste; the npm build's (2.1.112)
 * only waits for a localhost callback that can't arrive here, so it starts a
 * session whose first input is `/login`, which has the paste prompt.
 */
export function loginArgs(args: string[], build: 'native' | 'npm' = 'native'): string[] {
  if (args[0] !== 'login' && args[0] !== '/login') return args;
  return build === 'native' ? ['auth', 'login', ...args.slice(1)] : ['/login'];
}

/** Where `claude --native` looks for the binary: $CLAUDE_NATIVE_PATH, else ~/.local/bin/claude. */
export function nativeClaudePath(env: Record<string, string>): string {
  return env.CLAUDE_NATIVE_PATH || `${env.HOME || '/home/user'}/.local/bin/claude`;
}

const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

/**
 * `claude --native` / CLAUDE_NATIVE=1: run Anthropic's native build in Blink
 * instead of the pinned npm one. The linux-x64-musl build works (it needs
 * musl's loader at /lib/ld-musl-x86_64.so.1); the glibc build still crashes
 * at startup in Blink. `claude install --native` downloads it from inside
 * the guest (claude-native.ts). docs/COMPAT.md "Agent CLIs".
 */
async function runNative(ctx: Parameters<Command['exec']>[0], args: string[]): Promise<number> {
  const path = nativeClaudePath(ctx.env);
  let elf = false;
  let raw: Uint8Array | string | null = null;
  try {
    raw = await ctx.fs.readFile(path);
    elf = typeof raw !== 'string' && raw.length > 4 && raw[0] === 0x7f && raw[1] === 0x45 && raw[2] === 0x4c && raw[3] === 0x46;
  } catch { /* missing */ }
  if (!elf) {
    ctx.stderr += `claude: native Claude Code is not installed (no binary at ${path}).\n`
      + 'Run `claude install` to download it (about 240 MB; it runs in the x86-64 emulator),\n'
      + 'or `claude --npm` for the pinned npm build, which needs no download.\n'
      + '(CLAUDE_NATIVE_PATH picks another path for the linux-x64-musl binary.)\n';
    return 1;
  }
  args = loginArgs(args);
  // Same settings cleanup as the npm build's start (e.g. drop the "mcp__*"
  // allow rule older Shiro seeded, which current Claude Code warns about)
  try {
    const { ensureClaudeBootstrap } = await import('../claude-config');
    await ensureClaudeBootstrap(ctx.fs, { homeDir: ctx.env.HOME || '/home/user' });
  } catch { /* settings are Claude's own business; never block the run */ }
  // JSC's JIT costs more than it saves under Blink: -p took 85 s without it
  // and 107 s with it (musl build, docs/COMPAT.md). Export BUN_JSC_useJIT=1 to keep it.
  const jit = ctx.env.BUN_JSC_useJIT === undefined ? 'BUN_JSC_useJIT=0 ' : '';
  // URLs as OSC 8 links: the sign-in URL Claude prints wraps over several
  // lines, and a click on the link opens it (no popup blocker involved)
  const links = ctx.env.FORCE_HYPERLINK === undefined ? 'FORCE_HYPERLINK=1 ' : '';
  // Which build an agent inside is (~/AGENTS.md, src/agent-docs.ts)
  const { nativeClaudeVersion } = await import('./claude-native');
  const version = await nativeClaudeVersion(ctx.fs, path, raw as Uint8Array);
  const build = `TABCOMPUTER_CLAUDE_BUILD=native TABCOMPUTER_CLAUDE_VERSION=${quote(version ?? 'unknown')} `;
  const line = jit + links + build + [path, ...args].map(quote).join(' ');
  return ctx.shell.execute(line, (s) => { ctx.stdout += s.replace(/\r\n/g, '\n'); }, (s) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }, false, ctx.terminal, true);
}

export const claudeCmd: Command = {
  name: 'claude',
  description: 'Run Claude Code (installed automatically; it signs itself in)',
  async exec(ctx) {
    const args = [...ctx.args];
    // The build: --npm/--native first (or after `install`), then CLAUDE_NATIVE=0/1, then the profile
    const install = args[0] === 'install';
    const flagAt = install ? 1 : 0;
    let pick: 'npm' | 'native' | null = null;
    while (args[flagAt] === '--npm' || args[flagAt] === '--native') pick = args.splice(flagAt, 1)[0] === '--npm' ? 'npm' : 'native';
    if (install && !pick) {
      const i = args.findIndex((a) => a === '--npm' || a === '--native');
      if (i > 0) pick = args.splice(i, 1)[0] === '--npm' ? 'npm' : 'native';
    }
    const native = pick ? pick === 'native'
      : ctx.env.CLAUDE_NATIVE === '1' ? true
      : ctx.env.CLAUDE_NATIVE === '0' ? false
      : activeProfile().shims.claude === 'native';
    if (native) {
      // `claude install [version]` and `claude update` download the native build (never the binary's own installer)
      if (install || args[0] === 'update' || args[0] === 'upgrade') {
        const version = install ? args.slice(1).find((a) => !a.startsWith('-')) : undefined;
        const { installNativeClaude } = await import('./claude-native');
        return installNativeClaude(ctx, nativeClaudePath(ctx.env), version);
      }
      return runNative(ctx, args);
    }
    const write = (s: string) => {
      if (ctx.terminal) ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n'));
      else ctx.stderr += s;
    };

    if (args[0] === 'update' || args[0] === 'upgrade' || args[0] === 'install') {
      ctx.stdout += `Claude Code in tabcomputer is pinned to ${CLAUDE_CODE_VERSION}, the last release that ships as JavaScript\n`
        + `(later releases are native binaries). It reports itself as ${CLAUDE_CODE_REPORTED_VERSION} so current models work.\n`
        + (activeProfile().shims.claude === 'native'
          ? 'Plain `claude` runs the native build; `claude --npm` runs this one.\n'
          : 'The native build can run in the x86-64 emulator (experimental, slow): claude install --native, then claude --native.\n');
      return 0;
    }

    if (!(await isClaudeCodeInstalled(ctx.fs))) {
      write(`Installing Claude Code ${CLAUDE_CODE_VERSION}...\n`);
      try {
        await ensureClaudeCodeInstalled(ctx.fs);
      } catch (e: any) {
        ctx.stderr += `claude: install failed: ${e?.message || e}\n`;
        return 1;
      }
    }

    args.splice(0, args.length, ...loginArgs(args, 'npm'));

    if (needsSession(args) && !args.some(a => a === '--dangerously-skip-permissions' || a === '--permission-mode')) {
      args.unshift('--dangerously-skip-permissions');
    }

    const nodeCmd = ctx.shell.commands.get('node');
    if (!nodeCmd) {
      ctx.stderr += 'claude: node command not available\n';
      return 127;
    }
    // cli.js as node-compat runs it, written here before node starts (claude-transform-cache.ts)
    await ensureClaudeTransform(ctx.fs as any).catch(() => {});
    // OSC 8 links for the URLs it prints (the sign-in URL is clickable), as for the native build
    // Which build an agent inside is (~/AGENTS.md, src/agent-docs.ts)
    const env = { FORCE_HYPERLINK: '1', ...ctx.env, TABCOMPUTER_CLAUDE_BUILD: 'npm', TABCOMPUTER_CLAUDE_VERSION: CLAUDE_CODE_VERSION };
    const nodeCtx = { ...ctx, env, args: [CLAUDE_CODE_CLI_JS, ...args], stdout: '', stderr: '' };
    const exitCode = await nodeCmd.exec(nodeCtx);
    ctx.stdout += nodeCtx.stdout;
    ctx.stderr += nodeCtx.stderr;
    return exitCode;
  },
};
