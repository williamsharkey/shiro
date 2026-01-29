import { Command, CommandContext } from './index';

export const sedCmd: Command = {
  name: 'sed',
  description: 'Stream editor for filtering and transforming text',
  async exec(ctx: CommandContext) {
    let inPlace = false;
    let expression = '';
    const files: string[] = [];

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-i') {
        inPlace = true;
      } else if (arg === '-e' && i + 1 < ctx.args.length) {
        expression = ctx.args[++i];
      } else if (!expression) {
        expression = arg;
      } else {
        files.push(arg);
      }
      i++;
    }

    if (!expression) {
      ctx.stderr = 'sed: no expression provided\n';
      return 1;
    }

    const commands = parseSedExpression(expression);

    const processContent = (content: string): string => {
      const lines = content.split('\n');
      const result: string[] = [];

      for (const line of lines) {
        let current = line;
        let deleted = false;

        for (const cmd of commands) {
          if (cmd.type === 's') {
            current = current.replace(cmd.regex!, cmd.replacement!);
          } else if (cmd.type === 'd') {
            if (cmd.address) {
              if (cmd.address instanceof RegExp && cmd.address.test(current)) {
                deleted = true;
              } else if (typeof cmd.address === 'number') {
                // Line number addressing handled differently
              }
            } else {
              deleted = true;
            }
          }
        }

        if (!deleted) {
          result.push(current);
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
  address?: RegExp | number;
}

function parseSedExpression(expr: string): SedCommand[] {
  const commands: SedCommand[] = [];

  // Handle s/pattern/replacement/flags
  const sMatch = expr.match(/^s(.)(.+?)\1(.*?)\1([gimsy]*)$/);
  if (sMatch) {
    const [, , pattern, replacement, flags] = sMatch;
    const regexFlags = flags.includes('g') ? 'g' : '';
    const caseFlag = flags.includes('i') ? 'i' : '';
    commands.push({
      type: 's',
      regex: new RegExp(pattern, regexFlags + caseFlag),
      replacement: replacement.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
    });
    return commands;
  }

  // Handle d (delete)
  if (expr === 'd') {
    commands.push({ type: 'd' });
    return commands;
  }

  // Handle /pattern/d
  const dMatch = expr.match(/^\/(.*?)\/d$/);
  if (dMatch) {
    commands.push({ type: 'd', address: new RegExp(dMatch[1]) });
    return commands;
  }

  // Fallback: treat as s command with / delimiter
  commands.push({ type: 'noop' });
  return commands;
}
