import type { CommandContext } from './index';
import type { Pty, PtyFile } from '../kernel/pty';

/**
 * The terminal a command runs on: the page terminal's pty, or, in a shell
 * that is a kernel process (a screen/tmux window, `sh -i`), the pty on its
 * fds (`fds` in order of preference: stty uses stdin, tput stdout).
 */
export function ptyOf(ctx: CommandContext, fds: number[] = [0, 1, 2]): Pty | undefined {
  const page = ctx.terminal?.tty?.pty;
  if (page) return page;
  const proc = ctx.shell?.kernelHost?.proc;
  if (!proc) return undefined;
  for (const fd of fds) {
    const f = proc.fds.get(fd);
    if (f?.kind === 'pty') return (f as PtyFile).pty;
  }
  return undefined;
}
