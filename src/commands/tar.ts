
import type { Command } from './index';
import { parseArgs, readFileText, readdirEntries, statEntry } from './flags';
interface TarHeader {
  name: string;
  mode: string;
  uid: string;
  gid: string;
  size: string;
  mtime: string;
  checksum: string;
  type: string;
  linkname: string;
  magic: string;
  version: string;
  uname: string;
  gname: string;
}

export const tar: Command = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(ctx) {
    const args = ctx.args;
    // Support combined flags without leading dash: tar czf → tar -czf, tar xzf → tar -xzf
    let processedArgs = args;
    if (args.length > 0 && /^[a-zA-Z]{2,}$/.test(args[0]) && !args[0].startsWith('-')) {
      processedArgs = ['-' + args[0], ...args.slice(1)];
    }
    const { flags, values, positional } = parseArgs(processedArgs, ["f", "C"]);

    const create = flags.c || flags.create;
    const extract = flags.x || flags.extract;
    const list = flags.t || flags.list;
    const verbose = flags.v || flags.verbose;
    const file = values.f;
    const changeDir = values.C;

    // Determine working directory
    let workingDir = ctx.cwd;
    if (changeDir) {
      workingDir = ctx.fs.resolvePath(changeDir, ctx.cwd);
    }

    // Mode validation
    const modes = [create, extract, list].filter(Boolean).length;
    if (modes === 0) {
      ctx.stderr += "tar: You must specify one of -c, -x, or -t\n";
      return 1;
    }
    if (modes > 1) {
      ctx.stderr += "tar: You may not specify more than one -c, -x, or -t\n";
      return 1;
    }

    try {
      // CREATE archive
      if (create) {
        if (!file) {
          ctx.stderr += "tar: Refusing to write archive to terminal (missing -f option?)\n";
          return 1;
        }

        const filesToArchive = positional;
        if (filesToArchive.length === 0) {
          ctx.stderr += "tar: Cowardly refusing to create an empty archive\n";
          return 1;
        }

        const entries: { path: string; content: string; isDir: boolean }[] = [];

        // Collect files recursively
        async function collectFiles(path: string, archivePath: string) {
          const resolved = ctx.fs.resolvePath(path, workingDir);
          const stat = await statEntry(ctx.fs, resolved);

          if (stat.type === "dir") {
            entries.push({ path: archivePath + "/", content: "", isDir: true });
            const items = await readdirEntries(ctx.fs, resolved);
            for (const item of items) {
              await collectFiles(resolved + "/" + item.name, archivePath + "/" + item.name);
            }
          } else {
            const content = await readFileText(ctx.fs, resolved);
            entries.push({ path: archivePath, content, isDir: false });
          }
        }

        for (const f of filesToArchive) {
          await collectFiles(f, f);
        }

        // Create simple text-based tar format (not POSIX tar, but works for this use case)
        const lines: string[] = ["FLUFFY-TAR-V1"];
        for (const entry of entries) {
          if (verbose) {
            console.error(entry.path);
          }
          lines.push(`FILE:${entry.path}`);
          lines.push(`SIZE:${entry.content.length}`);
          lines.push(`TYPE:${entry.isDir ? "dir" : "file"}`);
          lines.push("DATA-START");
          lines.push(entry.content);
          lines.push("DATA-END");
        }

        const archiveContent = lines.join("\n");
        const archivePath = ctx.fs.resolvePath(file, ctx.cwd);
        await ctx.fs.writeFile(archivePath, archiveContent);

        ctx.stdout += verbose ? entries.map(e => e.path).join("\n") + "\n" : "";
        return 0;
      }

      // EXTRACT archive
      if (extract) {
        if (!file) {
          ctx.stderr += "tar: Refusing to read archive from terminal (missing -f option?)\n";
          return 1;
        }

        const archivePath = ctx.fs.resolvePath(file, ctx.cwd);
        const archiveContent = await readFileText(ctx.fs, archivePath);
        const lines = archiveContent.split("\n");

        if (lines[0] !== "FLUFFY-TAR-V1") {
          ctx.stderr += "tar: This does not look like a tar archive\n";
          return 1;
        }

        let i = 1;
        const extracted: string[] = [];

        while (i < lines.length) {
          if (!lines[i].startsWith("FILE:")) break;

          const filePath = lines[i].slice(5);
          const size = parseInt(lines[i + 1].slice(5), 10);
          const type = lines[i + 2].slice(5);

          // Skip DATA-START
          i += 4;

          // Read content
          const contentLines: string[] = [];
          while (i < lines.length && lines[i] !== "DATA-END") {
            contentLines.push(lines[i]);
            i++;
          }
          const content = contentLines.join("\n");
          i++; // Skip DATA-END

          // Write file/directory
          const targetPath = ctx.fs.resolvePath(filePath, workingDir);

          if (type === "dir") {
            await ctx.fs.mkdir(targetPath, { recursive: true });
          } else {
            // Ensure parent directory exists
            const lastSlash = targetPath.lastIndexOf("/");
            if (lastSlash > 0) {
              const parentDir = targetPath.slice(0, lastSlash);
              try {
                await ctx.fs.mkdir(parentDir, { recursive: true });
              } catch {
                // Ignore if already exists
              }
            }
            await ctx.fs.writeFile(targetPath, content);
          }

          extracted.push(filePath);
          if (verbose) {
            console.error(filePath);
          }
        }

        ctx.stdout += verbose ? extracted.join("\n") + "\n" : "";
        return 0;
      }

      // LIST archive
      if (list) {
        if (!file) {
          ctx.stderr += "tar: Refusing to read archive from terminal (missing -f option?)\n";
          return 1;
        }

        const archivePath = ctx.fs.resolvePath(file, ctx.cwd);
        const archiveContent = await readFileText(ctx.fs, archivePath);
        const lines = archiveContent.split("\n");

        if (lines[0] !== "FLUFFY-TAR-V1") {
          ctx.stderr += "tar: This does not look like a tar archive\n";
          return 1;
        }

        const fileList: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].startsWith("FILE:")) {
            fileList.push(lines[i].slice(5));
          }
        }

        ctx.stdout += fileList.join("\n") + "\n";
        return 0;
      }

      ctx.stderr += "tar: Unknown error\n";
      return 1;
    } catch (e: unknown) {
      ctx.stderr += `tar: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
