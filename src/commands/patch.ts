import type { Command, CommandContext } from './index';

/**
 * patch — GNU patch-compatible.
 *
 *   patch [OPTIONS] [ORIGFILE [PATCHFILE]]
 *
 * Reads unified, context and normal diffs (the patch comes from -i FILE,
 * PATCHFILE or stdin). Hunks are located with offsets and up to -F fuzz
 * (default 2); hunks that don't apply are saved to FILE.rej. A patch that
 * looks already applied is detected ("Reversed (or previously applied)") and
 * skipped. Options: -p N, -R, -N, -o FILE, -d DIR, -r FILE, -b, -E, -s,
 * -f, -t, --dry-run, --verbose, -F N, -l.
 */

interface HLine { op: ' ' | '-' | '+'; text: string }

interface Hunk {
  oldStart: number; // 1-based (0 for an empty old side)
  newStart: number;
  lines: HLine[];
  /** last old / new line has no newline */
  oldNoEol: boolean;
  newNoEol: boolean;
}

interface FilePatch {
  oldName: string | null;
  newName: string | null;
  indexName: string | null;
  hunks: Hunk[];
  /** text leading up to the hunks, for "can't find file" messages */
  header: string[];
  /** line number (1-based) in the patch of the first hunk header */
  hunkLine: number;
  kind: 'unified' | 'context' | 'normal';
}

function stripName(raw: string): string {
  // "name\tdate" or "name  date"
  let s = raw.replace(/\t.*$/, '');
  if (/^"/.test(s)) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
    if (m) s = m[1].replace(/\\(.)/g, '$1');
  }
  const m = /^(.*?)\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? [+-]\d{4}$/.exec(s);
  if (m) s = m[1];
  return s.replace(/\s+$/, '');
}

function parsePatch(text: string): FilePatch[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out: FilePatch[] = [];
  let header: string[] = [];
  let indexName: string | null = null;
  let i = 0;
  const range = (s: string): [number, number] => {
    const [a, b] = s.split(',');
    return [parseInt(a, 10), b === undefined ? 1 : parseInt(b, 10)];
  };
  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = /^Index:\s+(.*)$/.exec(line))) { indexName = m[1].trim(); header.push(line); i++; continue; }
    // unified
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const fp: FilePatch = { oldName: stripName(line.slice(4)), newName: stripName(lines[i + 1].slice(4)), indexName, hunks: [], header: [...header, line, lines[i + 1]], hunkLine: i + 3, kind: 'unified' };
      i += 2;
      while (i < lines.length && (m = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/.exec(lines[i]))) {
        const [os, oc] = range(m[1]);
        const [ns, nc] = range(m[2]);
        const h: Hunk = { oldStart: os, newStart: ns, lines: [], oldNoEol: false, newNoEol: false };
        i++;
        let ol = oc, nl = nc;
        let last: HLine | null = null;
        while (i < lines.length && (ol > 0 || nl > 0)) {
          const l = lines[i];
          if (l.startsWith('\\')) { i++; continue; }
          const c = l[0];
          if (c === ' ' || l === '') { last = { op: ' ', text: l.slice(1) }; ol--; nl--; }
          else if (c === '-') { last = { op: '-', text: l.slice(1) }; ol--; }
          else if (c === '+') { last = { op: '+', text: l.slice(1) }; nl--; }
          else break;
          h.lines.push(last);
          i++;
        }
        // "\ No newline at end of file" after the hunk's last old/new line
        while (i < lines.length && lines[i].startsWith('\\')) {
          if (last) {
            if (last.op !== '+') h.oldNoEol = true;
            if (last.op !== '-') h.newNoEol = true;
          }
          i++;
        }
        fp.hunks.push(h);
      }
      out.push(fp);
      header = [];
      indexName = null;
      continue;
    }
    // context
    if (line.startsWith('*** ') && i + 1 < lines.length && lines[i + 1].startsWith('--- ') && !/^\*\*\* \d/.test(line)) {
      const fp: FilePatch = { oldName: stripName(line.slice(4)), newName: stripName(lines[i + 1].slice(4)), indexName, hunks: [], header: [...header, line, lines[i + 1]], hunkLine: i + 3, kind: 'context' };
      i += 2;
      while (i < lines.length && /^\*{15}/.test(lines[i])) {
        i++;
        const om = /^\*\*\* (\d+)(?:,(\d+))? \*\*\*\*/.exec(lines[i] ?? '');
        if (!om) break;
        i++;
        const oStart = parseInt(om[1], 10);
        const oEnd = om[2] ? parseInt(om[2], 10) : oStart;
        const oldPart: { mark: string; text: string }[] = [];
        while (i < lines.length && !/^--- \d/.test(lines[i]) && /^[ !+-] /.test(lines[i])) { oldPart.push({ mark: lines[i][0], text: lines[i].slice(2) }); i++; }
        let oldNoEol = false, newNoEol = false;
        if (lines[i]?.startsWith('\\')) { oldNoEol = true; i++; }
        const nm = /^--- (\d+)(?:,(\d+))? ----/.exec(lines[i] ?? '');
        if (!nm) break;
        i++;
        const nStart = parseInt(nm[1], 10);
        const newPart: { mark: string; text: string }[] = [];
        while (i < lines.length && /^[ !+-] /.test(lines[i])) { newPart.push({ mark: lines[i][0], text: lines[i].slice(2) }); i++; }
        if (lines[i]?.startsWith('\\')) { newNoEol = true; i++; }
        void oEnd;
        // merge the two sides into unified lines
        const h: Hunk = { oldStart: oStart, newStart: nStart, lines: [], oldNoEol, newNoEol };
        if (!oldPart.length) {
          for (const n of newPart) h.lines.push({ op: n.mark === ' ' ? ' ' : '+', text: n.text });
        } else if (!newPart.length) {
          for (const o of oldPart) h.lines.push({ op: o.mark === ' ' ? ' ' : '-', text: o.text });
        } else {
          let a = 0, b = 0;
          while (a < oldPart.length || b < newPart.length) {
            const o = oldPart[a], n = newPart[b];
            if (o && o.mark === ' ' && n && n.mark === ' ') { h.lines.push({ op: ' ', text: o.text }); a++; b++; continue; }
            if (o && o.mark === '-') { h.lines.push({ op: '-', text: o.text }); a++; continue; }
            if (n && n.mark === '+') { h.lines.push({ op: '+', text: n.text }); b++; continue; }
            if (o && o.mark === '!') {
              while (a < oldPart.length && oldPart[a].mark === '!') h.lines.push({ op: '-', text: oldPart[a++].text });
              while (b < newPart.length && newPart[b].mark === '!') h.lines.push({ op: '+', text: newPart[b++].text });
              continue;
            }
            if (n && n.mark === '!') { while (b < newPart.length && newPart[b].mark === '!') h.lines.push({ op: '+', text: newPart[b++].text }); continue; }
            if (o) { h.lines.push({ op: ' ', text: o.text }); a++; if (n && n.mark === ' ') b++; continue; }
            if (n) { h.lines.push({ op: ' ', text: n.text }); b++; continue; }
          }
        }
        fp.hunks.push(h);
      }
      out.push(fp);
      header = [];
      indexName = null;
      continue;
    }
    // normal
    if ((m = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/.exec(line))) {
      let fp = out.length && out[out.length - 1].kind === 'normal' && !header.length ? out[out.length - 1] : null;
      if (!fp) {
        fp = { oldName: null, newName: null, indexName, hunks: [], header: [...header], hunkLine: i + 1, kind: 'normal' };
        out.push(fp);
        header = [];
      }
      const o1 = parseInt(m[1], 10), o2 = m[2] ? parseInt(m[2], 10) : o1;
      const n1 = parseInt(m[4], 10), n2 = m[5] ? parseInt(m[5], 10) : n1;
      const op = m[3];
      i++;
      const h: Hunk = { oldStart: op === 'a' ? o1 + 1 : o1, newStart: op === 'd' ? n1 + 1 : n1, lines: [], oldNoEol: false, newNoEol: false };
      if (op !== 'a') for (let k = o1; k <= o2 && i < lines.length; k++) {
        if (lines[i].startsWith('< ')) h.lines.push({ op: '-', text: lines[i++].slice(2) });
        if (lines[i]?.startsWith('\\')) { h.oldNoEol = true; i++; }
      }
      if (op === 'c' && lines[i] === '---') i++;
      if (op !== 'd') for (let k = n1; k <= n2 && i < lines.length; k++) {
        if (lines[i].startsWith('> ')) h.lines.push({ op: '+', text: lines[i++].slice(2) });
        if (lines[i]?.startsWith('\\')) { h.newNoEol = true; i++; }
      }
      // normal diffs give the line before an insertion
      if (op === 'a') h.oldStart = o1 + 1;
      fp.hunks.push(h);
      continue;
    }
    header.push(line);
    i++;
  }
  return out.filter((fp) => fp.hunks.length);
}

function stripPath(name: string, p: number | null): string {
  if (p === null) return name.slice(name.lastIndexOf('/') + 1);
  const parts = name.split('/');
  // runs of slashes count as one separator
  let k = 0;
  let idx = 0;
  while (k < p && idx < name.length) {
    const j = name.indexOf('/', idx);
    if (j < 0) return name.slice(name.lastIndexOf('/') + 1);
    idx = j;
    while (name[idx] === '/') idx++;
    k++;
  }
  void parts;
  return name.slice(idx);
}

interface Lines { lines: string[]; noEol: boolean }

function toLines(text: string): Lines {
  if (text === '') return { lines: [], noEol: false };
  const noEol = !text.endsWith('\n');
  return { lines: (noEol ? text : text.slice(0, -1)).split('\n'), noEol };
}

function fromLines(l: Lines): string {
  if (!l.lines.length) return '';
  return l.lines.join('\n') + (l.noEol ? '' : '\n');
}

export const patch: Command = {
  name: "patch",
  description: "Apply a diff file to an original",
  async exec(ctx) {
    try {
      return await runPatch(ctx);
    } catch (e: any) {
      ctx.stderr += `patch: **** ${e?.message ?? e}\n`;
      return 2;
    }
  },
};

async function runPatch(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  let strip: number | null = null;
  let reverse = false, forward = false, dryRun = false, silent = false, force = false, batch = false;
  let backup = false, removeEmpty = false, verbose = false, ignoreWs = false;
  let fuzz = 2;
  let inputFile: string | null = null;
  let outputFile: string | null = null;
  let dir: string | null = null;
  let rejectFile: string | null = null;
  const operands: string[] = [];
  const usage = (msg: string) => { ctx.stderr += `patch: ${msg}\npatch: Try 'patch --help' for more information.\n`; return 2; };
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!opts || !a.startsWith('-') || a === '-') { operands.push(a); continue; }
    if (a === '--') { opts = false; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const val = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
      switch (name) {
        case 'strip': strip = parseInt(val() ?? '0', 10); break;
        case 'reverse': reverse = true; break;
        case 'forward': forward = true; break;
        case 'dry-run': dryRun = true; break;
        case 'silent': case 'quiet': silent = true; break;
        case 'force': force = true; break;
        case 'batch': batch = true; break;
        case 'backup': backup = true; break;
        case 'remove-empty-files': removeEmpty = true; break;
        case 'verbose': verbose = true; break;
        case 'ignore-whitespace': ignoreWs = true; break;
        case 'fuzz': fuzz = parseInt(val() ?? '2', 10); break;
        case 'input': inputFile = val(); break;
        case 'output': outputFile = val(); break;
        case 'directory': dir = val(); break;
        case 'reject-file': rejectFile = val(); break;
        case 'unified': case 'context': case 'normal': case 'no-backup-if-mismatch': case 'backup-if-mismatch':
        case 'posix': case 'binary': case 'follow-symlinks': case 'set-time': case 'set-utc': break;
        case 'quoting-style': case 'suffix': case 'prefix': case 'basename-prefix': case 'version-control':
        case 'get': case 'read-only': case 'reject-format': val(); break;
        default: return usage(`unrecognized option '${a}'`);
      }
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      const need = (): string | undefined => { const rest = a.slice(j + 1); j = a.length; return rest || args[++i]; };
      switch (c) {
        case 'p': { const v = need(); if (v === undefined) return usage(`option requires an argument -- 'p'`); strip = parseInt(v, 10); break; }
        case 'R': reverse = true; break;
        case 'N': forward = true; break;
        case 's': silent = true; break;
        case 'f': force = true; break;
        case 't': batch = true; break;
        case 'b': backup = true; break;
        case 'E': removeEmpty = true; break;
        case 'l': ignoreWs = true; break;
        case 'F': fuzz = parseInt(need() ?? '2', 10); break;
        case 'i': inputFile = need() ?? null; break;
        case 'o': outputFile = need() ?? null; break;
        case 'd': dir = need() ?? null; break;
        case 'r': rejectFile = need() ?? null; break;
        case 'u': case 'c': case 'n': case 'e': case 'Z': case 'T': case 'g': break;
        case 'B': case 'Y': case 'z': case 'V': case 'D': need(); break;
        default: return usage(`invalid option -- '${c}'`);
      }
    }
  }
  if (operands.length > 2) return usage(`extra operand '${operands[2]}'`);
  void batch;
  const cwd = dir ? ctx.fs.resolvePath(dir, ctx.cwd) : ctx.cwd;
  const fs = ctx.fs;
  const patchSrc = inputFile ?? operands[1] ?? null;
  let text: string;
  if (patchSrc === null || patchSrc === '-') text = ctx.stdin || '';
  else {
    try { text = await fs.readFile(fs.resolvePath(patchSrc, ctx.cwd), 'utf8') as string; }
    catch { throw new Error(`Can't open patch file ${patchSrc} : No such file or directory`); }
  }
  const origOperand = operands[0] ?? null;
  const files = parsePatch(text);
  if (!files.length) {
    if (text.trim()) { ctx.stderr += 'patch: **** Only garbage was found in the patch input.\n'; return 2; }
    return 0;
  }

  let status = 0;
  let out = '';
  const say = (s: string) => { if (!silent) out += s; };
  const exists = async (name: string) => { try { await fs.stat(fs.resolvePath(name, cwd)); return true; } catch { return false; } };
  const eq = (a: string, b: string) => (ignoreWs ? a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim() : a === b);
  const outputs = new Map<string, string>();

  for (const fp of files) {
    // Choose the file to patch
    let target: string | null = null;
    const cands = [fp.oldName, fp.newName, fp.indexName].filter((n): n is string => !!n && n !== '/dev/null').map((n) => stripPath(n, strip));
    const creating = fp.oldName === '/dev/null' || (fp.hunks.length === 1 && fp.hunks[0].oldStart === 0 && !fp.hunks[0].lines.some((l) => l.op !== '+'));
    const deleting = fp.newName === '/dev/null';
    if (origOperand) target = origOperand;
    else {
      const existing: string[] = [];
      for (const c of cands) if (c && await exists(c)) existing.push(c);
      if (existing.length) {
        // GNU: fewest path components, then shortest basename, then shortest name
        existing.sort((x, y) => x.split('/').length - y.split('/').length || x.slice(x.lastIndexOf('/') + 1).length - y.slice(y.lastIndexOf('/') + 1).length || x.length - y.length);
        target = existing[0];
      } else if (creating && cands.length) {
        target = fp.newName && fp.newName !== '/dev/null' ? stripPath(fp.newName, strip) : cands[0];
      }
    }
    if (!target) {
      say(`can't find file to patch at input line ${fp.hunkLine}\nPerhaps you ${strip === null ? 'should have used the -p or --strip option' : 'used the wrong -p or --strip option'}?\nThe text leading up to this was:\n--------------------------\n${fp.header.map((l) => '|' + l + '\n').join('')}--------------------------\nFile to patch: \nSkip this patch? [y] \nSkipping patch.\n${fp.hunks.length} out of ${fp.hunks.length} hunk${fp.hunks.length === 1 ? '' : 's'} ignored\n`);
      status = Math.max(status, 1);
      continue;
    }
    const abs = fs.resolvePath(target, cwd);
    let original: Lines = { lines: [], noEol: false };
    let fileExists = false;
    if (outputs.has(abs)) { original = toLines(outputs.get(abs)!); fileExists = true; }
    else {
      try { original = toLines(await fs.readFile(abs, 'utf8') as string); fileExists = true; } catch {}
    }
    const shownName = outputFile ? `${outputFile} (read from ${target})` : target;
    say(`${dryRun ? 'checking' : 'patching'} file ${shownName}\n`);

    let hunks = fp.hunks.map((h) => (reverse ? reverseHunk(h) : h));
    const work = original.lines.slice();
    let noEol = original.noEol;
    const rejects: Hunk[] = [];
    let delta = 0;
    let skipFile = false;

    const locate = (h: Hunk, startGuess: number, maxFuzz = fuzz): { pos: number; fuzz: number } | null => {
      const old = h.lines.filter((l) => l.op !== '+');
      if (!old.length) {
        // pure insertion: at its position
        const pos = Math.min(Math.max(h.oldStart === 0 ? 0 : startGuess, 0), work.length);
        return { pos, fuzz: 0 };
      }
      let lead = 0;
      while (lead < h.lines.length && h.lines[lead].op === ' ') lead++;
      let trail = 0;
      while (trail < h.lines.length && h.lines[h.lines.length - 1 - trail].op === ' ') trail++;
      for (let f = 0; f <= maxFuzz; f++) {
        const cutHead = Math.min(f, lead);
        const cutTail = Math.min(f, trail);
        // (with all context fuzzed away an insertion lands at its expected line, as in GNU patch)
        const pat = old.slice(cutHead, old.length - cutTail);
        const maxOff = work.length;
        for (let off = 0; off <= maxOff; off++) {
          for (const sign of off === 0 ? [1] : [-1, 1]) {
            const pos = startGuess + cutHead + sign * off;
            if (pos < 0 || pos + pat.length > work.length) continue;
            let ok = true;
            for (let k = 0; k < pat.length && ok; k++) ok = eq(work[pos + k], pat[k].text);
            if (ok) return { pos: pos - cutHead, fuzz: f };
          }
          if (startGuess - off < 0 && startGuess + off > work.length) break;
        }
      }
      return null;
    };

    for (let hi = 0; hi < hunks.length; hi++) {
      const h = hunks[hi];
      const guess = Math.max(0, (h.oldStart > 0 ? h.oldStart - 1 : 0) + delta);
      // Like GNU, the first hunk is checked for an already-applied patch before fuzzing
      let loc = locate(h, guess, hi === 0 ? 0 : fuzz);
      if (!loc && hi === 0) {
        // Already applied (or reversed)?
        const rv = reverseHunk(h);
        const rloc = locate(rv, guess);
        if (rloc && rloc.fuzz === 0) {
          if (forward) say('Reversed (or previously applied) patch detected!  Skipping patch.\n');
          else if (force) { /* apply anyway: falls through to failure */ }
          else say(`${reverse ? 'Unreversed' : 'Reversed'} (or previously applied) patch detected!  Assume -R? [n] \nApply anyway? [n] \nSkipping patch.\n`);
          if (!force) {
            skipFile = true;
            rejects.push(...fp.hunks);
            break;
          }
        }
        loc = locate(h, guess);
      }
      if (!loc) {
        say(`Hunk #${hi + 1} FAILED at ${h.oldStart}.\n`);
        rejects.push(fp.hunks[hi]);
        continue;
      }
      const old = h.lines.filter((l) => l.op !== '+');
      const repl = h.lines.filter((l) => l.op !== '-').map((l) => l.text);
      const at = loc.pos;
      const offset = at - guess;
      // a hunk touching the last line carries its newline state
      const touchesEnd = at + old.length >= work.length;
      // context lines stay as they are in the file (they may differ under fuzz)
      let w = at;
      for (const l of h.lines) {
        if (l.op === ' ') w++;
        else if (l.op === '-') work.splice(w, 1);
        else work.splice(w++, 0, l.text);
      }
      if (touchesEnd && (h.lines.some((l) => l.op !== ' ') || h.oldNoEol !== h.newNoEol)) noEol = h.newNoEol;
      delta += repl.length - old.length + offset;
      if (offset !== 0 || loc.fuzz) {
        let msg = `Hunk #${hi + 1} succeeded at ${at + 1}`;
        if (loc.fuzz) msg += ` with fuzz ${loc.fuzz}`;
        if (offset !== 0) msg += ` (offset ${offset} line${Math.abs(offset) === 1 ? '' : 's'})`;
        say(msg + '.\n');
      } else if (verbose) say(`Hunk #${hi + 1} succeeded at ${at + 1}.\n`);
    }

    if (rejects.length) {
      status = Math.max(status, 1);
      const rej = rejectFile ?? (outputFile ? outputFile : target) + '.rej';
      say(`${rejects.length} out of ${fp.hunks.length} hunk${fp.hunks.length === 1 ? '' : 's'} ${skipFile ? 'ignored' : 'FAILED'} -- saving rejects to file ${rej}\n`);
      if (!dryRun) {
        let rtext = '';
        if (fp.kind !== 'normal') rtext += `--- ${fp.oldName ?? target}\n+++ ${fp.newName ?? target}\n`;
        for (const h of rejects) {
          const oc = h.lines.filter((l) => l.op !== '+').length;
          const nc = h.lines.filter((l) => l.op !== '-').length;
          const r = (s: number, c: number) => (c === 1 ? `${s}` : `${c === 0 ? s : s},${c}`);
          rtext += `@@ -${r(h.oldStart, oc)} +${r(h.newStart, nc)} @@\n`;
          for (const l of h.lines) rtext += `${l.op}${l.text}\n`;
        }
        await fs.writeFile(fs.resolvePath(rej, cwd), rtext).catch(() => {});
      }
    }
    if (skipFile) continue;
    const result = fromLines({ lines: work, noEol });
    if (dryRun) continue;
    const dest = outputFile ? fs.resolvePath(outputFile, ctx.cwd) : abs;
    if (backup && fileExists && !outputFile) await fs.writeFile(abs + '.orig', fromLines(original)).catch(() => {});
    if (!outputFile && (deleting || (removeEmpty && result === '')) && work.length === 0) {
      await fs.unlink(abs).catch(() => {});
      outputs.delete(abs);
      continue;
    }
    try {
      const parent = dest.slice(0, dest.lastIndexOf('/')) || '/';
      if (!(await fs.stat(parent).catch(() => null))) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(dest, result);
      outputs.set(dest, result);
    } catch (e: any) {
      ctx.stderr += `patch: **** Can't create file ${outputFile ?? target} : ${e?.message ?? e}\n`;
      status = 2;
    }
  }
  ctx.stdout += out;
  return status;
}

function reverseHunk(h: Hunk): Hunk {
  return {
    oldStart: h.newStart,
    newStart: h.oldStart,
    lines: h.lines.map((l) => ({ op: l.op === '+' ? '-' : l.op === '-' ? '+' : ' ', text: l.text })),
    oldNoEol: h.newNoEol,
    newNoEol: h.oldNoEol,
  };
}
