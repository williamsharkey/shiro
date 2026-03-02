import { Command, CommandContext } from './index';

export const grepCmd: Command = {
  name: 'grep',
  description: 'Search for patterns in files',
  async exec(ctx: CommandContext) {
    let ignoreCase = false;
    let invertMatch = false;
    let lineNumbers = false;
    let countOnly = false;
    let filesOnly = false;
    let recursive = false;
    let onlyMatching = false;
    let wordMatch = false;
    let fixedStrings = false;
    let quiet = false;
    let wholeLineMatch = false;
    let maxCount = 0;
    let alwaysFilename = false;
    let neverFilename = false;
    let colorMode = 'never'; // 'always', 'auto', 'never'
    let beforeCtx = 0;
    let afterCtx = 0;
    let pattern = '';
    const files: string[] = [];
    const includeGlobs: string[] = [];
    const excludeGlobs: string[] = [];

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-i') { ignoreCase = true; }
      else if (arg === '-v') { invertMatch = true; }
      else if (arg === '-n') { lineNumbers = true; }
      else if (arg === '-c') { countOnly = true; }
      else if (arg === '-l') { filesOnly = true; }
      else if (arg === '-r' || arg === '-R') { recursive = true; }
      else if (arg === '-o') { onlyMatching = true; }
      else if (arg === '-w') { wordMatch = true; }
      else if (arg === '-F') { fixedStrings = true; }
      else if (arg === '-q') { quiet = true; }
      else if (arg === '-x') { wholeLineMatch = true; }
      else if (arg === '-H') { alwaysFilename = true; }
      else if (arg === '-h') { neverFilename = true; }
      else if (arg === '-e' && i + 1 < ctx.args.length) { pattern = ctx.args[++i]; }
      else if (arg === '-m' && i + 1 < ctx.args.length) { maxCount = parseInt(ctx.args[++i], 10) || 0; }
      else if (arg === '-A' && i + 1 < ctx.args.length) { afterCtx = parseInt(ctx.args[++i], 10) || 0; }
      else if (arg === '-B' && i + 1 < ctx.args.length) { beforeCtx = parseInt(ctx.args[++i], 10) || 0; }
      else if (arg === '-C' && i + 1 < ctx.args.length) { beforeCtx = afterCtx = parseInt(ctx.args[++i], 10) || 0; }
      else if (arg === '--color' || arg === '--color=always' || arg === '--colour' || arg === '--colour=always') { colorMode = 'always'; }
      else if (arg === '--color=auto' || arg === '--colour=auto') { colorMode = 'auto'; }
      else if (arg === '--color=never' || arg === '--colour=never') { colorMode = 'never'; }
      else if (arg === '--include' && i + 1 < ctx.args.length) { includeGlobs.push(ctx.args[++i]); }
      else if (arg.startsWith('--include=')) { includeGlobs.push(arg.slice('--include='.length)); }
      else if (arg === '--exclude' && i + 1 < ctx.args.length) { excludeGlobs.push(ctx.args[++i]); }
      else if (arg.startsWith('--exclude=')) { excludeGlobs.push(arg.slice('--exclude='.length)); }
      else if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
        // Combined flags like -in, or -A3 shorthand
        let j = 1;
        while (j < arg.length) {
          const ch = arg[j];
          if (ch === 'i') ignoreCase = true;
          else if (ch === 'v') invertMatch = true;
          else if (ch === 'n') lineNumbers = true;
          else if (ch === 'c') countOnly = true;
          else if (ch === 'l') filesOnly = true;
          else if (ch === 'r' || ch === 'R') recursive = true;
          else if (ch === 'o') onlyMatching = true;
          else if (ch === 'w') wordMatch = true;
          else if (ch === 'F') fixedStrings = true;
          else if (ch === 'q') quiet = true;
          else if (ch === 'x') wholeLineMatch = true;
          else if (ch === 'H') alwaysFilename = true;
          else if (ch === 'A' || ch === 'B' || ch === 'C' || ch === 'm') {
            const rest = arg.slice(j + 1);
            const num = rest ? parseInt(rest, 10) : (ctx.args[++i] ? parseInt(ctx.args[i], 10) : 0);
            if (ch === 'A') afterCtx = num || 0;
            else if (ch === 'B') beforeCtx = num || 0;
            else if (ch === 'C') { beforeCtx = afterCtx = num || 0; }
            else if (ch === 'm') { maxCount = num || 0; }
            break;
          }
          j++;
        }
      } else if (!pattern) {
        pattern = arg;
      } else {
        files.push(arg);
      }
      i++;
    }

    // Build include/exclude matchers
    const globToRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const includeRes = includeGlobs.map(globToRe);
    const excludeRes = excludeGlobs.map(globToRe);
    const matchesFileFilter = (name: string): boolean => {
      if (includeRes.length > 0 && !includeRes.some(re => re.test(name))) return false;
      if (excludeRes.length > 0 && excludeRes.some(re => re.test(name))) return false;
      return true;
    };

    if (!pattern) {
      ctx.stderr = 'grep: missing pattern\n';
      return 2;
    }

    // Build effective pattern
    let effectivePattern = pattern;
    if (fixedStrings) {
      effectivePattern = effectivePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (wordMatch) {
      effectivePattern = `\\b${effectivePattern}\\b`;
    }
    if (wholeLineMatch) {
      effectivePattern = `^${effectivePattern}$`;
    }

    const regexFlags = 'g' + (ignoreCase ? 'i' : '');
    let regex: RegExp;
    try {
      regex = new RegExp(effectivePattern, regexFlags);
    } catch {
      ctx.stderr = `grep: invalid pattern '${pattern}'\n`;
      return 2;
    }

    const useColor = colorMode === 'always';
    const hasContext = beforeCtx > 0 || afterCtx > 0;
    let found = false;

    const colorizeMatch = (line: string): string => {
      if (!useColor) return line;
      regex.lastIndex = 0;
      return line.replace(regex, (match) => `\x1b[1;31m${match}\x1b[0m`);
    };

    const searchFile = async (filePath: string, displayPath: string, multiFile: boolean) => {
      let content: string;
      try {
        content = await ctx.fs.readFile(filePath, 'utf8') as string;
      } catch {
        ctx.stderr += `grep: ${displayPath}: No such file or directory\n`;
        return;
      }
      // Skip binary files
      if (content.includes('\0')) return;

      const showFilename = (alwaysFilename || multiFile) && !neverFilename;
      const lines = content.split('\n');
      let matchCount = 0;

      if (hasContext && !countOnly && !filesOnly && !onlyMatching && !quiet) {
        // Two-pass context approach
        const matchedLineNums = new Set<number>();
        const contextLineNums = new Set<number>();

        for (let ln = 0; ln < lines.length; ln++) {
          if (maxCount > 0 && matchCount >= maxCount) break;
          regex.lastIndex = 0;
          const match = regex.test(lines[ln]);
          if (match !== invertMatch) {
            matchedLineNums.add(ln);
            matchCount++;
            for (let b = Math.max(0, ln - beforeCtx); b < ln; b++) contextLineNums.add(b);
            for (let a = ln + 1; a <= Math.min(lines.length - 1, ln + afterCtx); a++) contextLineNums.add(a);
          }
        }

        if (matchCount === 0) return;
        found = true;

        const allLineNums = new Set([...matchedLineNums, ...contextLineNums]);
        const sorted = [...allLineNums].sort((a, b) => a - b);
        let lastLn = -2;
        for (const ln of sorted) {
          if (lastLn >= 0 && ln > lastLn + 1) ctx.stdout += '--\n';
          const prefix = showFilename ? displayPath + ':' : '';
          const ctxSep = matchedLineNums.has(ln) ? ':' : '-';
          const lineNum = lineNumbers ? (ln + 1) + ctxSep : '';
          const text = matchedLineNums.has(ln) ? colorizeMatch(lines[ln]) : lines[ln];
          ctx.stdout += prefix + lineNum + text + '\n';
          lastLn = ln;
        }
        return;
      }

      for (let ln = 0; ln < lines.length; ln++) {
        if (maxCount > 0 && matchCount >= maxCount) break;
        regex.lastIndex = 0;
        const match = regex.test(lines[ln]);
        if (match !== invertMatch) {
          found = true;
          matchCount++;
          if (quiet) continue;
          if (filesOnly) {
            ctx.stdout += displayPath + '\n';
            return;
          }
          if (!countOnly) {
            const prefix = showFilename ? displayPath + ':' : '';
            const lineNum = lineNumbers ? (ln + 1) + ':' : '';
            if (onlyMatching && !invertMatch) {
              regex.lastIndex = 0;
              let m;
              while ((m = regex.exec(lines[ln])) !== null) {
                const matchText = useColor ? `\x1b[1;31m${m[0]}\x1b[0m` : m[0];
                ctx.stdout += prefix + lineNum + matchText + '\n';
                if (!regex.global) break;
              }
            } else {
              ctx.stdout += prefix + lineNum + colorizeMatch(lines[ln]) + '\n';
            }
          }
        }
      }
      if (countOnly && !quiet) {
        const prefix = showFilename ? displayPath + ':' : '';
        ctx.stdout += prefix + matchCount + '\n';
      }
    };

    const searchDir = async (dirPath: string) => {
      let entries: string[];
      try {
        entries = await ctx.fs.readdir(dirPath);
      } catch { return; }
      for (const entry of entries) {
        // Skip .git and node_modules
        if (entry === '.git' || entry === 'node_modules') continue;
        const childPath = dirPath === '/' ? '/' + entry : dirPath + '/' + entry;
        const stat = await ctx.fs.stat(childPath);
        if (stat.isDirectory()) {
          await searchDir(childPath);
        } else {
          if (!matchesFileFilter(entry)) continue;
          await searchFile(childPath, childPath, true);
        }
      }
    };

    if (files.length === 0 && !recursive) {
      // Read from stdin
      const stdinLines = ctx.stdin.split('\n');
      let matchCount = 0;
      for (let ln = 0; ln < stdinLines.length; ln++) {
        if (maxCount > 0 && matchCount >= maxCount) break;
        regex.lastIndex = 0;
        const match = regex.test(stdinLines[ln]);
        if (match !== invertMatch) {
          found = true;
          matchCount++;
          if (quiet) continue;
          if (!countOnly) {
            const lineNum = lineNumbers ? (ln + 1) + ':' : '';
            if (onlyMatching && !invertMatch) {
              regex.lastIndex = 0;
              let m;
              while ((m = regex.exec(stdinLines[ln])) !== null) {
                const matchText = useColor ? `\x1b[1;31m${m[0]}\x1b[0m` : m[0];
                ctx.stdout += lineNum + matchText + '\n';
                if (!regex.global) break;
              }
            } else {
              ctx.stdout += lineNum + colorizeMatch(stdinLines[ln]) + '\n';
            }
          }
        }
      }
      if (countOnly && !quiet) ctx.stdout += matchCount + '\n';
    } else if (recursive && files.length === 0) {
      await searchDir(ctx.cwd);
    } else {
      const multiFile = files.length > 1 || recursive;
      for (const f of files) {
        const resolved = ctx.fs.resolvePath(f, ctx.cwd);
        const stat = await ctx.fs.stat(resolved).catch(() => null);
        if (stat?.isDirectory() && recursive) {
          await searchDir(resolved);
        } else if (stat?.isDirectory()) {
          ctx.stderr += `grep: ${f}: Is a directory\n`;
        } else {
          await searchFile(resolved, f, multiFile || alwaysFilename);
        }
      }
    }

    return found ? 0 : 1;
  },
};
