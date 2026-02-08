import { Command, CommandContext } from './index';

/**
 * rg: ripgrep-compatible search command
 *
 * Claude Code's Grep tool depends on this. Searches recursively by default.
 * Supports the most common ripgrep flags that Claude Code actually uses.
 */
export const rgCmd: Command = {
  name: 'rg',
  description: 'Recursively search for a pattern in files (ripgrep)',
  async exec(ctx: CommandContext) {
    let ignoreCase = false;
    let invertMatch = false;
    let lineNumbers = true; // rg shows line numbers by default
    let countOnly = false;
    let filesOnly = false;
    let wordMatch = false;
    let onlyMatching = false;
    let fixedStrings = false;
    let noFilename = false;
    let forceFilename = false;
    let hidden = false;
    let afterCtx = 0, beforeCtx = 0;
    let pattern = '';
    const paths: string[] = [];
    const typeFilters: string[] = [];
    const globFilters: string[] = [];

    // File type → extensions mapping (subset of rg's built-in types)
    const typeMap: Record<string, string[]> = {
      js: ['.js', '.mjs', '.cjs'],
      ts: ['.ts', '.tsx', '.mts', '.cts'],
      py: ['.py', '.pyi'],
      rust: ['.rs'],
      go: ['.go'],
      java: ['.java'],
      c: ['.c', '.h'],
      cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.h'],
      css: ['.css', '.scss', '.less'],
      html: ['.html', '.htm'],
      json: ['.json'],
      yaml: ['.yaml', '.yml'],
      toml: ['.toml'],
      md: ['.md', '.markdown'],
      sh: ['.sh', '.bash', '.zsh'],
      xml: ['.xml'],
      sql: ['.sql'],
      ruby: ['.rb'],
      php: ['.php'],
      swift: ['.swift'],
      kotlin: ['.kt', '.kts'],
    };

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '--') { i++; while (i < ctx.args.length) paths.push(ctx.args[i++]); break; }
      if (arg === '-i' || arg === '--ignore-case') { ignoreCase = true; }
      else if (arg === '-v' || arg === '--invert-match') { invertMatch = true; }
      else if (arg === '-n' || arg === '--line-number') { lineNumbers = true; }
      else if (arg === '-N' || arg === '--no-line-number') { lineNumbers = false; }
      else if (arg === '-c' || arg === '--count') { countOnly = true; }
      else if (arg === '-l' || arg === '--files-with-matches') { filesOnly = true; }
      else if (arg === '-w' || arg === '--word-regexp') { wordMatch = true; }
      else if (arg === '-o' || arg === '--only-matching') { onlyMatching = true; }
      else if (arg === '-F' || arg === '--fixed-strings') { fixedStrings = true; }
      else if (arg === '--no-filename') { noFilename = true; }
      else if (arg === '--with-filename' || arg === '-H') { forceFilename = true; }
      else if (arg === '--hidden') { hidden = true; }
      else if (arg === '--no-heading') { /* default behavior */ }
      else if (arg === '--heading') { /* ignore for now */ }
      else if (arg === '-e' && i + 1 < ctx.args.length) { pattern = ctx.args[++i]; }
      else if (arg === '-t' || arg === '--type') {
        if (i + 1 < ctx.args.length) typeFilters.push(ctx.args[++i]);
      } else if (arg.startsWith('--type=')) {
        typeFilters.push(arg.slice(7));
      } else if (arg === '-g' || arg === '--glob') {
        if (i + 1 < ctx.args.length) globFilters.push(ctx.args[++i]);
      } else if (arg.startsWith('--glob=')) {
        globFilters.push(arg.slice(7));
      } else if (arg === '-A' || arg === '--after-context') {
        if (i + 1 < ctx.args.length) afterCtx = parseInt(ctx.args[++i], 10) || 0;
      } else if (arg.startsWith('-A') && /^-A\d+$/.test(arg)) {
        afterCtx = parseInt(arg.slice(2), 10) || 0;
      } else if (arg === '-B' || arg === '--before-context') {
        if (i + 1 < ctx.args.length) beforeCtx = parseInt(ctx.args[++i], 10) || 0;
      } else if (arg.startsWith('-B') && /^-B\d+$/.test(arg)) {
        beforeCtx = parseInt(arg.slice(2), 10) || 0;
      } else if (arg === '-C' || arg === '--context') {
        if (i + 1 < ctx.args.length) { const c = parseInt(ctx.args[++i], 10) || 0; afterCtx = beforeCtx = c; }
      } else if (arg.startsWith('-C') && /^-C\d+$/.test(arg)) {
        afterCtx = beforeCtx = parseInt(arg.slice(2), 10) || 0;
      } else if (arg === '--help' || arg === '-h') {
        ctx.stdout = 'Usage: rg [OPTIONS] PATTERN [PATH...]\n\nOptions:\n  -i          Case insensitive\n  -v          Invert match\n  -n/-N       Show/hide line numbers\n  -c          Count matches\n  -l          Files with matches only\n  -w          Word match\n  -o          Only matching text\n  -F          Fixed strings (no regex)\n  -t TYPE     File type (js, ts, py, etc.)\n  -g GLOB     Glob filter\n  -A/-B/-C N  Context lines\n  -e PATTERN  Pattern\n  --hidden    Search hidden files\n';
        return 0;
      } else if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
        // Combined short flags like -in
        for (const ch of arg.slice(1)) {
          if (ch === 'i') ignoreCase = true;
          else if (ch === 'v') invertMatch = true;
          else if (ch === 'n') lineNumbers = true;
          else if (ch === 'N') lineNumbers = false;
          else if (ch === 'c') countOnly = true;
          else if (ch === 'l') filesOnly = true;
          else if (ch === 'w') wordMatch = true;
          else if (ch === 'o') onlyMatching = true;
          else if (ch === 'F') fixedStrings = true;
          else if (ch === 'H') forceFilename = true;
        }
      } else if (!pattern) {
        pattern = arg;
      } else {
        paths.push(arg);
      }
      i++;
    }

    if (!pattern) {
      ctx.stderr = 'rg: no pattern given\n';
      return 2;
    }

    // Build regex
    let patternStr = fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    if (wordMatch) patternStr = `\\b${patternStr}\\b`;
    const flags = ignoreCase ? 'gi' : 'g';
    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, flags);
    } catch {
      ctx.stderr = `rg: invalid regex '${pattern}'\n`;
      return 2;
    }

    // Build allowed extensions from type filters
    const allowedExts = new Set<string>();
    for (const t of typeFilters) {
      const exts = typeMap[t];
      if (exts) exts.forEach(e => allowedExts.add(e));
      else { ctx.stderr += `rg: unknown file type: ${t}\n`; }
    }

    // Glob matchers
    const globMatchers = globFilters.map(g => {
      const neg = g.startsWith('!');
      const pat = neg ? g.slice(1) : g;
      const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*').replace(/\?/g, '.') + '$');
      return { re, neg };
    });

    const matchesFilters = (filePath: string): boolean => {
      const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
      if (allowedExts.size > 0 && !allowedExts.has(ext)) return false;
      for (const { re, neg } of globMatchers) {
        if (neg && re.test(filePath)) return false;
        if (!neg && !re.test(filePath)) return false;
      }
      return true;
    };

    let found = false;
    const searchPaths = paths.length > 0 ? paths : [ctx.cwd];
    const multiFile = true; // rg always shows filenames by default
    const showFilename = !noFilename && (forceFilename || multiFile);

    const searchFile = async (filePath: string, displayPath: string) => {
      if (!matchesFilters(displayPath)) return;
      let content: string;
      try {
        content = await ctx.fs.readFile(filePath, 'utf8') as string;
      } catch { return; }
      // Skip binary files (check for null bytes)
      if (content.includes('\0')) return;

      const lines = content.split('\n');
      let matchCount = 0;
      const matchedLineNums = new Set<number>();
      const contextLineNums = new Set<number>();

      // First pass: find matching lines
      for (let ln = 0; ln < lines.length; ln++) {
        regex.lastIndex = 0;
        const match = regex.test(lines[ln]);
        if (match !== invertMatch) {
          matchedLineNums.add(ln);
          matchCount++;
          // Add context lines
          for (let b = Math.max(0, ln - beforeCtx); b < ln; b++) contextLineNums.add(b);
          for (let a = ln + 1; a <= Math.min(lines.length - 1, ln + afterCtx); a++) contextLineNums.add(a);
        }
      }

      if (matchCount === 0) return;
      found = true;

      if (filesOnly) {
        ctx.stdout += displayPath + '\n';
        return;
      }
      if (countOnly) {
        ctx.stdout += (showFilename ? displayPath + ':' : '') + matchCount + '\n';
        return;
      }

      // Output matched and context lines
      const allLineNums = new Set([...matchedLineNums, ...contextLineNums]);
      const sorted = [...allLineNums].sort((a, b) => a - b);
      let lastLn = -2;
      for (const ln of sorted) {
        if (lastLn >= 0 && ln > lastLn + 1) ctx.stdout += '--\n'; // separator
        const prefix = showFilename ? displayPath + ':' : '';
        const lineNum = lineNumbers ? (ln + 1) + ':' : '';
        const sep = matchedLineNums.has(ln) ? '' : '';
        if (onlyMatching && matchedLineNums.has(ln)) {
          regex.lastIndex = 0;
          let m;
          while ((m = regex.exec(lines[ln])) !== null) {
            ctx.stdout += prefix + lineNum + m[0] + '\n';
            if (!regex.global) break;
          }
        } else {
          const ctxSep = matchedLineNums.has(ln) ? ':' : '-';
          const lineNumStr = lineNumbers ? (ln + 1) + ctxSep : '';
          ctx.stdout += prefix + lineNumStr + lines[ln] + '\n';
        }
        lastLn = ln;
      }
    };

    const searchDir = async (dirPath: string, basePath: string) => {
      let entries: string[];
      try {
        entries = await ctx.fs.readdir(dirPath);
      } catch { return; }
      for (const entry of entries) {
        if (!hidden && entry.startsWith('.')) continue;
        if (entry === 'node_modules' || entry === '.git') continue;
        const childPath = dirPath === '/' ? '/' + entry : dirPath + '/' + entry;
        const displayPath = basePath ? basePath + '/' + entry : entry;
        try {
          const stat = await ctx.fs.stat(childPath);
          if (stat.isDirectory()) {
            await searchDir(childPath, displayPath);
          } else {
            await searchFile(childPath, displayPath);
          }
        } catch { /* skip */ }
      }
    };

    for (const p of searchPaths) {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      try {
        const stat = await ctx.fs.stat(resolved);
        if (stat.isDirectory()) {
          await searchDir(resolved, paths.length > 0 ? p : '');
        } else {
          const display = paths.length > 0 ? p : resolved;
          await searchFile(resolved, display);
        }
      } catch {
        ctx.stderr += `rg: ${p}: No such file or directory\n`;
      }
    }

    return found ? 0 : 1;
  },
};
