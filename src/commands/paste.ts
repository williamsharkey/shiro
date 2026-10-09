import type { Command } from './index';
import { splitLines } from './flags';

/** -d LIST: \n \t \\ \b \f \r \v escapes, `\0` is an empty delimiter */
function parseDelims(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) { out.push(s[i]); continue; }
    const c = s[++i];
    const map: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', b: '\b', f: '\f', r: '\r', v: '\v', '0': '' };
    out.push(c in map ? map[c] : c);
  }
  return out;
}

/**
 * paste, as GNU coreutils: `-` operands share stdin (each takes the next
 * line), -d delimiters cycle and restart on each output line, -s, -z.
 */
export const paste: Command = {
  name: "paste",
  description: "Merge lines of files",
  async exec(ctx) {
    let delimSpec = '\t';
    let serial = false;
    let zero = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        if (a === '--serial') serial = true;
        else if (a === '--zero-terminated') zero = true;
        else if (a === '--delimiters' || a.startsWith('--delimiters=')) delimSpec = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[++i] ?? '');
        else { ctx.stderr += `paste: unrecognized option '${a}'\nTry 'paste --help' for more information.\n`; return 1; }
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (ch === 's') serial = true;
          else if (ch === 'z') zero = true;
          else if (ch === 'd') {
            const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            if (v === undefined) { ctx.stderr += "paste: option requires an argument -- 'd'\nTry 'paste --help' for more information.\n"; return 1; }
            delimSpec = v;
            break;
          } else { ctx.stderr += `paste: invalid option -- '${ch}'\nTry 'paste --help' for more information.\n`; return 1; }
        }
        continue;
      }
      files.push(a);
    }
    if (!files.length) files.push('-');
    const delims = parseDelims(delimSpec);
    if (!delims.length) delims.push('');
    const eol = zero ? '\0' : '\n';

    // Each operand's lines; every `-` reads from one shared stdin cursor
    const stdinLines = splitLines(ctx.stdin, eol);
    const stdinCursor = { pos: 0 };
    type Src = { lines: string[]; cursor: { pos: number } };
    const srcs: Src[] = [];
    for (const f of files) {
      if (f === '-') { srcs.push({ lines: stdinLines, cursor: stdinCursor }); continue; }
      try {
        const text = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string;
        srcs.push({ lines: splitLines(text, eol), cursor: { pos: 0 } });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.stderr += `paste: ${f}: ${/EISDIR/.test(msg) ? 'Is a directory' : 'No such file or directory'}\n`;
        return 1;
      }
    }

    let out = '';
    if (serial) {
      const done = new Set<{ pos: number }>();
      for (const s of srcs) {
        // A second `-` in serial mode finds stdin already consumed
        const lines = done.has(s.cursor) ? [] : s.lines;
        done.add(s.cursor);
        let line = '';
        lines.forEach((l, k) => {
          if (k > 0) line += delims[(k - 1) % delims.length];
          line += l;
        });
        out += line + eol;
      }
    } else {
      for (;;) {
        let any = false;
        let line = '';
        let pendingDelims = '';
        srcs.forEach((s, k) => {
          if (s.cursor.pos < s.lines.length) {
            any = true;
            line += pendingDelims + s.lines[s.cursor.pos++];
            pendingDelims = '';
          }
          if (k < srcs.length - 1) pendingDelims += delims[k % delims.length];
        });
        if (!any) break;
        out += line + pendingDelims + eol;
      }
    }
    ctx.stdout += out;
    return 0;
  },
};
