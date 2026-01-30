import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

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

export const tar: FluffyCommand = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(args, io) {
    const { flags, values, positional } = parseArgs(args, ["f", "C"]);

    const create = flags.c || flags.create;
    const extract = flags.x || flags.extract;
    const list = flags.t || flags.list;
    const verbose = flags.v || flags.verbose;
    const file = values.f;
    const changeDir = values.C;

    // Determine working directory
    let workingDir = io.cwd;
    if (changeDir) {
      workingDir = io.fs.resolvePath(changeDir, io.cwd);
    }

    // Mode validation
    const modes = [create, extract, list].filter(Boolean).length;
    if (modes === 0) {
      return { stdout: "", stderr: "tar: You must specify one of -c, -x, or -t\n", exitCode: 1 };
    }
    if (modes > 1) {
      return { stdout: "", stderr: "tar: You may not specify more than one -c, -x, or -t\n", exitCode: 1 };
    }

    try {
      // CREATE archive
      if (create) {
        if (!file) {
          return { stdout: "", stderr: "tar: Refusing to write archive to terminal (missing -f option?)\n", exitCode: 1 };
        }

        const filesToArchive = positional;
        if (filesToArchive.length === 0) {
          return { stdout: "", stderr: "tar: Cowardly refusing to create an empty archive\n", exitCode: 1 };
        }

        const entries: { path: string; content: string; isDir: boolean }[] = [];

        // Collect files recursively
        async function collectFiles(path: string, archivePath: string) {
          const resolved = io.fs.resolvePath(path, workingDir);
          const stat = await io.fs.stat(resolved);

          if (stat.type === "dir") {
            entries.push({ path: archivePath + "/", content: "", isDir: true });
            const items = await io.fs.readdir(resolved);
            for (const item of items) {
              await collectFiles(resolved + "/" + item.name, archivePath + "/" + item.name);
            }
          } else {
            const content = await io.fs.readFile(resolved);
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
        const archivePath = io.fs.resolvePath(file, io.cwd);
        await io.fs.writeFile(archivePath, archiveContent);

        return {
          stdout: verbose ? entries.map(e => e.path).join("\n") + "\n" : "",
          stderr: "",
          exitCode: 0
        };
      }

      // EXTRACT archive
      if (extract) {
        if (!file) {
          return { stdout: "", stderr: "tar: Refusing to read archive from terminal (missing -f option?)\n", exitCode: 1 };
        }

        const archivePath = io.fs.resolvePath(file, io.cwd);
        const archiveContent = await io.fs.readFile(archivePath);
        const lines = archiveContent.split("\n");

        if (lines[0] !== "FLUFFY-TAR-V1") {
          return { stdout: "", stderr: "tar: This does not look like a tar archive\n", exitCode: 1 };
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
          const targetPath = io.fs.resolvePath(filePath, workingDir);

          if (type === "dir") {
            await io.fs.mkdir(targetPath, { recursive: true });
          } else {
            // Ensure parent directory exists
            const lastSlash = targetPath.lastIndexOf("/");
            if (lastSlash > 0) {
              const parentDir = targetPath.slice(0, lastSlash);
              try {
                await io.fs.mkdir(parentDir, { recursive: true });
              } catch {
                // Ignore if already exists
              }
            }
            await io.fs.writeFile(targetPath, content);
          }

          extracted.push(filePath);
          if (verbose) {
            console.error(filePath);
          }
        }

        return {
          stdout: verbose ? extracted.join("\n") + "\n" : "",
          stderr: "",
          exitCode: 0
        };
      }

      // LIST archive
      if (list) {
        if (!file) {
          return { stdout: "", stderr: "tar: Refusing to read archive from terminal (missing -f option?)\n", exitCode: 1 };
        }

        const archivePath = io.fs.resolvePath(file, io.cwd);
        const archiveContent = await io.fs.readFile(archivePath);
        const lines = archiveContent.split("\n");

        if (lines[0] !== "FLUFFY-TAR-V1") {
          return { stdout: "", stderr: "tar: This does not look like a tar archive\n", exitCode: 1 };
        }

        const fileList: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].startsWith("FILE:")) {
            fileList.push(lines[i].slice(5));
          }
        }

        return { stdout: fileList.join("\n") + "\n", stderr: "", exitCode: 0 };
      }

      return { stdout: "", stderr: "tar: Unknown error\n", exitCode: 1 };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `tar: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
