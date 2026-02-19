
import type { Command } from './index';
import { parseArgs } from './flags';
export const readlink: Command = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    const canonicalize = flags.f;

    if (positional.length === 0) {
      ctx.stderr += "readlink: missing operand\n";
      return 1;
    }

    const resolved = ctx.fs.resolvePath(positional[0], ctx.cwd);

    if (canonicalize) {
      // -f: canonicalize, resolving all symlinks
      try {
        if (ctx.fs.readlink) {
          const target = await ctx.fs.readlink(resolved);
          // Resolve relative symlink targets
          const dir = resolved.split("/").slice(0, -1).join("/") || "/";
          const canonical = target.startsWith("/") ? target : ctx.fs.resolvePath(target, dir);
          ctx.stdout += canonical + "\n";
          return 0;
        }
      } catch {
        // Not a symlink, just return resolved path
      }
      ctx.stdout += resolved + "\n";
      return 0;
    }

    // Without -f, readlink only prints symlink target
    try {
      if (ctx.fs.readlink) {
        const target = await ctx.fs.readlink(resolved);
        ctx.stdout += target + "\n";
        return 0;
      }
    } catch {
      // Not a symlink
    }
    ctx.stderr += `readlink: ${positional[0]}: not a symbolic link\n`;
    return 1;
  },
};
