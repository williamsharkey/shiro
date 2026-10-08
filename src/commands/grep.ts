import { Command, CommandContext } from './index';
import { posixToJsSource } from '../utils/posix-regex';

/**
 * grep, following GNU grep: BRE by default (-E ERE, -F fixed strings, -P
 * JavaScript/Perl-ish), several patterns (-e, -f, newlines), -i -v -w -x -c
 * -l -L -o -q -s -n -h -H -m -A/-B/-C -r/-R --include/--exclude/--exclude-dir
 * --color. Exit status 0 when a line is selected, 1 when none, 2 on error.
 */
export const grepCmd: Command = {
  name: 'grep',
  description: 'Search for patterns in files',
  async exec(ctx: CommandContext) {
    let mode: 'G' | 'E' | 'F' | 'P' = 'G';
    let ignoreCase = false, invertMatch = false, lineNumbers = false, countOnly = false;
    let filesWith = false, filesWithout = false, recursive = false, onlyMatching = false;
    let wordMatch = false, wholeLine = false, quiet = false, silentErrors = false;
    let maxCount = -1, beforeCtx = 0, afterCtx = 0;
    let withFilename: boolean | null = null;
    let colorMode = 'never';
    let textMode = false;
    let label = '(standard input)';
    const patterns: string[] = [];
    let patternGiven = false;
    const files: string[] = [];
    const includeGlobs: string[] = [];
    const excludeGlobs: string[] = [];
    const excludeDirGlobs: string[] = [];
    let status2 = false;
    const error = (msg: string) => { status2 = true; if (!silentErrors) ctx.stderr += `grep: ${msg}\n`; };

    const args = ctx.args;
    let i = 0;
    let noMoreOptions = false;
    const needArg = (opt: string): string | null => {
      if (i + 1 < args.length) return args[++i];
      ctx.stderr += `grep: option requires an argument -- '${opt}'\n`;
      return null;
    };
    const readPatternFile = async (f: string): Promise<boolean> => {
      try {
        const text = f === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string;
        // An empty file has no patterns, so nothing matches
        const lines = text === '' ? [] : text.split('\n');
        if (text.endsWith('\n')) lines.pop();
        patterns.push(...lines);
        patternGiven = true;
        return true;
      } catch {
        ctx.stderr += `grep: ${f}: No such file or directory\n`;
        return false;
      }
    };
    const LONG_FLAGS: Record<string, () => void> = {
      '--extended-regexp': () => { mode = 'E'; }, '--fixed-strings': () => { mode = 'F'; },
      '--basic-regexp': () => { mode = 'G'; }, '--perl-regexp': () => { mode = 'P'; },
      '--ignore-case': () => { ignoreCase = true; }, '--no-ignore-case': () => { ignoreCase = false; },
      '--invert-match': () => { invertMatch = true; }, '--word-regexp': () => { wordMatch = true; },
      '--line-regexp': () => { wholeLine = true; }, '--count': () => { countOnly = true; },
      '--files-with-matches': () => { filesWith = true; }, '--files-without-match': () => { filesWithout = true; },
      '--only-matching': () => { onlyMatching = true; }, '--quiet': () => { quiet = true; }, '--silent': () => { quiet = true; },
      '--no-messages': () => { silentErrors = true; }, '--line-number': () => { lineNumbers = true; },
      '--with-filename': () => { withFilename = true; }, '--no-filename': () => { withFilename = false; },
      '--recursive': () => { recursive = true; }, '--dereference-recursive': () => { recursive = true; },
      '--text': () => { textMode = true; }, '--line-buffered': () => {}, '--color': () => { colorMode = 'always'; },
      '--colour': () => { colorMode = 'always'; },
    };
    while (i < args.length) {
      const arg = args[i];
      if (noMoreOptions || !arg.startsWith('-') || arg === '-') {
        if (!patternGiven) { patterns.push(...arg.split('\n')); patternGiven = true; }
        else files.push(arg);
        i++;
        continue;
      }
      if (arg === '--') { noMoreOptions = true; i++; continue; }
      if (arg.startsWith('--')) {
        const eq = arg.indexOf('=');
        const name = eq > 0 ? arg.slice(0, eq) : arg;
        const val = eq > 0 ? arg.slice(eq + 1) : null;
        const takeVal = (): string | null => (val !== null ? val : (i + 1 < args.length ? args[++i] : null));
        if (LONG_FLAGS[name] && (val === null || name === '--color' || name === '--colour')) {
          if ((name === '--color' || name === '--colour') && val !== null) colorMode = val === 'auto' ? 'auto' : val === 'never' ? 'never' : 'always';
          else LONG_FLAGS[name]();
        } else if (name === '--regexp') { const v = takeVal(); if (v === null) return 2; patterns.push(...v.split('\n')); patternGiven = true; }
        else if (name === '--file') { const v = takeVal(); if (v === null || !(await readPatternFile(v))) return 2; }
        else if (name === '--max-count') { maxCount = parseInt(takeVal() ?? '0', 10); }
        else if (name === '--after-context') { afterCtx = parseInt(takeVal() ?? '0', 10) || 0; }
        else if (name === '--before-context') { beforeCtx = parseInt(takeVal() ?? '0', 10) || 0; }
        else if (name === '--context') { beforeCtx = afterCtx = parseInt(takeVal() ?? '0', 10) || 0; }
        else if (name === '--include') { includeGlobs.push(takeVal() ?? ''); }
        else if (name === '--exclude') { excludeGlobs.push(takeVal() ?? ''); }
        else if (name === '--exclude-dir') { excludeDirGlobs.push(takeVal() ?? ''); }
        else if (name === '--label') { label = takeVal() ?? label; }
        else if (name === '--binary-files' || name === '--devices' || name === '--directories') { takeVal(); }
        else { ctx.stderr += `grep: unrecognized option '${arg}'\n`; return 2; }
        i++;
        continue;
      }
      // Short options, possibly combined (-inr, -A3, -e PAT, -epat)
      for (let j = 1; j < arg.length; j++) {
        const ch = arg[j];
        const rest = arg.slice(j + 1);
        const value = (): string | null => (rest ? rest : needArg(ch));
        switch (ch) {
          case 'E': mode = 'E'; continue;
          case 'F': mode = 'F'; continue;
          case 'G': mode = 'G'; continue;
          case 'P': mode = 'P'; continue;
          case 'i': case 'y': ignoreCase = true; continue;
          case 'v': invertMatch = true; continue;
          case 'n': lineNumbers = true; continue;
          case 'c': countOnly = true; continue;
          case 'l': filesWith = true; continue;
          case 'L': filesWithout = true; continue;
          case 'r': case 'R': recursive = true; continue;
          case 'o': onlyMatching = true; continue;
          case 'w': wordMatch = true; continue;
          case 'x': wholeLine = true; continue;
          case 'q': quiet = true; continue;
          case 's': silentErrors = true; continue;
          case 'H': withFilename = true; continue;
          case 'h': withFilename = false; continue;
          case 'a': textMode = true; continue;
          case 'I': case 'U': case 'Z': case 'z': case 'b': case 'u': continue;
          case 'e': { const v = value(); if (v === null) return 2; patterns.push(...v.split('\n')); patternGiven = true; j = arg.length; continue; }
          case 'f': { const v = value(); if (v === null || !(await readPatternFile(v))) return 2; j = arg.length; continue; }
          case 'm': { const v = value(); maxCount = parseInt(v ?? '0', 10); j = arg.length; continue; }
          case 'A': case 'B': case 'C': {
            const v = parseInt(value() ?? '0', 10) || 0;
            if (ch !== 'B') afterCtx = v;
            if (ch !== 'A') beforeCtx = v;
            j = arg.length;
            continue;
          }
          default:
            if (/\d/.test(ch)) { beforeCtx = afterCtx = parseInt(arg.slice(j), 10); j = arg.length; continue; }
            ctx.stderr += `grep: invalid option -- '${ch}'\n`;
            return 2;
        }
      }
      i++;
    }
    if (!patternGiven) {
      ctx.stderr += 'Usage: grep [OPTION]... PATTERNS [FILE]...\n';
      return 2;
    }

    // One RegExp for all patterns
    const toSource = (p: string): string => {
      if (mode === 'F') return p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      if (mode === 'P') return p;
      return posixToJsSource(p, { extended: mode === 'E' });
    };
    let regex: RegExp;
    try {
      const alts = patterns.map((p) => {
        let s = toSource(p);
        if (wordMatch) s = `(?<![\\w])(?:${s})(?![\\w])`;
        if (wholeLine) s = `^(?:${s})$`;
        return s;
      });
      const source = alts.length === 0 ? '(?!)' : alts.length === 1 ? alts[0] : alts.map((a) => `(?:${a})`).join('|');
      regex = new RegExp(source, 'g' + (ignoreCase ? 'i' : ''));
    } catch (e: any) {
      ctx.stderr += `grep: ${e.message}\n`;
      return 2;
    }

    const useColor = colorMode === 'always';
    const matches = (line: string): boolean => { regex.lastIndex = 0; return regex.test(line); };
    const colorize = (line: string) => {
      if (!useColor) return line;
      regex.lastIndex = 0;
      return line.replace(regex, (m) => (m ? `\x1b[1;31m${m}\x1b[0m` : m));
    };
    const hasContext = (beforeCtx > 0 || afterCtx > 0) && !countOnly && !filesWith && !filesWithout && !onlyMatching && !quiet;

    let anySelected = false;
    let listedWithout = false;
    let showNames = false;
    let printedAny = false; // context output so far, for `--` between groups (across files too)

    /** Search one input; returns true if a line was selected */
    const searchText = (content: string, name: string): boolean => {
      const binary = !textMode && content.includes('\0');
      const lines = content.split('\n');
      if (content.endsWith('\n')) lines.pop();
      const prefix = (ln: number, sep: string) => (showNames ? name + sep : '') + (lineNumbers ? (ln + 1) + sep : '');
      let count = 0;
      let lastPrinted = -1;
      let afterLeft = 0;
      for (let ln = 0; ln < lines.length; ln++) {
        if (maxCount >= 0 && count >= maxCount) {
          // GNU still prints trailing context after the last match
          if (afterLeft > 0 && hasContext) { ctx.stdout += prefix(ln, '-') + lines[ln] + '\n'; lastPrinted = ln; afterLeft--; continue; }
          break;
        }
        const selected = matches(lines[ln]) !== invertMatch;
        if (!selected) {
          if (hasContext && afterLeft > 0) {
            ctx.stdout += prefix(ln, '-') + lines[ln] + '\n';
            lastPrinted = ln;
            afterLeft--;
          }
          continue;
        }
        count++;
        anySelected = true;
        if (quiet || filesWith || filesWithout) { if (quiet || filesWith) break; continue; }
        if (countOnly) continue;
        if (binary) { ctx.stdout += `Binary file ${name} matches\n`; break; }
        if (hasContext) {
          const from = Math.max(0, ln - beforeCtx, lastPrinted + 1);
          if (printedAny && (lastPrinted < 0 || from > lastPrinted + 1)) ctx.stdout += '--\n';
          for (let b = from; b < ln; b++) ctx.stdout += prefix(b, '-') + lines[b] + '\n';
          ctx.stdout += prefix(ln, ':') + colorize(lines[ln]) + '\n';
          lastPrinted = ln;
          afterLeft = afterCtx;
          printedAny = true;
          continue;
        }
        if (onlyMatching) {
          if (invertMatch) continue;
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(lines[ln])) !== null) {
            // Empty matches print nothing (and must not stall the scan)
            if (m[0] === '') { regex.lastIndex++; continue; }
            ctx.stdout += prefix(ln, ':') + (useColor ? `\x1b[1;31m${m[0]}\x1b[0m` : m[0]) + '\n';
          }
          continue;
        }
        ctx.stdout += prefix(ln, ':') + colorize(lines[ln]) + '\n';
      }
      if (countOnly && !quiet) ctx.stdout += (showNames ? name + ':' : '') + count + '\n';
      if (filesWith && count > 0 && !quiet) ctx.stdout += name + '\n';
      if (filesWithout && count === 0) { listedWithout = true; if (!quiet) ctx.stdout += name + '\n'; }
      return count > 0;
    };

    const globToRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const includeRes = includeGlobs.map(globToRe);
    const excludeRes = excludeGlobs.map(globToRe);
    const excludeDirRes = excludeDirGlobs.map(globToRe);
    const fileWanted = (base: string) =>
      (includeRes.length === 0 || includeRes.some((re) => re.test(base))) && !excludeRes.some((re) => re.test(base));

    const searchPath = async (path: string, display: string, top: boolean): Promise<void> => {
      if (quiet && anySelected) return;
      const resolved = ctx.fs.resolvePath(path, ctx.cwd);
      const st = await ctx.fs.stat(resolved).catch(() => null);
      if (!st) { error(`${display}: No such file or directory`); return; }
      if (st.isDirectory()) {
        if (!recursive) { error(`${display}: Is a directory`); return; }
        const base = display.replace(/\/+$/, '').split('/').pop() || display;
        if (!top && (base === '.git' || base === 'node_modules' || excludeDirRes.some((re) => re.test(base)))) return;
        const entries = (await ctx.fs.readdir(resolved).catch(() => [] as string[])).slice().sort();
        for (const e of entries) {
          await searchPath(`${resolved === '/' ? '' : resolved}/${e}`, display === '.' && !top ? e : `${display.replace(/\/+$/, '')}/${e}`, false);
        }
        return;
      }
      const base = display.split('/').pop() || display;
      if (!top && !fileWanted(base)) return;
      if (top && recursive && includeRes.length && !fileWanted(base)) return;
      let content: string;
      try {
        content = await ctx.fs.readFile(resolved, 'utf8') as string;
      } catch {
        error(`${display}: Permission denied`);
        return;
      }
      searchText(content, display);
    };

    if (files.length === 0) {
      if (recursive) {
        // `grep -r PAT` searches the working directory, naming files relative to it
        showNames = withFilename ?? true;
        const entries = (await ctx.fs.readdir(ctx.cwd).catch(() => [] as string[])).slice().sort();
        for (const e of entries) await searchPath(e, e, false);
      } else {
        showNames = withFilename ?? false;
        searchText(ctx.stdin, label);
      }
    } else {
      showNames = withFilename ?? (files.length > 1 || recursive);
      for (const f of files) {
        if (quiet && anySelected) break;
        if (f === '-') searchText(ctx.stdin, label);
        else await searchPath(f, f, true);
      }
    }

    if (quiet && anySelected) return 0;
    if (status2) return 2;
    if (filesWithout) return listedWithout ? 0 : 1;
    return anySelected ? 0 : 1;
  },
};

/** egrep / fgrep: grep -E / grep -F */
export const egrepCmd: Command = {
  name: 'egrep',
  description: 'grep -E',
  exec: (ctx) => { ctx.args = ['-E', ...ctx.args]; return grepCmd.exec(ctx); },
};
export const fgrepCmd: Command = {
  name: 'fgrep',
  description: 'grep -F',
  exec: (ctx) => { ctx.args = ['-F', ...ctx.args]; return grepCmd.exec(ctx); },
};
