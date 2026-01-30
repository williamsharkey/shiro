import { Command, CommandContext } from './index';

/**
 * source (.) - Execute a script file in the current shell context.
 * Variables set in the sourced file persist in the calling shell.
 */
export const sourceCmd: Command = {
  name: 'source',
  description: 'Execute a script file in the current shell context',
  async exec(ctx: CommandContext): Promise<number> {
    if (ctx.args.length === 0) {
      ctx.stderr = 'source: missing file argument\n';
      return 1;
    }

    const filePath = ctx.fs.resolvePath(ctx.args[0], ctx.cwd);
    let content: string;
    try {
      content = await ctx.fs.readFile(filePath, 'utf8') as string;
    } catch (e: any) {
      ctx.stderr = `source: ${ctx.args[0]}: No such file or directory\n`;
      return 1;
    }

    // Group lines into logical blocks (heredocs, multi-line constructs)
    const rawLines = content.split(/\r?\n/);
    const blocks: string[] = [];
    let i = 0;
    while (i < rawLines.length) {
      const line = rawLines[i];
      const trimmed = line.trim();

      // Check if this line starts a heredoc
      const heredocMatch = trimmed.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
      if (heredocMatch) {
        const delimiter = heredocMatch[1] || heredocMatch[2] || heredocMatch[3];
        // Collect all lines until the delimiter
        const blockLines = [line];
        i++;
        while (i < rawLines.length) {
          blockLines.push(rawLines[i]);
          if (rawLines[i].trim() === delimiter) break;
          i++;
        }
        blocks.push(blockLines.join('\n'));
        i++;
        continue;
      }

      blocks.push(line);
      i++;
    }

    // Execute each block in the current shell context
    let exitCode = 0;
    let stdout = '';
    let stderr = '';

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Handle export VAR=value
      const exportMatch = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
      if (exportMatch) {
        let val = exportMatch[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        ctx.env[exportMatch[1]] = val;
        ctx.shell.env[exportMatch[1]] = val;
        continue;
      }

      // Handle plain VAR=value
      const assignMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
      if (assignMatch) {
        let val = assignMatch[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        ctx.env[assignMatch[1]] = val;
        ctx.shell.env[assignMatch[1]] = val;
        continue;
      }

      // Execute as shell command (block may be multi-line for heredocs)
      const result = await ctx.shell.exec(block);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
    }

    ctx.stdout = stdout;
    ctx.stderr += stderr;
    return exitCode;
  },
};
