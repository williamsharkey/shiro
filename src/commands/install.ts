
import type { Command } from './index';
import { parseArgs, readFileText, statEntry } from './flags';
export const install: Command = {
  name: "install",
  description: "Copy files and set attributes",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["m", "mode", "o", "owner", "g", "group", "t", "target-directory"]);

    const mode = values.m || values.mode;
    const targetDirectory = values.t || values["target-directory"];
    const createDirs = flags.d || flags.directory;
    const verbose = flags.v || flags.verbose;

    if (positional.length === 0) {
      ctx.stderr += "install: missing operand\n";
      return 1;
    }

    const output: string[] = [];

    try {
      if (createDirs) {
        // Create directories
        for (const dir of positional) {
          const resolved = ctx.fs.resolvePath(dir, ctx.cwd);
          await ctx.fs.mkdir(resolved, { recursive: true });
          if (verbose) {
            output.push(`install: creating directory '${dir}'`);
          }
        }
      } else if (targetDirectory) {
        // Install files to target directory
        const targetDir = ctx.fs.resolvePath(targetDirectory, ctx.cwd);

        for (const file of positional) {
          const srcPath = ctx.fs.resolvePath(file, ctx.cwd);
          const fileName = file.split("/").pop() || file;
          const dstPath = targetDir + "/" + fileName;

          const content = await readFileText(ctx.fs, srcPath);
          await ctx.fs.writeFile(dstPath, content);

          if (verbose) {
            output.push(`'${file}' -> '${targetDirectory}/${fileName}'`);
          }
        }
      } else {
        // Standard install: source(s) dest
        if (positional.length < 2) {
          ctx.stderr += "install: missing destination\n";
          return 1;
        }

        const dest = positional[positional.length - 1];
        const sources = positional.slice(0, -1);

        // Check if dest is a directory
        const destPath = ctx.fs.resolvePath(dest, ctx.cwd);
        let isDir = false;
        try {
          const stat = await statEntry(ctx.fs, destPath);
          isDir = stat.type === "dir";
        } catch {
          // Dest doesn't exist
          isDir = sources.length > 1;
        }

        if (isDir && sources.length > 1) {
          // Multiple sources to directory
          for (const src of sources) {
            const srcPath = ctx.fs.resolvePath(src, ctx.cwd);
            const fileName = src.split("/").pop() || src;
            const dstPath = destPath + "/" + fileName;

            const content = await readFileText(ctx.fs, srcPath);
            await ctx.fs.writeFile(dstPath, content);

            if (verbose) {
              output.push(`'${src}' -> '${dest}/${fileName}'`);
            }
          }
        } else {
          // Single source to dest
          const srcPath = ctx.fs.resolvePath(sources[0], ctx.cwd);
          const content = await readFileText(ctx.fs, srcPath);
          await ctx.fs.writeFile(destPath, content);

          if (verbose) {
            output.push(`'${sources[0]}' -> '${dest}'`);
          }
        }
      }

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `install: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
