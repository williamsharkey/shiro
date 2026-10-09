import type { Command } from './index';
import { capturingStdout, quoteArgsForShell } from '../shell';

/**
 * sudo [-u USER] [-E] [-H] [-i|-s] [--] COMMAND [ARG]...
 *
 * Runs COMMAND with user id 0: kernel processes it starts (Debian's apt,
 * dpkg, ...) see getuid() == 0. There is one person at the keyboard and no
 * password; the browser tab is the security boundary. `-u user` (or the
 * user's uid) runs as the normal user.
 */
export const sudoCmd: Command = {
  name: 'sudo',
  description: 'Run a command as root',
  async exec(ctx) {
    let target = 'root';
    let preserveEnv = false;
    let login = false;
    let shellMode = false;
    let i = 0;
    for (; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--') { i++; break; }
      if (!a.startsWith('-') || a === '-') break;
      if (a === '-u' || a === '--user') { target = ctx.args[++i] ?? ''; continue; }
      if (a.startsWith('--user=')) { target = a.slice(7); continue; }
      if (a === '-E' || a.startsWith('--preserve-env')) { preserveEnv = true; continue; }
      if (a === '-i' || a === '--login') { login = true; continue; }
      if (a === '-s' || a === '--shell') { shellMode = true; continue; }
      if (a === '-v' || a === '--validate' || a === '-k' || a === '-K' || a === '--reset-timestamp' || a === '--remove-timestamp') {
        if (i === ctx.args.length - 1) return 0;
        continue;
      }
      if (a === '-l' || a === '--list') {
        ctx.stdout += `User ${ctx.env.USER || 'user'} may run the following commands on ${ctx.env.HOSTNAME || 'shiro'}:\n    (ALL : ALL) NOPASSWD: ALL\n`;
        return 0;
      }
      if (a === '-h' || a === '--help') {
        ctx.stdout += 'usage: sudo [-u user] [-E] [-H] [-i|-s] [--] command [arg ...]\n';
        return 0;
      }
      if (a === '-V' || a === '--version') { ctx.stdout += 'Sudo version 1.9 (Shiro)\n'; return 0; }
      if (/^-[nHSbAP]+$/.test(a)) continue; // non-interactive, set-home, stdin password, ...
      if (a === '-g' || a === '-C' || a === '-p' || a === '-r' || a === '-t' || a === '-D' || a === '-h') { i++; continue; }
      ctx.stderr += `sudo: invalid option -- '${a.replace(/^-+/, '')}'\n`;
      return 1;
    }
    const uid = target === 'root' || target === '#0' || target === '0' ? 0
      : target === (ctx.env.USER || 'user') || target === '#1000' || target === '1000' ? 1000 : -1;
    if (uid < 0) {
      ctx.stderr += `sudo: unknown user ${target}\n`;
      return 1;
    }
    let command = ctx.args.slice(i);
    if (!command.length) {
      if (!login && !shellMode) {
        ctx.stderr += 'usage: sudo [-u user] [-E] [-H] [-i|-s] [--] command [arg ...]\n';
        return 1;
      }
      command = [ctx.env.SHELL || 'bash'];
    } else if (login || shellMode) {
      command = ['sh', '-c', quoteArgsForShell(command)];
    }

    const toTerm = !!ctx.terminal && ctx.stdoutIsTTY !== false;
    const child = ctx.shell.fork();
    // Piped or redirected (`sudo apt-get update | tail -1`): programs keep the
    // tty for input but their stdout comes back here, as in $(...)
    if (ctx.terminal) child.setTerminal((toTerm ? ctx.terminal : capturingStdout(ctx.terminal)) as any);
    child.cwd = ctx.cwd;
    child.uid = uid;
    const me = ctx.env.USER || 'user';
    const env = preserveEnv ? { ...child.env } : { ...child.env };
    if (uid === 0) {
      Object.assign(env, { USER: 'root', LOGNAME: 'root', HOME: '/root', SUDO_USER: me, SUDO_UID: '1000', SUDO_GID: '1000', SUDO_COMMAND: command.join(' ') });
      if (preserveEnv) env.HOME = child.env.HOME ?? '/root';
      // sudo's secure_path: the sbin directories come first
      if (!preserveEnv) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' + (child.env.PATH ? ':' + child.env.PATH : '');
      if (login) child.cwd = '/root';
    }
    child.env = env;
    const out = (s: string) => { if (toTerm) (ctx.terminal as any).writeOutput(s); else ctx.stdout += s.replace(/\r\n/g, '\n'); };
    const err = (s: string) => { if (toTerm) (ctx.terminal as any).writeOutput(s); else ctx.stderr += s.replace(/\r\n/g, '\n'); };
    return child.executeWithStdin(quoteArgsForShell(command), ctx.stdin || '', ctx.streamStdout ?? out, ctx.streamStderr ?? err);
  },
};
