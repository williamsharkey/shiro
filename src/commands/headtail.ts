import type { CommandContext } from './index';

/**
 * Shared head/tail (GNU coreutils): -n/-c counts with K/M/G suffixes,
 * head's -N (all but the last N) and tail's +N (from line/byte N),
 * -q/-v headers (`==> FILE <==`), `-` for stdin. Output is exactly the
 * selected part of the input: no newline is added.
 */
export async function headTail(ctx: CommandContext, which: 'head' | 'tail'): Promise<number> {
  let bytes = false;
  let countStr = '10';
  let headers: boolean | null = null;
  const files: string[] = [];
  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { files.push(...args.slice(i + 1)); break; }
    if (/^-\d+$/.test(a)) { countStr = a.slice(1); bytes = false; continue; }
    if (which === 'tail' && /^\+\d+$/.test(a) && files.length === 0) { countStr = a; continue; }
    const long = /^--(lines|bytes)(?:=(.*))?$/.exec(a);
    if (long) { bytes = long[1] === 'bytes'; countStr = long[2] ?? args[++i] ?? ''; continue; }
    if (a === '--quiet' || a === '--silent') { headers = false; continue; }
    if (a === '--verbose') { headers = true; continue; }
    if (a.startsWith('--follow') || a === '--retry' || a.startsWith('--sleep-interval') || a.startsWith('--pid') || a.startsWith('--max-unchanged-stats')) continue;
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (f === 'n' || f === 'c') {
          bytes = f === 'c';
          countStr = a.slice(j + 1) || args[++i] || '';
          break;
        }
        if (f === 'q') headers = false;
        else if (f === 'v') headers = true;
        else if (which === 'tail' && (f === 'f' || f === 'F' || f === 'r')) { /* no follow in a browser run */ }
        else if (which === 'tail' && f === 's') { i++; break; }
        else if (/\d/.test(f)) { countStr = a.slice(j).replace(/[^\d]+$/, ''); break; }
        else { ctx.stderr += `${which}: invalid option -- '${f}'\n`; return 1; }
      }
      continue;
    }
    files.push(a);
  }
  const m = /^([+-]?)(\d+)([a-zA-Z]*)$/.exec(countStr);
  const mult: Record<string, number> = { '': 1, b: 512, k: 1024, K: 1024, kB: 1000, KB: 1000, m: 1 << 20, M: 1 << 20, MB: 1e6, g: 1 << 30, G: 1 << 30, GB: 1e9 };
  if (!m || mult[m[3]] === undefined) {
    ctx.stderr += `${which}: invalid number of ${bytes ? 'bytes' : 'lines'}: '${countStr}'\n`;
    return 1;
  }
  const n = parseInt(m[2], 10) * mult[m[3]];
  const sign = m[1];
  if (files.length === 0) files.push('-');
  const showHeaders = headers ?? files.length > 1;

  let status = 0;
  let first = true;
  for (const f of files) {
    let text: string;
    if (f === '-') text = ctx.stdin;
    else {
      try {
        const p = ctx.fs.resolvePath(f, ctx.cwd);
        if ((await ctx.fs.stat(p)).isDirectory()) { ctx.stderr += `${which}: error reading '${f}': Is a directory\n`; status = 1; continue; }
        text = await ctx.fs.readFile(p, 'utf8') as string;
      } catch {
        ctx.stderr += `${which}: cannot open '${f}' for reading: No such file or directory\n`;
        status = 1;
        continue;
      }
    }
    if (showHeaders) {
      ctx.stdout += `${first ? '' : '\n'}==> ${f === '-' ? 'standard input' : f} <==\n`;
    }
    first = false;
    ctx.stdout += select(text, which, bytes, sign, n);
  }
  return status;
}

function select(text: string, which: 'head' | 'tail', bytes: boolean, sign: string, n: number): string {
  if (bytes) {
    if (which === 'head') return sign === '-' ? text.slice(0, Math.max(0, text.length - n)) : text.slice(0, n);
    return sign === '+' ? text.slice(Math.max(0, n - 1)) : n === 0 ? '' : text.slice(-n);
  }
  // Line boundaries: each line keeps its newline; a last line may have none
  const starts: number[] = [0];
  for (let i = text.indexOf('\n'); i >= 0 && i < text.length - 1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const count = text === '' ? 0 : starts.length;
  const from = (k: number) => (k >= count ? text.length : starts[k]);
  if (which === 'head') {
    return sign === '-' ? text.slice(0, from(Math.max(0, count - n))) : text.slice(0, from(n));
  }
  if (sign === '+') return text.slice(from(Math.max(0, n - 1)));
  return text.slice(from(Math.max(0, count - n)));
}
