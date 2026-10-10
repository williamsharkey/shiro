/**
 * What the built-in git (isomorphic-git) does itself, and the real git
 * (`pkg install git`, git 2.56 in Blink) for the rest.
 *
 * Each subcommand the built-in has lists the options it understands. A
 * command line with anything else (an option it doesn't know, a subcommand
 * it doesn't have) runs the real git instead, installed on first use; where
 * that can't be had (no x86 engine, offline), the built-in says what it
 * didn't understand, as git does, instead of ignoring it. Combined short
 * options (`-qb NAME`, `-qam MSG`) are split first.
 */
import type { CommandContext } from './index';

interface Spec {
  /** short options without a value */
  flags?: string;
  /** short options that take a value (`-m MSG`, `-mMSG`) */
  values?: string;
  /** short options with an optional value attached (`-M`, `-M50%`, `-uno`) */
  optional?: string;
  /** `-5` (a count) */
  numeric?: boolean;
  /** long options: `name`, `name=` (a value, attached or next), `name?` (optionally `=value`) */
  long?: string;
  /** anything goes (rev-parse, config: their own parsers) */
  any?: boolean;
  /** the first argument is a subcommand of these */
  subcommands?: string[];
}

const DIFF = 'cached staged name-only name-status numstat stat? shortstat raw patch-with-stat patch quiet exit-code no-ext-diff ext-diff '
  + 'color? no-color submodule? unified= find-renames? find-copies? no-renames word-diff? textconv no-textconv encoding= '
  + 'diff-filter= ignore-submodules? relative? minimal full-index abbrev? binary root no-prefix src-prefix= dst-prefix= '
  + 'patience histogram indent-heuristic no-indent-heuristic';
const LOG = 'oneline format= pretty? abbrev-commit no-abbrev-commit decorate? no-decorate parents all branches? tags? remotes? '
  + 'reverse no-merges merges first-parent no-walk? author= grep= date= walk-reflogs graph topo-order date-order '
  + 'show-notes? no-notes no-show-signature max-count= skip= follow no-patch null ' + DIFF;

export const SPECS: Record<string, Spec> = {
  init: { flags: 'q', values: 'b', long: 'quiet initial-branch=' },
  clone: { flags: 'q', values: 'bo', long: 'depth= branch= single-branch no-single-branch no-tags quiet progress origin=' },
  config: { any: true },
  add: { flags: 'uAfv', long: 'update all force verbose' },
  commit: { flags: 'qan', values: 'mF', long: 'message= file= amend allow-empty all quiet no-verify no-edit no-gpg-sign' },
  status: { flags: 'sbz', optional: 'u', long: 'porcelain? short branch untracked-files? find-renames? no-renames ahead-behind no-ahead-behind long null' },
  log: { flags: 'gpsuz', values: 'n', optional: 'MC', numeric: true, long: LOG },
  show: { flags: 'gpsuz', values: 'n', optional: 'MC', numeric: true, long: LOG },
  diff: { flags: 'pusz', values: 'U', optional: 'MCB', long: DIFF },
  'diff-files': { flags: 'pusqz', values: 'U', optional: 'MCB', long: DIFF },
  'diff-index': { flags: 'pusqz', values: 'U', optional: 'MCB', long: DIFF },
  branch: { flags: 'avrdDlq', long: 'all remotes verbose format= show-current list delete quiet sort= color? no-color' },
  checkout: { flags: 'qft', values: 'bB', long: 'quiet force track? no-track recurse-submodules no-recurse-submodules progress no-progress detach' },
  switch: { flags: 'qft', values: 'cC', long: 'quiet force track? no-track progress no-progress detach' },
  remote: { flags: 'v', long: 'verbose', subcommands: ['add', 'remove', 'rm', 'set-url'] },
  push: { flags: 'uqf', long: 'set-upstream quiet force progress' },
  fetch: { flags: 'qptv', long: 'all quiet prune tags no-tags no-write-fetch-head progress verbose' },
  pull: { flags: 'q', long: 'quiet no-rebase ff progress' },
  merge: { flags: 'q', values: 'm', long: 'no-ff ff ff-only message= quiet no-edit stat no-stat verbose progress' },
  stash: { flags: 'qzu', values: 'm', long: 'quiet message= include-untracked pretty= format= oneline', subcommands: ['push', 'save', 'pop', 'apply', 'list', 'drop', 'clear'] },
  reset: { flags: 'q', long: 'soft mixed hard quiet' },
  tag: { flags: 'dal', values: 'm', optional: 'n', long: 'delete annotate list sort=' },
  'cherry-pick': {},
  revert: { long: 'no-edit' },
  rebase: { flags: 'q', long: 'quiet' },
  reflog: {},
  'rev-parse': { any: true },
  'symbolic-ref': { flags: 'qd', long: 'short quiet delete no-recurse recurse' },
  'show-ref': { flags: 'dsq', long: 'heads tags head dereference hash? verify quiet abbrev? exists' },
  'for-each-ref': { long: 'format= sort= count= points-at= shell perl python tcl ignore-case' },
  'cat-file': { flags: 'tspe', long: 'batch? batch-check? textconv filters' },
  'ls-files': { flags: 'zmodsc', long: 'cached modified others deleted stage exclude-standard full-name' },
  'ls-remote': { flags: 'htq', long: 'heads tags branches refs quiet' },
  worktree: { flags: 'vz', long: 'porcelain verbose', subcommands: ['list'] },
  'merge-base': { flags: 'a', long: 'is-ancestor all' },
  'rev-list': { values: 'n', numeric: true, long: 'count left-right parents all branches? tags? reverse max-count= skip= no-merges merges first-parent topo-order date-order' },
  'update-index': { flags: 'qz', long: 'add remove force-remove stdin refresh really-refresh unmerged ignore-missing' },
};

/** Subcommands where the built-in's version loses work (replays whole files): the real git first, the built-in only without it */
export const PREFER_REAL = new Set(['rebase', 'cherry-pick', 'revert']);

function longSpec(spec: Spec): Map<string, '' | '=' | '?'> {
  const m = new Map<string, '' | '=' | '?'>();
  for (const t of (spec.long ?? '').split(/\s+/).filter(Boolean)) {
    const k = t.replace(/[=?]$/, '');
    m.set(k, t.endsWith('=') ? '=' : t.endsWith('?') ? '?' : '');
  }
  return m;
}

/** `-qb feat` → `-q -b feat`, `-qam msg` → `-q -a -m msg`, `-mmsg` → `-m msg` (options of SUB; after `--`, nothing) */
export function splitShortOptions(sub: string, args: string[]): string[] {
  const spec = SPECS[sub];
  if (!spec || spec.any) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.push(...args.slice(i)); break; }
    // (-vv is its own option for branch)
    if (!/^-[a-zA-Z]{2,}/.test(a) || a === '-vv' || (spec.numeric && /^-n\d+$/.test(a))) { out.push(a); continue; }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if ((spec.optional ?? '').includes(c)) { out.push('-' + a.slice(j)); break; } // -uno
      if ((spec.values ?? '').includes(c)) {
        out.push('-' + c);
        if (j + 1 < a.length) out.push(a.slice(j + 1));
        else if (i + 1 < args.length) out.push(args[++i]);
        break;
      }
      out.push('-' + c);
    }
  }
  return out;
}

/** The first option of `args` (after SUB) the built-in doesn't know, or a subcommand it lacks; null if all is known */
export function unknownOption(sub: string, args: string[]): string | null {
  const spec = SPECS[sub];
  if (!spec) return sub;
  if (spec.any) return null;
  if (sub === 'worktree' && args[0] !== 'list') return `worktree ${args[0] ?? ''}`.trim();
  if (spec.subcommands && args[0] && !args[0].startsWith('-') && !spec.subcommands.includes(args[0])) {
    if (sub === 'remote' || sub === 'stash') return `${sub} ${args[0]}`;
  }
  const longs = longSpec(spec);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a === '-' || !a.startsWith('-')) continue;
    if (a === '-h' || a === '--help') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq < 0 ? undefined : eq);
      const kind = longs.get(name);
      if (kind === undefined) return a;
      if (kind === '' && eq >= 0) return a;
      if (kind === '=' && eq < 0) i++;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(a)) continue;
    if (a === '-vv' && sub === 'branch') continue;
    const c = a[1];
    if ((spec.values ?? '').includes(c)) { if (a.length === 2) i++; continue; }
    if ((spec.optional ?? '').includes(c)) continue;
    if ((spec.flags ?? '').includes(c) && a.length === 2) continue;
    return a;
  }
  return null;
}

/**
 * Run the real git on the original command line (global options and all),
 * installing it first if need be. null when it can't be had here.
 */
export async function realGit(ctx: CommandContext, argv: string[], cwd: string): Promise<number | null> {
  const shell = ctx.shell;
  if (!shell) return null;
  const { quoteArgsForShell } = await import('../shell');
  const out = (s: string) => { ctx.stdout += s.replace(/\r\n/g, '\n'); };
  const err = (s: string) => { ctx.stderr += s.replace(/\r\n/g, '\n'); };
  if (!(await ctx.fs.exists('/usr/bin/git'))) {
    let quiet = '';
    const code = await shell.execute('pkg install git', () => {}, (s) => { quiet += s; });
    if (code !== 0 || !(await ctx.fs.exists('/usr/bin/git'))) return null;
    err('(git: installed the full git for this; `pkg remove git` goes back to the built-in)\n');
  }
  return shell.execute(`( cd ${quoteArgsForShell([cwd])} && /usr/bin/git ${quoteArgsForShell(argv)} )`, out, err);
}
