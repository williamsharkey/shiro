/**
 * The command line of `sh`/`bash`, parsed as bash does, for every way a
 * shell starts: the page's `sh` builtin, and a kernel exec of /bin/sh or
 * /bin/bash (a program's execve, Blink, node child_process).
 *
 *   bash [long options] [-abefhkmnptuvxBCHP] [-o option] [-O shopt] [-c string | -i | -s] [arguments]
 *
 * Options may come before or after -c (`sh -c -l 'cmd'`, Claude Code's
 * form, and `bash -l -c 'cmd' a b`); option processing stops at the first
 * argument that isn't one, at `--` or at `-`. With -c that argument is the
 * command string, the next is $0 and the rest $1…; without, it is the
 * script file (and $0).
 */

/** Single-letter options that are `set -o` names */
const SET_LETTERS: Record<string, string> = {
  a: 'allexport', b: 'notify', e: 'errexit', f: 'noglob', h: 'hashall', k: 'keyword', m: 'monitor',
  n: 'noexec', p: 'privileged', t: 'onecmd', u: 'nounset', v: 'verbose', x: 'xtrace',
  B: 'braceexpand', C: 'noclobber', E: 'errtrace', H: 'histexpand', P: 'physical', T: 'functrace',
};

/** Long options bash accepts (those taking a value are in LONG_WITH_ARG) */
const LONG = new Set(['login', 'norc', 'noprofile', 'posix', 'noediting', 'restricted', 'verbose', 'debugger', 'dump-strings', 'dump-po-strings', 'pretty-print', 'protected']);
const LONG_WITH_ARG = new Set(['rcfile', 'init-file']);

export interface ShellArgs {
  /** -c: the command string is `rest[0]` */
  command: boolean;
  /** -i */
  interactive: boolean;
  /** -l / --login */
  login: boolean;
  /** -s: commands from stdin even with arguments */
  stdin: boolean;
  /** `set -o` names to turn on (-e, -o pipefail, ...) and off (+e, +o name) */
  on: string[];
  off: string[];
  /** shopt names: [name, on] (-O name / +O name) */
  shopts: [string, boolean][];
  /** --posix */
  posix: boolean;
  /** The arguments after the options: the command string (-c) or script, then $0/$1… */
  rest: string[];
  /** An unknown option: bash prints this and exits 2 */
  error?: string;
}

export function parseShellArgs(args: string[]): ShellArgs {
  const r: ShellArgs = { command: false, interactive: false, login: false, stdin: false, on: [], off: [], shopts: [], posix: false, rest: [] };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-') { i++; break; }
    if (a.startsWith('--') && a.length > 2) {
      const name = a.slice(2);
      if (name === 'login') r.login = true;
      else if (name === 'posix') r.posix = true;
      else if (name === 'verbose') r.on.push('verbose');
      else if (LONG_WITH_ARG.has(name)) i++;
      else if (!LONG.has(name) && name !== 'version' && name !== 'help') { r.error = `${a}: invalid option`; return r; }
      continue;
    }
    if (a === '-o' || a === '+o') {
      const name = args[i + 1];
      if (name !== undefined) (a === '-o' ? r.on : r.off).push(name);
      i++;
      continue;
    }
    if (a === '-O' || a === '+O') {
      const name = args[i + 1];
      if (name !== undefined) r.shopts.push([name, a === '-O']);
      i++;
      continue;
    }
    if (!/^[-+][A-Za-z]+$/.test(a)) break; // the command string, script or first argument
    const on = a[0] === '-';
    for (const ch of a.slice(1)) {
      if (ch === 'c') r.command = true;
      else if (ch === 'i') r.interactive = on;
      else if (ch === 'l') r.login = on;
      else if (ch === 's') r.stdin = on;
      else if (ch === 'r' || ch === 'D') { /* restricted; dump strings: accepted */ }
      else if (SET_LETTERS[ch]) (on ? r.on : r.off).push(SET_LETTERS[ch]);
      else { r.error = `${on ? '-' : '+'}${ch}: invalid option`; return r; }
    }
  }
  r.rest = args.slice(i);
  return r;
}
