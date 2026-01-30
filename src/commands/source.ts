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

    // Execute each line in the current shell context
    const lines = content.split(/\r?\n/);
    let exitCode = 0;
    let stdout = '';
    let stderr = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Handle export VAR=value
      const exportMatch = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
      if (exportMatch) {
        let val = exportMatch[2];
        // Strip quotes
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

      // Execute as shell command
      const result = await ctx.shell.exec(trimmed);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
    }

    ctx.stdout = stdout;
    ctx.stderr += stderr;
    return exitCode;
  },
};
