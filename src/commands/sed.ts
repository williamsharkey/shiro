import { Command, CommandContext } from './index';

export const sedCmd: Command = {
  name: 'sed',
  description: 'Stream editor for filtering and transforming text',
  async exec(ctx: CommandContext) {
    let inPlace = false;
    let suppressDefault = false;
    const expressions: string[] = [];
    const files: string[] = [];

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-i') {
        inPlace = true;
      } else if (arg === '-n') {
        suppressDefault = true;
      } else if (arg === '-e' && i + 1 < ctx.args.length) {
        expressions.push(ctx.args[++i]);
      } else if (expressions.length === 0 && !arg.startsWith('-')) {
        expressions.push(arg);
      } else if (expressions.length > 0 && !arg.startsWith('-')) {
        files.push(arg);
      } else if (arg.startsWith('-') && arg !== '-') {
        for (const ch of arg.slice(1)) {
          if (ch === 'n') suppressDefault = true;
          else if (ch === 'i') inPlace = true;
        }
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
      i++;
    }

    if (expressions.length === 0) {
      ctx.stderr = 'sed: no expression provided\n';
      return 1;
    }

    const commands: SedCommand[] = [];
    for (const expr of expressions) {
      commands.push(...parseSedExpression(expr));
    }

    const processContent = (content: string): string => {
      const lines = content.split('\n');
      const result: string[] = [];
      let holdSpace = '';
      let quit = false;

      // Range tracking for regex ranges
      const rangeActive = new Map<number, boolean>();

      for (let lineNum = 0; lineNum < lines.length && !quit; lineNum++) {
        let current = lines[lineNum];
        let deleted = false;
        let printed = false;
        let skipToNext = false;

        const insertBefore: string[] = [];
        const appendAfter: string[] = [];

        for (let ci = 0; ci < commands.length && !deleted && !skipToNext && !quit; ci++) {
          const cmd = commands[ci];

          // Check address match (with range state tracking)
          if (!addressMatchesWithState(cmd.address, current, lineNum + 1, lines.length, rangeActive, ci)) continue;

          switch (cmd.type) {
            case 's':
              current = current.replace(cmd.regex!, cmd.replacement!);
              break;
            case 'd':
              deleted = true;
              break;
            case 'p':
              printed = true;
              break;
            case 'i':
              insertBefore.push(cmd.text!);
              break;
            case 'a':
              appendAfter.push(cmd.text!);
              break;
            case 'c':
              // Replace entire line with text
              current = cmd.text!;
              deleted = true;
              result.push(current);
              break;
            case 'y': {
              // Transliterate
              const from = cmd.from!;
              const to = cmd.to!;
              let out = '';
              for (const ch of current) {
                const idx = from.indexOf(ch);
                out += idx >= 0 ? to[idx] : ch;
              }
              current = out;
              break;
            }
            case 'q':
              if (!suppressDefault) result.push(current);
              quit = true;
              break;
            case '=':
              result.push(String(lineNum + 1));
              break;
            case 'h':
              holdSpace = current;
              break;
            case 'H':
              holdSpace += '\n' + current;
              break;
            case 'g':
              current = holdSpace;
              break;
            case 'G':
              current += '\n' + holdSpace;
              break;
            case 'x': {
              const tmp = current;
              current = holdSpace;
              holdSpace = tmp;
              break;
            }
            case 'n':
              // Print current, read next
              if (!suppressDefault) result.push(current);
              lineNum++;
              if (lineNum < lines.length) {
                current = lines[lineNum];
              } else {
                deleted = true;
              }
              break;
            case 'N':
              // Append next line to pattern space
              lineNum++;
              if (lineNum < lines.length) {
                current += '\n' + lines[lineNum];
              }
              break;
            case 'w':
              // Write to file (tracked in output for now)
              if (cmd.text) {
                // We can't easily write to fs in sync context, so we collect
                appendAfter.push(''); // noop for file writing
              }
              break;
            case 'b':
              // Branch to label (or end of script)
              if (cmd.label) {
                const target = commands.findIndex(c => c.type === ':' && c.label === cmd.label);
                if (target >= 0) { ci = target; continue; }
              }
              skipToNext = true;
              break;
            case 't':
              // Branch if substitution was made on this line
              // Simplified: just branch to end
              skipToNext = true;
              break;
            case ':':
              // Label — noop during execution
              break;
            case 'noop':
              break;
          }
        }

        if (quit) break;

        result.push(...insertBefore);

        if (!deleted) {
          if (!suppressDefault) {
            result.push(current);
          }
          if (printed) {
            result.push(current);
          }
        }

        result.push(...appendAfter);
      }

      return result.join('\n');
    };

    if (files.length === 0) {
      ctx.stdout = processContent(ctx.stdin);
      return 0;
    }

    for (const f of files) {
      const resolved = ctx.fs.resolvePath(f, ctx.cwd);
      try {
        const content = await ctx.fs.readFile(resolved, 'utf8') as string;
        const result = processContent(content);
        if (inPlace) {
          await ctx.fs.writeFile(resolved, result);
        } else {
          ctx.stdout += result;
        }
      } catch (e: any) {
        ctx.stderr += `sed: ${f}: ${e.message}\n`;
        return 1;
      }
    }

    return 0;
  },
};

interface SedCommand {
  type: string;
  regex?: RegExp;
  replacement?: string;
  text?: string;
  from?: string;
  to?: string;
  label?: string;
  address?: SedAddress;
}

type SedAddress = { type: 'line'; n: number }
  | { type: 'last' }
  | { type: 'regex'; re: RegExp }
  | { type: 'range'; start: SedAddress; end: SedAddress };

function addressMatches(
  addr: SedAddress | undefined,
  line: string,
  lineNum: number,
  totalLines: number,
): boolean {
  if (!addr) return true;
  if (addr.type === 'line') return lineNum === addr.n;
  if (addr.type === 'last') return lineNum === totalLines;
  if (addr.type === 'regex') return addr.re.test(line);
  if (addr.type === 'range') {
    return addressMatches(addr.start, line, lineNum, totalLines)
      || addressMatches(addr.end, line, lineNum, totalLines)
      || (resolveLineNum(addr.start, lineNum, totalLines) <= lineNum
        && lineNum <= resolveLineNum(addr.end, lineNum, totalLines));
  }
  return true;
}

function addressMatchesWithState(
  addr: SedAddress | undefined,
  line: string,
  lineNum: number,
  totalLines: number,
  rangeActive: Map<number, boolean>,
  cmdIdx: number,
): boolean {
  if (!addr) return true;
  if (addr.type !== 'range') return addressMatches(addr, line, lineNum, totalLines);

  // Handle ranges with regex endpoints
  const active = rangeActive.get(cmdIdx) || false;
  if (!active) {
    // Check if start matches
    if (addressMatches(addr.start, line, lineNum, totalLines)) {
      rangeActive.set(cmdIdx, true);
      return true;
    }
    return false;
  } else {
    // Already in range — check if end matches
    if (addressMatches(addr.end, line, lineNum, totalLines)) {
      rangeActive.set(cmdIdx, false);
    }
    return true;
  }
}

function resolveLineNum(addr: SedAddress, _currentLine: number, totalLines: number): number {
  if (addr.type === 'line') return addr.n;
  if (addr.type === 'last') return totalLines;
  return -1;
}

function parseAddress(str: string): { addr: SedAddress; rest: string } | null {
  // Range with regex: /pat1/,/pat2/
  const regexRangeMatch = str.match(/^\/((?:[^/\\]|\\.)*)\/(.*)/);
  if (regexRangeMatch) {
    const startAddr: SedAddress = { type: 'regex', re: new RegExp(regexRangeMatch[1]) };
    let rest = regexRangeMatch[2];
    if (rest.startsWith(',')) {
      rest = rest.slice(1);
      const endRegex = rest.match(/^\/((?:[^/\\]|\\.)*)\/(.*)/);
      if (endRegex) {
        const endAddr: SedAddress = { type: 'regex', re: new RegExp(endRegex[1]) };
        return { addr: { type: 'range', start: startAddr, end: endAddr }, rest: endRegex[2] };
      }
      const endLine = rest.match(/^(\d+|\$)(.*)/);
      if (endLine) {
        const endAddr: SedAddress = endLine[1] === '$' ? { type: 'last' } : { type: 'line', n: parseInt(endLine[1], 10) };
        return { addr: { type: 'range', start: startAddr, end: endAddr }, rest: endLine[2] };
      }
    }
    return { addr: startAddr, rest };
  }

  // Range: N,M or N,$
  const rangeMatch = str.match(/^(\d+),(\d+|\$)(.*)/);
  if (rangeMatch) {
    const start: SedAddress = { type: 'line', n: parseInt(rangeMatch[1], 10) };
    const end: SedAddress = rangeMatch[2] === '$'
      ? { type: 'last' }
      : { type: 'line', n: parseInt(rangeMatch[2], 10) };
    return { addr: { type: 'range', start, end }, rest: rangeMatch[3] };
  }

  // Single line number
  const lineMatch = str.match(/^(\d+)(.*)/);
  if (lineMatch) {
    return { addr: { type: 'line', n: parseInt(lineMatch[1], 10) }, rest: lineMatch[2] };
  }

  // $ (last line)
  if (str.startsWith('$')) {
    return { addr: { type: 'last' }, rest: str.slice(1) };
  }

  return null;
}

function parseSedExpression(expr: string): SedCommand[] {
  const commands: SedCommand[] = [];
  // Split on semicolons, but not inside braces
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '{') { depth++; current += ch; continue; }
    if (ch === '}') { depth--; current += ch; continue; }
    if (ch === ';' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    let remaining = part;
    let address: SedAddress | undefined;

    const addrResult = parseAddress(remaining);
    if (addrResult) {
      address = addrResult.addr;
      remaining = addrResult.rest.trim();
    }

    // Handle s command with any delimiter
    const sMatch = remaining.match(/^s(.)(.+?)\1(.*?)\1([gimsy]*)$/);
    if (sMatch) {
      const [, , pattern, replacement, flagStr] = sMatch;
      const regexFlags = flagStr.includes('g') ? 'g' : '';
      const caseFlag = flagStr.includes('i') ? 'i' : '';
      const jsPattern = pattern.replace(/\\([()])/g, '$1');
      const jsReplacement = replacement
        .replace(/\\(\d)/g, '$$$1')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
      commands.push({ type: 's', regex: new RegExp(jsPattern, regexFlags + caseFlag), replacement: jsReplacement, address });
      continue;
    }

    // Handle y/from/to/ (transliterate)
    const yMatch = remaining.match(/^y(.)(.+?)\1(.+?)\1$/);
    if (yMatch) {
      commands.push({ type: 'y', from: yMatch[2], to: yMatch[3], address });
      continue;
    }

    // Handle d (delete)
    if (remaining === 'd') { commands.push({ type: 'd', address }); continue; }

    // Handle p (print)
    if (remaining === 'p') { commands.push({ type: 'p', address }); continue; }

    // Handle q (quit)
    if (remaining === 'q') { commands.push({ type: 'q', address }); continue; }

    // Handle = (print line number)
    if (remaining === '=') { commands.push({ type: '=', address }); continue; }

    // Hold space commands
    if (remaining === 'h') { commands.push({ type: 'h', address }); continue; }
    if (remaining === 'H') { commands.push({ type: 'H', address }); continue; }
    if (remaining === 'g') { commands.push({ type: 'g', address }); continue; }
    if (remaining === 'G') { commands.push({ type: 'G', address }); continue; }
    if (remaining === 'x') { commands.push({ type: 'x', address }); continue; }

    // Next line commands
    if (remaining === 'n') { commands.push({ type: 'n', address }); continue; }
    if (remaining === 'N') { commands.push({ type: 'N', address }); continue; }

    // Branch and label
    if (remaining.startsWith('b')) {
      const label = remaining.slice(1).trim() || undefined;
      commands.push({ type: 'b', label, address });
      continue;
    }
    if (remaining.startsWith(':')) {
      const label = remaining.slice(1).trim();
      commands.push({ type: ':', label });
      continue;
    }
    if (remaining.startsWith('t')) {
      const label = remaining.slice(1).trim() || undefined;
      commands.push({ type: 't', label, address });
      continue;
    }

    // Handle c\ (change line)
    const cMatch = remaining.match(/^c\\?(.*)$/);
    if (cMatch && remaining.startsWith('c')) {
      const text = cMatch[1].replace(/^\\n/, '\n').replace(/\\n/g, '\n');
      commands.push({ type: 'c', text, address });
      continue;
    }

    // Handle w filename
    if (remaining.startsWith('w ')) {
      commands.push({ type: 'w', text: remaining.slice(2).trim(), address });
      continue;
    }

    // Handle /pattern/d
    const patDelMatch = remaining.match(/^\/(.*?)\/d$/);
    if (patDelMatch) {
      commands.push({ type: 'd', address: { type: 'regex', re: new RegExp(patDelMatch[1]) } });
      continue;
    }

    // Handle /pattern/p
    const patPrintMatch = remaining.match(/^\/(.*?)\/p$/);
    if (patPrintMatch) {
      commands.push({ type: 'p', address: { type: 'regex', re: new RegExp(patPrintMatch[1]) } });
      continue;
    }

    // Handle braced command group: {cmd1;cmd2;...}
    if (remaining.startsWith('{') && remaining.endsWith('}')) {
      const inner = remaining.slice(1, -1);
      const innerCmds = parseSedExpression(inner);
      for (const cmd of innerCmds) {
        if (!cmd.address) cmd.address = address;
        commands.push(cmd);
      }
      continue;
    }

    // Handle a\ (append after) and i\ (insert before)
    const aiMatch = remaining.match(/^([ai])\\?(.*)$/);
    if (aiMatch && (aiMatch[1] === 'a' || aiMatch[1] === 'i')) {
      const text = aiMatch[2].replace(/^\\n/, '\n').replace(/\\n/g, '\n');
      commands.push({ type: aiMatch[1], text, address });
      continue;
    }

    commands.push({ type: 'noop' });
  }

  return commands;
}
