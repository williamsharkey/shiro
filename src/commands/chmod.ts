import type { Command } from './index';

/**
 * chmod, as GNU coreutils: octal modes (a directory keeps its set-user-ID
 * and set-group-ID bits unless the mode has 5+ digits), symbolic modes
 * parsed like gnulib's mode_compile/mode_adjust (who [ugoa], ops + - =,
 * perms rwxXst or a copy of u/g/o, several ops per clause, comma lists;
 * no who means "a" masked by the umask, with GNU's "new permissions are"
 * warning), --reference, -R (symlinks found while recursing are skipped),
 * -v/-c/-f.
 */

const SUID = 0o4000, SGID = 0o2000, SVTX = 0o1000;
const RWXU = 0o700, RWXG = 0o070, RWXO = 0o007;
const ALL_R = 0o444, ALL_W = 0o222, ALL_X = 0o111;
const MODE_BITS = 0o7777;
/** Shiro has no per-process umask yet; the shell's `umask` reports 0022 */
const UMASK = 0o022;

interface Change {
  op: '+' | '-' | '=';
  flag: 'ordinary' | 'copy' | 'xIfAnyX';
  affected: number;
  value: number;
  mentioned: number;
}

type ModeSpec = { octal: true; value: number; digits: number } | { octal: false; changes: Change[] };

/** Compile a MODE operand; null if it is invalid */
export function compileMode(s: string): ModeSpec | null {
  if (/^[0-7]+$/.test(s)) {
    const v = parseInt(s, 8);
    if (v > MODE_BITS) return null;
    return { octal: true, value: v, digits: s.length };
  }
  const changes: Change[] = [];
  let i = 0;
  for (;;) {
    let affected = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === 'u') affected |= SUID | RWXU;
      else if (c === 'g') affected |= SGID | RWXG;
      else if (c === 'o') affected |= SVTX | RWXO;
      else if (c === 'a') affected |= MODE_BITS;
      else break;
    }
    if (i >= s.length || !'+-='.includes(s[i])) return null;
    do {
      const op = s[i++] as Change['op'];
      let value = 0;
      let flag: Change['flag'] = 'copy';
      const c = s[i];
      if (c === 'u') { value = SUID | RWXU; i++; }
      else if (c === 'g') { value = SGID | RWXG; i++; }
      else if (c === 'o') { value = SVTX | RWXO; i++; }
      else {
        flag = 'ordinary';
        for (; i < s.length; i++) {
          const p = s[i];
          if (p === 'r') value |= ALL_R;
          else if (p === 'w') value |= ALL_W;
          else if (p === 'x') value |= ALL_X;
          else if (p === 'X') flag = 'xIfAnyX';
          else if (p === 's') value |= SUID | SGID;
          else if (p === 't') value |= SVTX;
          else break;
        }
      }
      changes.push({ op, flag, affected, value, mentioned: affected ? affected & value : value });
    } while (i < s.length && '+-='.includes(s[i]));
    if (i >= s.length) return { octal: false, changes };
    if (s[i] !== ',') return null;
    i++;
  }
}

/** gnulib mode_adjust: the new permission bits */
export function adjustMode(oldMode: number, dir: boolean, umask: number, spec: ModeSpec): number {
  if (spec.octal) {
    // A directory keeps set-ID bits unless 5+ digits say otherwise
    return dir && spec.digits < 5 ? spec.value | (oldMode & (SUID | SGID)) : spec.value;
  }
  let mode = oldMode & MODE_BITS;
  for (const ch of spec.changes) {
    const omit = (dir ? SUID | SGID : 0) & ~ch.mentioned;
    let value = ch.value;
    if (ch.flag === 'copy') {
      value &= mode;
      value |= (value & ALL_R ? ALL_R : 0) | (value & ALL_W ? ALL_W : 0) | (value & ALL_X ? ALL_X : 0);
    } else if (ch.flag === 'xIfAnyX') {
      if ((mode & ALL_X) || dir) value |= ALL_X;
    }
    value &= (ch.affected ? ch.affected : ~umask) & ~omit;
    if (ch.op === '=') {
      const preserved = (ch.affected ? ~ch.affected : 0) | omit;
      mode = (mode & preserved) | value;
    } else if (ch.op === '+') mode |= value;
    else mode &= ~value;
  }
  return mode & MODE_BITS;
}

/** `ls -l` style permission string (without the type letter) */
function permString(m: number): string {
  const t = (bit: number, c: string) => (m & bit ? c : '-');
  const x = (xb: number, sb: number, s: string) => (m & sb ? (m & xb ? s : s.toUpperCase()) : (m & xb ? 'x' : '-'));
  return t(0o400, 'r') + t(0o200, 'w') + x(0o100, SUID, 's')
    + t(0o040, 'r') + t(0o020, 'w') + x(0o010, SGID, 's')
    + t(0o004, 'r') + t(0o002, 'w') + x(0o001, SVTX, 't');
}
const octal4 = (m: number) => (m & MODE_BITS).toString(8).padStart(4, '0');

const MODE_ARG = /^[-+=ugoarwxXst0-7,]+$/;

export const chmod: Command = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(ctx) {
    const args = ctx.args;
    const usage = (msg: string) => { ctx.stderr += `chmod: ${msg}\nTry 'chmod --help' for more information.\n`; return 1; };
    let recursive = false, verbose = false, changesOnly = false, quiet = false;
    let reference: string | null = null;
    let modeStr: string | null = null;
    const targets: string[] = [];
    let opts = true;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (opts && a === '--') { opts = false; continue; }
      if (opts && a.startsWith('--') && a.length > 2) {
        const [name, val] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
        if (name === '--recursive') recursive = true;
        else if (name === '--verbose') verbose = true;
        else if (name === '--changes') changesOnly = true;
        else if (name === '--silent' || name === '--quiet') quiet = true;
        else if (name === '--preserve-root' || name === '--no-preserve-root') { /* nothing to protect */ }
        else if (name === '--reference') {
          const v = val ?? args[++i];
          if (v === undefined) return usage("option '--reference' requires an argument");
          reference = v;
        } else return usage(`unrecognized option '${a}'`);
        continue;
      }
      if (opts && a.startsWith('-') && a.length > 1) {
        // A mode like -w or -rwx,g+s: GNU's getopt treats those letters as mode text
        if (modeStr === null && reference === null && compileMode(a) && MODE_ARG.test(a) && !/^-[RcfvHLP]+$/.test(a)) {
          modeStr = a;
          continue;
        }
        let ok = true;
        for (const f of a.slice(1)) {
          if (f === 'R') recursive = true;
          else if (f === 'v') verbose = true;
          else if (f === 'c') changesOnly = true;
          else if (f === 'f') quiet = true;
          else if (f === 'H' || f === 'L' || f === 'P') { /* traversal flags: symlinks are never followed while recursing */ }
          else { ok = false; break; }
        }
        if (!ok) {
          if (modeStr === null && reference === null && MODE_ARG.test(a)) { modeStr = a; continue; }
          return usage(`invalid option -- '${a.slice(1).split('').find((f) => !'RvcfHLP'.includes(f))}'`);
        }
        continue;
      }
      if (modeStr === null && reference === null) modeStr = a;
      else targets.push(a);
    }

    if (modeStr === null && reference === null) return usage('missing operand');
    if (targets.length === 0) return usage(modeStr === null ? 'missing operand' : `missing operand after '${modeStr}'`);

    let spec: ModeSpec | null = null;
    if (reference !== null) {
      try {
        const st = await ctx.fs.stat(ctx.fs.resolvePath(reference, ctx.cwd));
        spec = { octal: true, value: st.mode & MODE_BITS, digits: 5 };
      } catch {
        ctx.stderr += `chmod: failed to get attributes of '${reference}': No such file or directory\n`;
        return 1;
      }
    } else {
      spec = compileMode(modeStr!);
      if (!spec) return usage(`invalid mode: '${modeStr}'`);
    }
    const umaskDependent = !spec.octal && spec.changes.some((c) => c.affected === 0);

    let status = 0;
    const doOne = async (name: string, path: string, operand: boolean): Promise<void> => {
      let st;
      try {
        st = operand ? await ctx.fs.stat(path) : await ctx.fs.lstat(path);
      } catch {
        if (!quiet) ctx.stderr += `chmod: cannot access '${name}': No such file or directory\n`;
        if (verbose) ctx.stdout += `'${name}' could not be accessed\n`;
        status = 1;
        return;
      }
      // Symlinks met while recursing are neither changed nor followed
      if (st.isSymbolicLink()) {
        if (verbose) ctx.stdout += `neither symbolic link '${name}' nor referent has been changed\n`;
        return;
      }
      let real = path;
      try { real = operand ? await ctx.fs.realpath(path) : path; } catch { /* keep path */ }
      const dir = st.isDirectory();
      const oldMode = st.mode & MODE_BITS;
      const newMode = adjustMode(oldMode, dir, UMASK, spec!);
      if (newMode !== oldMode) {
        try {
          await ctx.fs.chmod(real, (st.mode & ~MODE_BITS) | newMode);
        } catch (e) {
          if (!quiet) ctx.stderr += `chmod: changing permissions of '${name}': ${e instanceof Error ? e.message : e}\n`;
          status = 1;
          return;
        }
      }
      if (verbose || (changesOnly && newMode !== oldMode)) {
        ctx.stdout += newMode !== oldMode
          ? `mode of '${name}' changed from ${octal4(oldMode)} (${permString(oldMode)}) to ${octal4(newMode)} (${permString(newMode)})\n`
          : `mode of '${name}' retained as ${octal4(newMode)} (${permString(newMode)})\n`;
      }
      if (umaskDependent) {
        const naive = adjustMode(oldMode, dir, 0, spec!);
        if (newMode & ~naive & MODE_BITS) {
          ctx.stderr += `chmod: ${name}: new permissions are ${permString(newMode)}, not ${permString(naive)}\n`;
          status = 1;
        }
      }
      if (recursive && dir) {
        let entries: string[] = [];
        try { entries = await ctx.fs.readdir(real); } catch { return; }
        for (const e of entries.sort()) {
          await doOne(name.endsWith('/') ? name + e : `${name}/${e}`, `${real === '/' ? '' : real}/${e}`, false);
        }
      }
    };

    for (const t of targets) await doOne(t, ctx.fs.resolvePath(t, ctx.cwd), true);
    return status;
  },
};
