import { Command, CommandContext } from './index';

/**
 * diff — GNU diffutils-compatible line diff.
 *
 * Formats: normal (default), unified (-u, -U N), context (-c, -C N), brief (-q).
 * Options: -b -w -B -i -a -N -r -s --label/-L --strip-trailing-cr.
 * `-` reads stdin (once, even when given twice). Directories are compared
 * entry by entry ("Only in ...", -r recurses), and `diff DIR FILE` compares
 * DIR/basename(FILE) with FILE.
 */

interface Opts {
  format: 'normal' | 'unified' | 'context';
  context: number;
  brief: boolean;
  reportSame: boolean;
  ignoreSpaceChange: boolean;
  ignoreAllSpace: boolean;
  ignoreBlankLines: boolean;
  ignoreCase: boolean;
  text: boolean;
  newFile: boolean;
  recursive: boolean;
  stripCr: boolean;
  labels: string[];
  /** option words as given, for the "diff OPTS a b" lines in directory mode */
  switches: string[];
}

interface FileData {
  lines: string[];
  /** last line has no trailing newline */
  noEol: boolean;
  binary: boolean;
  mtime: Date;
}

/** A change: a[a0..a1) replaced by b[b0..b1) */
interface Change { a0: number; a1: number; b0: number; b1: number; ignorable?: boolean }

class DiffError extends Error {}

export const diffCmd: Command = {
  name: 'diff',
  description: 'Compare files line by line',
  async exec(ctx: CommandContext) {
    const o: Opts = {
      format: 'normal', context: 3, brief: false, reportSame: false,
      ignoreSpaceChange: false, ignoreAllSpace: false, ignoreBlankLines: false, ignoreCase: false,
      text: false, newFile: false, recursive: false, stripCr: false, labels: [], switches: [],
    };
    const files: string[] = [];
    const args = ctx.args;
    const usage = (msg: string) => { ctx.stderr += `diff: ${msg}\ndiff: Try 'diff --help' for more information.\n`; return 2; };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--') ) {
        o.switches.push(a);
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = () => {
          if (eq >= 0) return a.slice(eq + 1);
          if (i + 1 >= args.length) throw new DiffError(`option '--${name}' requires an argument`);
          o.switches.push(args[i + 1]);
          return args[++i];
        };
        try {
          switch (name) {
            case 'unified': o.format = 'unified'; if (eq >= 0) o.context = parseInt(a.slice(eq + 1), 10) || 0; break;
            case 'context': o.format = 'context'; if (eq >= 0) o.context = parseInt(a.slice(eq + 1), 10) || 0; break;
            case 'brief': o.brief = true; break;
            case 'report-identical-files': o.reportSame = true; break;
            case 'ignore-space-change': o.ignoreSpaceChange = true; break;
            case 'ignore-all-space': o.ignoreAllSpace = true; break;
            case 'ignore-blank-lines': o.ignoreBlankLines = true; break;
            case 'ignore-case': o.ignoreCase = true; break;
            case 'text': o.text = true; break;
            case 'new-file': o.newFile = true; break;
            case 'recursive': o.recursive = true; break;
            case 'strip-trailing-cr': o.stripCr = true; break;
            case 'label': o.labels.push(val()); break;
            case 'normal': o.format = 'normal'; break;
            case 'ignore-tab-expansion': case 'ignore-trailing-space': case 'expand-tabs': case 'minimal':
            case 'speed-large-files': case 'no-dereference': case 'initial-tab':
              break;
            default: return usage(`unrecognized option '${a}'`);
          }
        } catch (e: any) { return usage(e.message); }
        continue;
      }
      if (a.startsWith('-') && a !== '-') {
        o.switches.push(a);
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          const takeVal = (): string => {
            const rest = a.slice(j + 1);
            j = a.length;
            if (rest) return rest;
            if (i + 1 >= args.length) throw new DiffError(`option requires an argument -- '${c}'`);
            o.switches.push(args[i + 1]);
            return args[++i];
          };
          try {
            switch (c) {
              case 'u': o.format = 'unified'; break;
              case 'c': o.format = 'context'; break;
              case 'U': o.format = 'unified'; o.context = parseInt(takeVal(), 10) || 0; break;
              case 'C': o.format = 'context'; o.context = parseInt(takeVal(), 10) || 0; break;
              case 'q': o.brief = true; break;
              case 's': o.reportSame = true; break;
              case 'b': o.ignoreSpaceChange = true; break;
              case 'w': o.ignoreAllSpace = true; break;
              case 'B': o.ignoreBlankLines = true; break;
              case 'i': o.ignoreCase = true; break;
              case 'a': o.text = true; break;
              case 'N': o.newFile = true; break;
              case 'r': o.recursive = true; break;
              case 'L': o.labels.push(takeVal()); break;
              case 'E': case 'Z': case 't': case 'T': case 'd': case 'H': case 'p': break;
              default:
                if (/[0-9]/.test(c)) { // -NUM is context lines
                  const m = /^[0-9]+/.exec(a.slice(j))![0];
                  o.context = parseInt(m, 10);
                  j += m.length - 1;
                  break;
                }
                return usage(`invalid option -- '${c}'`);
            }
          } catch (e: any) { return usage(e.message); }
        }
        continue;
      }
      files.push(a);
    }

    if (files.length < 2) return usage(files.length ? `missing operand after '${files[0]}'` : 'missing operand');
    if (files.length > 2) return usage(`extra operand '${files[2]}'`);

    const st = { stdinUsed: null as FileData | null, out: '' };
    try {
      const code = await diffPaths(ctx, o, st, files[0], files[1], true);
      ctx.stdout += st.out;
      return code;
    } catch (e: any) {
      ctx.stdout += st.out;
      ctx.stderr += `diff: ${e.message}\n`;
      return 2;
    }
  },
};

type Kind = 'file' | 'dir' | 'missing';

async function kindOf(ctx: CommandContext, name: string): Promise<Kind> {
  if (name === '-') return 'file';
  try {
    const s = await ctx.fs.stat(ctx.fs.resolvePath(name, ctx.cwd));
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function baseName(p: string): string {
  const s = p.replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

async function diffPaths(ctx: CommandContext, o: Opts, st: { stdinUsed: FileData | null; out: string }, A: string, B: string, top: boolean): Promise<number> {
  let ka = await kindOf(ctx, A);
  let kb = await kindOf(ctx, B);
  if (top) {
    if (ka === 'missing' && !(o.newFile && kb !== 'missing')) throw new DiffError(`${A}: No such file or directory`);
    if (kb === 'missing' && !(o.newFile && ka !== 'missing')) throw new DiffError(`${B}: No such file or directory`);
    if (ka === 'dir' && kb === 'file') {
      if (B === '-') throw new DiffError(`cannot compare '-' to a directory`);
      A = joinPath(A, baseName(B)); ka = await kindOf(ctx, A);
      if (ka === 'missing') throw new DiffError(`${A}: No such file or directory`);
    } else if (ka === 'file' && kb === 'dir') {
      if (A === '-') throw new DiffError(`cannot compare '-' to a directory`);
      B = joinPath(B, baseName(A)); kb = await kindOf(ctx, B);
      if (kb === 'missing') throw new DiffError(`${B}: No such file or directory`);
    }
  }
  if (ka === 'dir' && kb === 'dir') return diffDirs(ctx, o, st, A, B);
  if (ka === 'dir' || kb === 'dir') {
    // One side a directory inside a recursive comparison
    const missing = ka === 'missing' || kb === 'missing';
    if (missing && o.newFile) {
      // Treat the missing directory as empty
      return diffDirs(ctx, o, st, A, B, ka === 'missing', kb === 'missing');
    }
    st.out += ka === 'dir'
      ? `File ${A} is a directory while file ${B} is a regular file\n`
      : `File ${A} is a regular file while file ${B} is a directory\n`;
    return 1;
  }
  return diffFiles(ctx, o, st, A, B, ka === 'missing', kb === 'missing', top);
}

async function listDir(ctx: CommandContext, dir: string): Promise<string[]> {
  try { return await ctx.fs.readdir(await ctx.fs.realpath(ctx.fs.resolvePath(dir, ctx.cwd)).catch(() => ctx.fs.resolvePath(dir, ctx.cwd))); } catch { return []; }
}

async function diffDirs(ctx: CommandContext, o: Opts, st: { stdinUsed: FileData | null; out: string }, A: string, B: string, aMissing = false, bMissing = false): Promise<number> {
  const la = aMissing ? [] : await listDir(ctx, A);
  const lb = bMissing ? [] : await listDir(ctx, B);
  const sa = new Set(la), sb = new Set(lb);
  const names = [...new Set([...la, ...lb])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  let worst = 0;
  for (const n of names) {
    const pa = joinPath(A, n), pb = joinPath(B, n);
    let code = 0;
    if (!sa.has(n) || !sb.has(n)) {
      if (o.newFile) {
        const k = await kindOf(ctx, sa.has(n) ? pa : pb);
        if (k === 'dir' && !o.recursive) {
          st.out += `Only in ${sa.has(n) ? A : B}: ${n}\n`;
          code = 1;
        } else {
          code = await diffPaths(ctx, o, st, pa, pb, false);
        }
      } else {
        st.out += `Only in ${sa.has(n) ? A : B}: ${n}\n`;
        code = 1;
      }
    } else {
      const ka = await kindOf(ctx, pa), kb = await kindOf(ctx, pb);
      if (ka === 'dir' && kb === 'dir' && !o.recursive) {
        st.out += `Common subdirectories: ${pa} and ${pb}\n`;
      } else {
        code = await diffPaths(ctx, o, st, pa, pb, false);
      }
    }
    worst = Math.max(worst, code);
  }
  return worst;
}

async function readData(ctx: CommandContext, o: Opts, st: { stdinUsed: FileData | null }, name: string, missing: boolean): Promise<FileData> {
  if (missing) return { lines: [], noEol: false, binary: false, mtime: new Date(0) };
  if (name === '-' && st.stdinUsed) return st.stdinUsed;
  let text: string;
  let mtime = new Date();
  if (name === '-') {
    text = ctx.stdin || '';
  } else {
    const p = ctx.fs.resolvePath(name, ctx.cwd);
    try {
      text = await ctx.fs.readFile(p, 'utf8') as string;
      try { mtime = (await ctx.fs.stat(p)).mtime; } catch {}
    } catch {
      throw new DiffError(`${name}: No such file or directory`);
    }
  }
  const binary = !o.text && text.slice(0, 8192).includes('\0');
  const noEol = text.length > 0 && !text.endsWith('\n');
  const lines = text.length === 0 ? [] : (noEol ? text : text.slice(0, -1)).split('\n');
  if (o.stripCr) for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\r$/, '');
  const d = { lines, noEol, binary, mtime };
  if (name === '-') st.stdinUsed = d;
  return d;
}

function pad(n: number, w = 2) { return String(n).padStart(w, '0'); }

/** GNU's header time: 2024-01-02 03:04:05.000000000 +0000 (local time) */
function fmtTime(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ao = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}000000 ${sign}${pad(Math.floor(ao / 60))}${pad(ao % 60)}`;
}

async function diffFiles(ctx: CommandContext, o: Opts, st: { stdinUsed: FileData | null; out: string }, A: string, B: string, aMissing: boolean, bMissing: boolean, top: boolean): Promise<number> {
  const fa = await readData(ctx, o, st, A, aMissing);
  const fb = await readData(ctx, o, st, B, bMissing);
  const header = !top ? `diff ${o.switches.join(' ')}${o.switches.length ? ' ' : ''}${A} ${B}\n` : '';

  if (A === '-' && B === '-') {
    if (o.reportSame) st.out += `Files ${A} and ${B} are identical\n`;
    return 0;
  }
  if (fa.binary || fb.binary) {
    const same = fa.noEol === fb.noEol && fa.lines.length === fb.lines.length && fa.lines.every((l, i) => l === fb.lines[i]);
    if (same) {
      if (o.reportSame) st.out += `Files ${A} and ${B} are identical\n`;
      return 0;
    }
    st.out += o.brief ? `Files ${A} and ${B} differ\n` : `Binary files ${A} and ${B} differ\n`;
    return 1;
  }

  const changes = computeChanges(fa, fb, o);
  if (o.ignoreBlankLines) {
    const blank = (l: string) => /^[ \t\r\f\v]*$/.test(l);
    for (const c of changes) {
      let all = true;
      for (let i = c.a0; i < c.a1 && all; i++) all = blank(fa.lines[i]);
      for (let i = c.b0; i < c.b1 && all; i++) all = blank(fb.lines[i]);
      c.ignorable = all;
    }
  }
  const real = changes.filter((c) => !c.ignorable);
  if (!real.length) {
    if (o.reportSame) st.out += `Files ${A} and ${B} are identical\n`;
    return 0;
  }
  if (o.brief) {
    st.out += `Files ${A} and ${B} differ\n`;
    return 1;
  }
  st.out += header;
  const la = o.labels[0] ?? `${A}\t${fmtTime(fa.mtime)}`;
  const lb = o.labels[1] ?? `${B}\t${fmtTime(fb.mtime)}`;
  if (o.format === 'unified') {
    st.out += `--- ${la}\n+++ ${lb}\n`;
    st.out += formatUnified(fa, fb, changes, o.context);
  } else if (o.format === 'context') {
    st.out += `*** ${la}\n--- ${lb}\n`;
    st.out += formatContext(fa, fb, changes, o.context);
  } else {
    st.out += formatNormal(fa, fb, real);
  }
  return 1;
}

/** Comparison key of a line under the whitespace/case options */
function keyFn(o: Opts): (l: string) => string {
  return (l) => {
    let k = l;
    if (o.ignoreAllSpace) k = k.replace(/[ \t\r\f\v]+/g, '');
    else if (o.ignoreSpaceChange) k = k.replace(/[ \t\r\f\v]+/g, ' ').replace(/ $/, '');
    if (o.ignoreCase) k = k.toLowerCase();
    return k;
  };
}

function computeChanges(fa: FileData, fb: FileData, o: Opts): Change[] {
  const key = keyFn(o);
  const ws = o.ignoreAllSpace || o.ignoreSpaceChange;
  // Intern keys to integers; a missing final newline is part of the last line unless whitespace is ignored
  const ids = new Map<string, number>();
  const intern = (lines: string[], noEol: boolean) => lines.map((l, i) => {
    let k = key(l);
    if (noEol && !ws && i === lines.length - 1) k += '\0noeol';
    let id = ids.get(k);
    if (id === undefined) { id = ids.size + 1; ids.set(k, id); }
    return id;
  });
  const a = intern(fa.lines, fa.noEol);
  const b = intern(fb.lines, fb.noEol);
  return analyze(a, b, o.format === 'normal' ? 0 : o.context);
}

/**
 * Line matching the way GNU diff (analyze.c) does it, so hunks line up like
 * GNU's: trim the common prefix/suffix, discard "confusing" lines, find a
 * minimal edit script by divide and conquer on the middle snake, then slide
 * change runs (shift_boundaries). Inputs are equivalence-class ids (>= 1).
 */
function analyze(a: number[], b: number[], horizon: number): Change[] {
  const n = a.length, m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  // Like GNU, keep HORIZON lines of the common ends in the analysed region
  pre = Math.max(0, pre - horizon);
  suf = Math.max(0, suf - horizon);
  const eq = [a.slice(pre, n - suf), b.slice(pre, m - suf)];
  const len = [eq[0].length, eq[1].length];
  // changed[f][i + 1]; index 0 and len + 1 are sentinels
  const changed = [new Uint8Array(len[0] + 2), new Uint8Array(len[1] + 2)];

  // discard_confusing_lines
  const counts = [new Map<number, number>(), new Map<number, number>()];
  for (let f = 0; f < 2; f++) for (const e of eq[f]) counts[f].set(e, (counts[f].get(e) || 0) + 1);
  const discards = [new Uint8Array(len[0]), new Uint8Array(len[1])];
  for (let f = 0; f < 2; f++) {
    const end = len[f];
    let many = 5;
    let tem = Math.floor(end / 64);
    while ((tem >>= 2) > 0) many *= 2;
    for (let i = 0; i < end; i++) {
      const nm = counts[1 - f].get(eq[f][i]) || 0;
      if (nm === 0) discards[f][i] = 1;
      else if (nm > many) discards[f][i] = 2;
    }
  }
  for (let f = 0; f < 2; f++) {
    const end = len[f];
    const d = discards[f];
    for (let i = 0; i < end; i++) {
      if (d[i] === 2) d[i] = 0;
      else if (d[i] !== 0) {
        let j: number;
        let provisional = 0;
        for (j = i; j < end; j++) {
          if (d[j] === 0) break;
          if (d[j] === 2) ++provisional;
        }
        while (j > i && d[j - 1] === 2) { d[--j] = 0; --provisional; }
        const length = j - i;
        if (provisional * 4 > length) {
          while (j > i) if (d[--j] === 2) d[j] = 0;
        } else {
          let minimum = 1;
          let t = length >> 2;
          while (0 < (t >>= 2)) minimum <<= 1;
          minimum++;
          let consec = 0;
          for (j = 0, consec = 0; j < length; j++) {
            if (d[i + j] !== 2) consec = 0;
            else if (minimum === ++consec) j -= consec;
            else if (minimum < consec) d[i + j] = 0;
          }
          for (j = 0, consec = 0; j < length; j++) {
            if (j >= 8 && d[i + j] === 1) break;
            if (d[i + j] === 2) { consec = 0; d[i + j] = 0; }
            else if (d[i + j] === 0) consec = 0;
            else consec++;
            if (consec === 3) break;
          }
          i += length - 1;
          for (j = 0, consec = 0; j < length; j++) {
            if (j >= 8 && d[i - j] === 1) break;
            if (d[i - j] === 2) { consec = 0; d[i - j] = 0; }
            else if (d[i - j] === 0) consec = 0;
            else consec++;
            if (consec === 3) break;
          }
        }
      }
    }
  }
  const und: number[][] = [[], []];
  const real: number[][] = [[], []];
  for (let f = 0; f < 2; f++) {
    for (let i = 0; i < len[f]; i++) {
      if (discards[f][i] === 0) { und[f].push(eq[f][i]); real[f].push(i); }
      else changed[f][i + 1] = 1;
    }
  }

  // compareseq / diag (always minimal)
  const xv = und[0], yv = und[1];
  const nx = xv.length, ny = yv.length;
  const size = nx + ny + 3;
  const fd = new Int32Array(2 * size + 1), bd = new Int32Array(2 * size + 1);
  const OFF = size;
  const diag = (xoff: number, xlim: number, yoff: number, ylim: number): [number, number] => {
    const dmin = xoff - ylim, dmax = xlim - yoff;
    const fmid = xoff - yoff, bmid = xlim - ylim;
    let fmin = fmid, fmax = fmid, bmin = bmid, bmax = bmid;
    const odd = (fmid - bmid) & 1;
    fd[OFF + fmid] = xoff; bd[OFF + bmid] = xlim;
    for (;;) {
      if (fmin > dmin) fd[OFF + --fmin - 1] = -1; else ++fmin;
      if (fmax < dmax) fd[OFF + ++fmax + 1] = -1; else --fmax;
      for (let d = fmax; d >= fmin; d -= 2) {
        const tlo = fd[OFF + d - 1], thi = fd[OFF + d + 1];
        const x0 = tlo < thi ? thi : tlo + 1;
        let x = x0, y = x0 - d;
        while (x < xlim && y < ylim && xv[x] === yv[y]) { x++; y++; }
        fd[OFF + d] = x;
        if (odd && bmin <= d && d <= bmax && bd[OFF + d] <= x) return [x, y];
      }
      if (bmin > dmin) bd[OFF + --bmin - 1] = 0x7fffffff; else ++bmin;
      if (bmax < dmax) bd[OFF + ++bmax + 1] = 0x7fffffff; else --bmax;
      for (let d = bmax; d >= bmin; d -= 2) {
        const tlo = bd[OFF + d - 1], thi = bd[OFF + d + 1];
        const x0 = tlo < thi ? tlo : thi - 1;
        let x = x0, y = x0 - d;
        while (xoff < x && yoff < y && xv[x - 1] === yv[y - 1]) { x--; y--; }
        bd[OFF + d] = x;
        if (!odd && fmin <= d && d <= fmax && x <= fd[OFF + d]) return [x, y];
      }
    }
  };
  // Explicit stack instead of recursion
  const stack: number[][] = [[0, nx, 0, ny]];
  while (stack.length) {
    let [xoff, xlim, yoff, ylim] = stack.pop()!;
    while (xoff < xlim && yoff < ylim && xv[xoff] === yv[yoff]) { xoff++; yoff++; }
    while (xoff < xlim && yoff < ylim && xv[xlim - 1] === yv[ylim - 1]) { xlim--; ylim--; }
    if (xoff === xlim) { while (yoff < ylim) changed[1][real[1][yoff++] + 1] = 1; }
    else if (yoff === ylim) { while (xoff < xlim) changed[0][real[0][xoff++] + 1] = 1; }
    else {
      const [xm, ym] = diag(xoff, xlim, yoff, ylim);
      stack.push([xm, xlim, ym, ylim]);
      stack.push([xoff, xm, yoff, ym]);
    }
  }

  // shift_boundaries (arrays offset by one; ch(i) = changed[i + 1])
  for (let f = 0; f < 2; f++) {
    const ch = changed[f], oc = changed[1 - f], e = eq[f];
    const iEnd = len[f];
    let i = 0, j = 0;
    for (;;) {
      while (i < iEnd && !ch[i + 1]) {
        while (oc[1 + j++]) continue;
        i++;
      }
      if (i === iEnd) break;
      let start = i;
      while (ch[1 + ++i]) continue;
      while (oc[1 + j]) j++;
      let runlength: number, corresponding: number;
      do {
        runlength = i - start;
        while (start && e[start - 1] === e[i - 1]) {
          ch[1 + --start] = 1;
          ch[1 + --i] = 0;
          while (ch[1 + start - 1]) start--;
          while (oc[1 + --j]) continue;
        }
        corresponding = oc[1 + j - 1] ? i : iEnd;
        while (i !== iEnd && e[start] === e[i]) {
          ch[1 + start++] = 0;
          ch[1 + i++] = 1;
          while (ch[1 + i]) i++;
          while (oc[1 + ++j]) corresponding = i;
        }
      } while (runlength !== i - start);
      while (corresponding < i) {
        ch[1 + --start] = 1;
        ch[1 + --i] = 0;
        while (oc[1 + --j]) continue;
      }
    }
  }

  // Collect changes from the flags
  const changes: Change[] = [];
  let i = 0, j = 0;
  while (i < len[0] || j < len[1]) {
    if (i < len[0] && j < len[1] && !changed[0][i + 1] && !changed[1][j + 1]) { i++; j++; continue; }
    const c: Change = { a0: i + pre, a1: 0, b0: j + pre, b1: 0 };
    while (i < len[0] && changed[0][i + 1]) i++;
    while (j < len[1] && changed[1][j + 1]) j++;
    c.a1 = i + pre; c.b1 = j + pre;
    if (c.a0 === c.a1 && c.b0 === c.b1) break; // inconsistent flags; cannot happen
    changes.push(c);
  }
  return changes;
}

const NOEOL = '\\ No newline at end of file\n';

function emit(prefix: string, f: FileData, i: number): string {
  let s = `${prefix}${f.lines[i]}\n`;
  if (f.noEol && i === f.lines.length - 1) s += NOEOL;
  return s;
}

/** Group changes whose context overlaps; drop groups that are entirely ignorable */
function groups(changes: Change[], ctxN: number): Change[][] {
  const out: Change[][] = [];
  let cur: Change[] = [];
  for (const c of changes) {
    if (cur.length && c.a0 - cur[cur.length - 1].a1 > 2 * ctxN) { out.push(cur); cur = []; }
    cur.push(c);
  }
  if (cur.length) out.push(cur);
  return out.filter((g) => g.some((c) => !c.ignorable));
}

function uRange(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  if (count === 1) return `${start + 1}`;
  return `${start + 1},${count}`;
}

function formatUnified(fa: FileData, fb: FileData, changes: Change[], ctxN: number): string {
  let out = '';
  for (const g of groups(changes, ctxN)) {
    const first = g[0], last = g[g.length - 1];
    const a0 = Math.max(0, first.a0 - ctxN);
    const a1 = Math.min(fa.lines.length, last.a1 + ctxN);
    const b0 = first.b0 - (first.a0 - a0);
    const b1 = last.b1 + (a1 - last.a1);
    out += `@@ -${uRange(a0, a1 - a0)} +${uRange(b0, b1 - b0)} @@\n`;
    let ai = a0;
    for (const c of g) {
      for (; ai < c.a0; ai++) out += emit(' ', fa, ai);
      for (let i = c.a0; i < c.a1; i++) out += emit('-', fa, i);
      for (let i = c.b0; i < c.b1; i++) out += emit('+', fb, i);
      ai = c.a1;
    }
    for (; ai < a1; ai++) out += emit(' ', fa, ai);
  }
  return out;
}

function cRange(start: number, end: number): string {
  // start/end are 0-based [start, end)
  if (end - start === 0) return `${start}`;
  if (end - start === 1) return `${end}`;
  return `${start + 1},${end}`;
}

function formatContext(fa: FileData, fb: FileData, changes: Change[], ctxN: number): string {
  let out = '';
  for (const g of groups(changes, ctxN)) {
    const first = g[0], last = g[g.length - 1];
    const a0 = Math.max(0, first.a0 - ctxN);
    const a1 = Math.min(fa.lines.length, last.a1 + ctxN);
    const b0 = first.b0 - (first.a0 - a0);
    const b1 = Math.min(fb.lines.length, last.b1 + (a1 - last.a1));
    out += '***************\n';
    out += `*** ${cRange(a0, a1)} ****\n`;
    if (g.some((c) => c.a1 > c.a0)) {
      let ai = a0;
      for (const c of g) {
        for (; ai < c.a0; ai++) out += emit('  ', fa, ai);
        const mark = c.b1 > c.b0 ? '! ' : '- ';
        for (let i = c.a0; i < c.a1; i++) out += emit(mark, fa, i);
        ai = c.a1;
      }
      for (; ai < a1; ai++) out += emit('  ', fa, ai);
    }
    out += `--- ${cRange(b0, b1)} ----\n`;
    if (g.some((c) => c.b1 > c.b0)) {
      let bi = b0;
      for (const c of g) {
        for (; bi < c.b0; bi++) out += emit('  ', fb, bi);
        const mark = c.a1 > c.a0 ? '! ' : '+ ';
        for (let i = c.b0; i < c.b1; i++) out += emit(mark, fb, i);
        bi = c.b1;
      }
      for (; bi < b1; bi++) out += emit('  ', fb, bi);
    }
  }
  return out;
}

function nRange(start: number, end: number): string {
  // 1-based display of [start, end)
  return end - start <= 1 ? `${end - start === 1 ? end : start}` : `${start + 1},${end}`;
}

function formatNormal(fa: FileData, fb: FileData, changes: Change[]): string {
  let out = '';
  for (const c of changes) {
    const op = c.a0 === c.a1 ? 'a' : c.b0 === c.b1 ? 'd' : 'c';
    out += `${nRange(c.a0, c.a1)}${op}${nRange(c.b0, c.b1)}\n`;
    for (let i = c.a0; i < c.a1; i++) out += emit('< ', fa, i);
    if (op === 'c') out += '---\n';
    for (let i = c.b0; i < c.b1; i++) out += emit('> ', fb, i);
  }
  return out;
}
