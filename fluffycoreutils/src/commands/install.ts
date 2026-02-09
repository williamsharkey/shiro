import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const install: FluffyCommand = {
  name: "install",
  description: "Copy files and set attributes",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["m", "mode", "o", "owner", "g", "group", "t", "target-directory"]);

    const mode = values.m || values.mode;
    const targetDirectory = values.t || values["target-directory"];
    const createDirs = flags.d || flags.directory;
    const verbose = flags.v || flags.verbose;

    if (positional.length === 0) {
      return { stdout: "", stderr: "install: missing operand\n", exitCode: 1 };
    }

    const output: string[] = [];

    try {
      if (createDirs) {
        // Create directories
        for (const dir of positional) {
          const resolved = io.fs.resolvePath(dir, io.cwd);
          await io.fs.mkdir(resolved, { recursive: true });
          if (verbose) {
            output.push(`install: creating directory '${dir}'`);
          }
        }
      } else if (targetDirectory) {
        // Install files to target directory
        const targetDir = io.fs.resolvePath(targetDirectory, io.cwd);

        for (const file of positional) {
          const srcPath = io.fs.resolvePath(file, io.cwd);
          const fileName = file.split("/").pop() || file;
          const dstPath = targetDir + "/" + fileName;

          const content = await io.fs.readFile(srcPath);
          await io.fs.writeFile(dstPath, content);

          if (verbose) {
            output.push(`'${file}' -> '${targetDirectory}/${fileName}'`);
          }
        }
      } else {
        // Standard install: source(s) dest
        if (positional.length < 2) {
          return { stdout: "", stderr: "install: missing destination\n", exitCode: 1 };
        }

        const dest = positional[positional.length - 1];
        const sources = positional.slice(0, -1);

        // Check if dest is a directory
        const destPath = io.fs.resolvePath(dest, io.cwd);
        let isDir = false;
        try {
          const stat = await io.fs.stat(destPath);
          isDir = stat.type === "dir";
        } catch {
          // Dest doesn't exist
          isDir = sources.length > 1;
        }

        if (isDir && sources.length > 1) {
          // Multiple sources to directory
          for (const src of sources) {
            const srcPath = io.fs.resolvePath(src, io.cwd);
            const fileName = src.split("/").pop() || src;
            const dstPath = destPath + "/" + fileName;

            const content = await io.fs.readFile(srcPath);
            await io.fs.writeFile(dstPath, content);

            if (verbose) {
              output.push(`'${src}' -> '${dest}/${fileName}'`);
            }
          }
        } else {
          // Single source to dest
          const srcPath = io.fs.resolvePath(sources[0], io.cwd);
          const content = await io.fs.readFile(srcPath);
          await io.fs.writeFile(destPath, content);

          if (verbose) {
            output.push(`'${sources[0]}' -> '${dest}'`);
          }
        }
      }

      return {
        stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `install: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
