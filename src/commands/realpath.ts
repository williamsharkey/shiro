
import type { Command } from './index';
import { parseArgs } from './flags';
export const realpath: Command = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);

    if (positional.length === 0) {
      ctx.stderr += "realpath: missing operand\n";
      return 1;
    }

    const quiet = flags.q || flags.quiet;
    const canonicalize = !flags.s; // -s means don't canonicalize (default is to canonicalize)
    const noSymlinks = flags.s;

    const results: string[] = [];
    const errors: string[] = [];

    for (const path of positional) {
      try {
        // Resolve the path
        let resolved = ctx.fs.resolvePath(path, ctx.cwd);

        // Normalize the path and resolve symlinks
        if (canonicalize) {
          // Remove redundant separators and resolve . and ..
          const parts = resolved.split("/").filter(p => p !== "" && p !== ".");
          const canonical: string[] = [];

          for (const part of parts) {
            if (part === "..") {
              if (canonical.length > 0) {
                canonical.pop();
              }
            } else {
              canonical.push(part);
            }
          }

          resolved = "/" + canonical.join("/");

          // Follow symlinks to final target
          if (ctx.fs.readlink) {
            const maxFollows = 20;
            for (let follow = 0; follow < maxFollows; follow++) {
              try {
                const target = await ctx.fs.readlink(resolved);
                // If target is relative, resolve against parent dir
                if (target.startsWith('/')) {
                  resolved = target;
                } else {
                  const parent = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
                  resolved = ctx.fs.resolvePath(target, parent);
                }
              } catch {
                break; // Not a symlink
              }
            }
          }
        }

        // Verify the path exists
        if (await ctx.fs.exists(resolved)) {
          results.push(resolved);
        } else {
          if (!quiet) {
            errors.push(`realpath: ${path}: No such file or directory`);
          }
        }
      } catch (e: unknown) {
        if (!quiet) {
          errors.push(`realpath: ${path}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    const stderr = errors.length > 0 ? errors.join("\n") + "\n" : "";
    const exitCode = errors.length > 0 ? 1 : 0;

    ctx.stdout += results.join("\n") + (results.length > 0 ? "\n" : "");
    ctx.stderr += stderr;
    return exitCode;
  },
};
