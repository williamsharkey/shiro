/**
 * dos2unix / unix2dos — line ending converters
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';

export const dos2unixCmd: Command = {
  name: 'dos2unix',
  description: 'Convert DOS line endings to Unix',
  async exec(ctx) {
    try {
      const { flags, positional } = parseArgs(ctx.args);

      if (flags.n && positional.length >= 2) {
        // -n infile outfile
        const inPath = ctx.fs.resolvePath(positional[0], ctx.cwd);
        const outPath = ctx.fs.resolvePath(positional[1], ctx.cwd);
        const content = await ctx.fs.readFile(inPath, 'utf8') as string;
        if (content.includes('\0')) {
          ctx.stderr += `dos2unix: binary file ${positional[0]} detected\n`;
        }
        await ctx.fs.writeFile(outPath, content.replace(/\r\n/g, '\n'));
        return 0;
      }

      if (positional.length > 0) {
        // In-place conversion
        for (const file of positional) {
          const path = ctx.fs.resolvePath(file, ctx.cwd);
          const content = await ctx.fs.readFile(path, 'utf8') as string;
          if (content.includes('\0')) {
            ctx.stderr += `dos2unix: binary file ${file} detected\n`;
          }
          await ctx.fs.writeFile(path, content.replace(/\r\n/g, '\n'));
        }
        return 0;
      }

      // stdin → stdout
      ctx.stdout += ctx.stdin.replace(/\r\n/g, '\n');
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `dos2unix: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

export const unix2dosCmd: Command = {
  name: 'unix2dos',
  description: 'Convert Unix line endings to DOS',
  async exec(ctx) {
    try {
      const { flags, positional } = parseArgs(ctx.args);

      const convert = (s: string): string =>
        s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

      if (flags.n && positional.length >= 2) {
        const inPath = ctx.fs.resolvePath(positional[0], ctx.cwd);
        const outPath = ctx.fs.resolvePath(positional[1], ctx.cwd);
        const content = await ctx.fs.readFile(inPath, 'utf8') as string;
        if (content.includes('\0')) {
          ctx.stderr += `unix2dos: binary file ${positional[0]} detected\n`;
        }
        await ctx.fs.writeFile(outPath, convert(content));
        return 0;
      }

      if (positional.length > 0) {
        for (const file of positional) {
          const path = ctx.fs.resolvePath(file, ctx.cwd);
          const content = await ctx.fs.readFile(path, 'utf8') as string;
          if (content.includes('\0')) {
            ctx.stderr += `unix2dos: binary file ${file} detected\n`;
          }
          await ctx.fs.writeFile(path, convert(content));
        }
        return 0;
      }

      ctx.stdout += convert(ctx.stdin);
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `unix2dos: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
