/**
 * claude - Run Claude Code in this terminal.
 *
 * Wraps the npm CLI so it just works in Shiro:
 *   - installs the pinned JS build on first use (normally done at boot)
 *   - shows the sign-in panel when there are no saved credentials
 *   - skips permission prompts by default, as `sc` always did
 *
 *   claude                   # Interactive session
 *   claude -p "fix the bug"  # Print mode
 *   claude login             # Sign in (or switch accounts) via the panel
 *   claude --native ...      # Run the native binary instead (CLAUDE_NATIVE=1 too; experimental)
 *   claude install --native  # Download it (claude-native.ts)
 */

import { Command } from './index';
import {
  CLAUDE_CODE_CLI_JS,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_REPORTED_VERSION,
  ensureClaudeCodeInstalled,
  isClaudeCodeInstalled,
} from '../claude-code-version';
import { hasClaudeCredentials, openClaudeSignIn } from '../claude-signin';

// Flags that make Claude print something and exit instead of starting a session
const INFO_FLAGS = new Set(['-v', '--version', '-h', '--help']);

export function needsSession(args: string[]): boolean {
  if (args.some(a => INFO_FLAGS.has(a))) return false;
  // Subcommands (mcp, config, doctor, ...) take their own flags
  return args.length === 0 || args[0].startsWith('-');
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
  try {
    const raw = await ctx.fs.readFile(path);
    elf = typeof raw !== 'string' && raw.length > 4 && raw[0] === 0x7f && raw[1] === 0x45 && raw[2] === 0x4c && raw[3] === 0x46;
  } catch { /* missing */ }
  if (!elf) {
    ctx.stderr += `claude: no native Claude Code binary at ${path}\n`
      + 'Install it with `claude install --native` (experimental: it runs in the x86-64 emulator, about 2 minutes\n'
      + 'per request), or put the linux-x64-musl build there yourself with musl\'s loader at /lib/ld-musl-x86_64.so.1\n'
      + '(CLAUDE_NATIVE_PATH picks another path). Without --native, claude runs the npm build.\n';
    return 1;
  }
  const line = [path, ...args].map(quote).join(' ');
  return ctx.shell.execute(line, (s) => { ctx.stdout += s.replace(/\r\n/g, '\n'); }, (s) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }, false, ctx.terminal, true);
}

export const claudeCmd: Command = {
  name: 'claude',
  description: 'Run Claude Code (installed and signed in automatically)',
  async exec(ctx) {
    const args = [...ctx.args];
    if (args[0] === '--native' || ctx.env.CLAUDE_NATIVE === '1') {
      if (args[0] === '--native') args.shift();
      return runNative(ctx, args);
    }
    const write = (s: string) => {
      if (ctx.terminal) ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n'));
      else ctx.stderr += s;
    };

    if (args[0] === 'install' && args.includes('--native')) {
      const version = args.slice(1).find((a) => !a.startsWith('-'));
      const { installNativeClaude } = await import('./claude-native');
      return installNativeClaude(ctx, nativeClaudePath(ctx.env), version);
    }
    if (args[0] === 'update' || args[0] === 'upgrade' || args[0] === 'install') {
      ctx.stdout += `Claude Code in Shiro is pinned to ${CLAUDE_CODE_VERSION}, the last release that ships as JavaScript\n`
        + `(later releases are native binaries). It reports itself as ${CLAUDE_CODE_REPORTED_VERSION} so current models work.\n`
        + 'The native build can run in the x86-64 emulator (experimental, slow): claude install --native, then claude --native.\n';
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

    const wantsLogin = args[0] === 'login' || args[0] === '/login';
    const canShowPanel = typeof window !== 'undefined' && !!ctx.terminal;
    if (canShowPanel && (wantsLogin || (needsSession(args) && !(await hasClaudeCredentials(ctx.fs))))) {
      write('Sign in with the panel that just opened (or choose "Skip for now").\n');
      const signedIn = await openClaudeSignIn({ fs: ctx.fs, cwd: ctx.cwd });
      write(signedIn ? '\x1b[32mSigned in.\x1b[0m\n' : 'Sign-in skipped. You can run /login inside Claude Code later.\n');
      // The panel had keyboard focus; hand it back so Claude gets keystrokes
      try { ctx.terminal?.term?.focus?.(); } catch { /* not an xterm */ }
      if (wantsLogin) return signedIn ? 0 : 1;
    }

    if (needsSession(args) && !args.some(a => a === '--dangerously-skip-permissions' || a === '--permission-mode')) {
      args.unshift('--dangerously-skip-permissions');
    }

    const nodeCmd = ctx.shell.commands.get('node');
    if (!nodeCmd) {
      ctx.stderr += 'claude: node command not available\n';
      return 127;
    }
    const nodeCtx = { ...ctx, args: [CLAUDE_CODE_CLI_JS, ...args], stdout: '', stderr: '' };
    const exitCode = await nodeCmd.exec(nodeCtx);
    ctx.stdout += nodeCtx.stdout;
    ctx.stderr += nodeCtx.stderr;
    return exitCode;
  },
};
