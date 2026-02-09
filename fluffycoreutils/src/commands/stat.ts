import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const stat: FluffyCommand = {
  name: "stat",
  description: "Display file status",
  async exec(args, io) {
    const { positional, flags, values } = parseArgs(args, ["c", "format"]);

    if (positional.length === 0) {
      return { stdout: "", stderr: "stat: missing operand\n", exitCode: 1 };
    }

    const format = values.c || values.format;
    const terse = flags.t;
    const fileSystem = flags.f;

    const output: string[] = [];

    try {
      for (const path of positional) {
        const resolved = io.fs.resolvePath(path, io.cwd);

        try {
          const statInfo = await io.fs.stat(resolved);

          if (format) {
            // Custom format
            const formatted = formatStat(path, statInfo, format);
            output.push(formatted);
          } else if (terse) {
            // Terse format: name size blocks mode uid gid device inode links
            output.push(`${path} ${statInfo.size} 0 ${statInfo.mode} 0 0 0 0 0 0 ${statInfo.mtime}`);
          } else {
            // Default verbose format
            const typeStr = statInfo.type === "dir" ? "directory" : "regular file";
            const modeStr = formatMode(statInfo.mode);
            const dateStr = new Date(statInfo.mtime).toISOString();

            output.push(`  File: ${path}`);
            output.push(`  Size: ${statInfo.size}\tBlocks: 0\tIO Block: 4096\t${typeStr}`);
            output.push(`Device: 0\tInode: 0\tLinks: 1`);
            output.push(`Access: (${modeStr})\tUid: (0/root)\tGid: (0/root)`);
            output.push(`Access: ${dateStr}`);
            output.push(`Modify: ${dateStr}`);
            output.push(`Change: ${dateStr}`);
          }
        } catch (e: unknown) {
          output.push(`stat: cannot stat '${path}': ${e instanceof Error ? e.message : e}`);
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
        stderr: `stat: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

function formatMode(mode: number): string {
  const perms = [
    (mode & 0o400) ? "r" : "-",
    (mode & 0o200) ? "w" : "-",
    (mode & 0o100) ? "x" : "-",
    (mode & 0o040) ? "r" : "-",
    (mode & 0o020) ? "w" : "-",
    (mode & 0o010) ? "x" : "-",
    (mode & 0o004) ? "r" : "-",
    (mode & 0o002) ? "w" : "-",
    (mode & 0o001) ? "x" : "-",
  ].join("");

  return `0${mode.toString(8)}/${perms}`;
}

function formatStat(path: string, stat: any, format: string): string {
  return format
    .replace(/%n/g, path) // file name
    .replace(/%N/g, `'${path}'`) // quoted file name
    .replace(/%s/g, String(stat.size)) // size
    .replace(/%b/g, "0") // blocks
    .replace(/%f/g, stat.mode.toString(16)) // mode in hex
    .replace(/%a/g, stat.mode.toString(8)) // mode in octal
    .replace(/%A/g, formatMode(stat.mode).split("/")[1]) // human-readable permissions
    .replace(/%F/g, stat.type === "dir" ? "directory" : "regular file") // file type
    .replace(/%u/g, "0") // user ID
    .replace(/%g/g, "0") // group ID
    .replace(/%U/g, "root") // user name
    .replace(/%G/g, "root") // group name
    .replace(/%i/g, "0") // inode
    .replace(/%h/g, "1") // hard links
    .replace(/%W/g, String(Math.floor(stat.mtime / 1000))) // mtime epoch
    .replace(/%X/g, String(Math.floor(stat.mtime / 1000))) // atime epoch
    .replace(/%Y/g, String(Math.floor(stat.mtime / 1000))) // ctime epoch
    .replace(/%y/g, new Date(stat.mtime).toISOString()) // mtime ISO
    .replace(/%%/g, "%");
}
