import type { Command } from './index';
import { quoteArgsForShell } from '../shell';

// Patterns that indicate a sensitive env var (case-insensitive match on key)
const SECRET_PATTERNS = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|GITHUB_TOKEN)$/i;

/** A shell variable name, as opposed to the shell's own specials ($?, $#, $1, __PIPE_STDIN) */
const isVarName = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !k.startsWith('__');

/** -S STRING: words split on blanks, with '…', "…" and \ as GNU env reads them */
function splitString(s: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t') { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur ??= '';
    if (c === "'") { const e = s.indexOf("'", i + 1); cur += s.slice(i + 1, e < 0 ? s.length : e); i = e < 0 ? s.length : e; continue; }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\' && i + 1 < s.length) i++; cur += s[i++]; }
      continue;
    }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
    cur += c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * env [-i] [-u NAME]... [-C DIR] [-0] [-S STRING] [--] [NAME=VALUE]... [COMMAND [ARG]...]
 * Runs COMMAND (a program: not a shell function) with the environment changed,
 * or prints the environment. -i starts from an empty one.
 */
export const env: Command = {
  name: "env",
  description: "Run a program in a modified environment, or print the environment",
  async exec(ctx) {
    const args = [...ctx.args];
    let ignore = false;
    let nul = false;
    let chdir: string | undefined;
    const unset: string[] = [];
    const bad = (msg: string) => { ctx.stderr += `env: ${msg}\nTry 'env --help' for more information.\n`; return 125; };
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (a === '-') { ignore = true; continue; }
      if (!a.startsWith('-') || a.length === 1) break;
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        const val = () => (eq < 0 ? args[++i] : a.slice(eq + 1));
        if (name === 'ignore-environment') ignore = true;
        else if (name === 'null') nul = true;
        else if (name === 'unset') { const v = val(); if (v === undefined) return bad("option '--unset' requires an argument"); unset.push(v); }
        else if (name === 'chdir') { const v = val(); if (v === undefined) return bad("option '--chdir' requires an argument"); chdir = v; }
        else if (name === 'split-string') { const v = val(); if (v === undefined) return bad("option '--split-string' requires an argument"); args.splice(i + 1, 0, ...splitString(v)); }
        else if (name === 'help') { ctx.stdout += 'Usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]\n'; return 0; }
        else if (name === 'version') { ctx.stdout += 'env (GNU coreutils) 9.1\n'; return 0; }
        else return bad(`unrecognized option '${a}'`);
        continue;
      }
      // bundled short options; one taking a value takes the rest of the word or the next one
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (f === 'i') ignore = true;
        else if (f === '0') nul = true;
        else if (f === 'u' || f === 'C' || f === 'S') {
          const v = a.slice(j + 1) || args[++i];
          if (v === undefined) return bad(`option requires an argument -- '${f}'`);
          if (f === 'u') unset.push(v);
          else if (f === 'C') chdir = v;
          else args.splice(i + 1, 0, ...splitString(v));
          break;
        } else if (f === 'v') { /* --debug: nothing to show */ }
        else return bad(`invalid option -- '${f}'`);
      }
    }
    const assignments: [string, string][] = [];
    for (; i < args.length && /^[^=]+=/.test(args[i]); i++) {
      const eq = args[i].indexOf('=');
      assignments.push([args[i].slice(0, eq), args[i].slice(eq + 1)]);
    }
    const command = args.slice(i);
    for (const u of unset) if (!u || u.includes('=')) { ctx.stderr += `env: cannot unset '${u}': Invalid argument\n`; return 125; }
    if (nul && command.length) return bad('cannot specify --null (-0) with command');
    if (chdir !== undefined && !command.length) return bad('must specify command with --chdir (-C)');

    // The environment the command gets: a child shell's, changed as asked
    const child = ctx.shell.fork();
    const childEnv = child.env;
    if (ignore) {
      for (const k of Object.keys(childEnv)) if (isVarName(k)) delete childEnv[k];
    }
    for (const u of unset) delete childEnv[u];
    for (const [k, v] of assignments) { childEnv[k] = v; child.localVars.delete(k); }
    child.cwd = ctx.cwd;

    if (!command.length) {
      const exported = child.exportedEnv();
      // (LINENO and _ are the shell's bookkeeping, not environment: bash doesn't export LINENO)
      const entries = Object.entries(exported).filter(([k]) => isVarName(k) && k !== 'LINENO' && k !== '_');
      const lines = entries.map(([k, v]) => {
        if (SECRET_PATTERNS.test(k) && v && v.length >= 8) return `${k}=${v.slice(0, 4)}${'*'.repeat(Math.min(v.length - 4, 20))}`;
        return `${k}=${v}`;
      }).sort();
      ctx.stdout += nul ? lines.map((l) => l + '\0').join('') : lines.map((l) => l + '\n').join('');
      return 0;
    }

    if (chdir !== undefined) {
      const dir = ctx.fs.resolvePath(chdir, ctx.cwd);
      const st = await ctx.fs.stat(dir).catch(() => null);
      if (!st || !st.isDirectory()) {
        ctx.stderr += `env: cannot change directory to '${chdir}': ${st ? 'Not a directory' : 'No such file or directory'}\n`;
        return 125;
      }
      child.cwd = dir;
    }
    // A program finds others on PATH even when -i removed it (GNU's execvp
    // searches a default path): the shell looks there but doesn't export it
    if (childEnv['PATH'] === undefined) {
      childEnv['PATH'] = '/usr/local/bin:/usr/bin:/bin';
      child.localVars.add('PATH');
    }
    // env runs programs: not the caller's shell functions or aliases
    child.functions = {};
    child.aliases = new Map();
    return child.execute(quoteArgsForShell(command),
      ctx.streamStdout ?? ((s) => { ctx.stdout += s.replace(/\r\n/g, '\n'); }),
      ctx.streamStderr ?? ((s) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }),
      false, ctx.terminal, true);
  },
};
