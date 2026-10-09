import type { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';

/**
 * Unicode 11 character widths, as programs compute them (musl's and glibc's
 * wcwidth, vim, ncurses): emoji take two cells. xterm.js defaults to Unicode
 * 6, where most emoji take one, so a full-screen program's cursor ends up
 * one cell off for every emoji on the line. Needs `allowProposedApi`.
 */
export function useUnicode11(term: Terminal): void {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
}
