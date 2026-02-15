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
        // Handle combined flags like -ni
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

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        let current = lines[lineNum];
        let deleted = false;
        let printed = false;

        for (const cmd of commands) {
          // Check address match
          if (!addressMatches(cmd.address, current, lineNum + 1, lines.length)) continue;

          if (cmd.type === 's') {
            current = current.replace(cmd.regex!, cmd.replacement!);
          } else if (cmd.type === 'd') {
            deleted = true;
          } else if (cmd.type === 'p') {
            printed = true;
          }
        }

        if (!deleted) {
          if (!suppressDefault) {
            result.push(current);
          }
          if (printed) {
            result.push(current);
          }
        }
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

function resolveLineNum(addr: SedAddress, _currentLine: number, totalLines: number): number {
  if (addr.type === 'line') return addr.n;
  if (addr.type === 'last') return totalLines;
  return -1;
}

function parseAddress(str: string): { addr: SedAddress; rest: string } | null {
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
  // /regex/
  const regexMatch = str.match(/^\/((?:[^/\\]|\\.)*)\/(.*)$/);
  if (regexMatch) {
    return { addr: { type: 'regex', re: new RegExp(regexMatch[1]) }, rest: regexMatch[2] };
  }
  return null;
}

function parseSedExpression(expr: string): SedCommand[] {
  const commands: SedCommand[] = [];
  // Split on semicolons (but not inside regex delimiters)
  const parts = expr.split(';').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    let remaining = part;
    let address: SedAddress | undefined;

    // Try to parse an address prefix
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
      // Convert \1..\9 backreferences to $1..$9 for JS .replace()
      const jsReplacement = replacement
        .replace(/\\(\d)/g, '$$$1')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
      commands.push({
        type: 's',
        regex: new RegExp(pattern, regexFlags + caseFlag),
        replacement: jsReplacement,
        address,
      });
      continue;
    }

    // Handle d (delete)
    if (remaining === 'd') {
      commands.push({ type: 'd', address });
      continue;
    }

    // Handle p (print)
    if (remaining === 'p') {
      commands.push({ type: 'p', address });
      continue;
    }

    // Handle /pattern/d
    const patDelMatch = remaining.match(/^\/(.*?)\/d$/);
    if (patDelMatch) {
      commands.push({
        type: 'd',
        address: { type: 'regex', re: new RegExp(patDelMatch[1]) },
      });
      continue;
    }

    // Handle /pattern/p
    const patPrintMatch = remaining.match(/^\/(.*?)\/p$/);
    if (patPrintMatch) {
      commands.push({
        type: 'p',
        address: { type: 'regex', re: new RegExp(patPrintMatch[1]) },
      });
      continue;
    }

    // Fallback: noop
    commands.push({ type: 'noop' });
  }

  return commands;
}
