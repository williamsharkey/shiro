import type { FluffyCommand, FluffyEntry } from "../types.js";
import { parseArgs } from "../flags.js";

export const ls: FluffyCommand = {
  name: "ls",
  description: "List directory contents",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const paths = positional.length > 0 ? positional : ["."];
    const showAll = flags.a;
    const longFormat = flags.l;
    const humanReadable = flags.h;
    const results: string[] = [];

    for (const p of paths) {
      const resolved = io.fs.resolvePath(p, io.cwd);
      const stat = await io.fs.stat(resolved);

      if (stat.type === "file") {
        results.push(longFormat ? formatLong(resolved.split("/").pop()!, stat, humanReadable) : resolved.split("/").pop()!);
        continue;
      }

      if (paths.length > 1) results.push(`${p}:`);
      const entries = await io.fs.readdir(resolved);
      const filtered = showAll ? entries : entries.filter((e) => !e.name.startsWith("."));
      filtered.sort((a, b) => a.name.localeCompare(b.name));

      if (longFormat) {
        results.push(`total ${filtered.length}`);
        for (const entry of filtered) {
          results.push(formatLong(entry.name, entry, humanReadable));
        }
      } else {
        results.push(filtered.map((e) => e.type === "dir" ? e.name + "/" : e.name).join("  "));
      }
    }

    return { stdout: results.join("\n") + "\n", stderr: "", exitCode: 0 };
  },
};

function formatLong(
  name: string,
  entry: { type: string; size: number; mtime: number; mode?: number },
  human?: boolean
): string {
  const typeChar = entry.type === "dir" ? "d" : "-";
  const mode = entry.mode ?? (entry.type === "dir" ? 0o755 : 0o644);
  const perms = formatPerms(mode);
  const size = human ? humanSize(entry.size) : String(entry.size).padStart(8);
  const date = new Date(entry.mtime);
  const dateStr = formatDate(date);
  return `${typeChar}${perms}  1 user user ${size} ${dateStr} ${name}`;
}

function formatPerms(mode: number): string {
  const chars = "rwx";
  let result = "";
  for (let i = 2; i >= 0; i--) {
    const bits = (mode >> (i * 3)) & 7;
    for (let j = 2; j >= 0; j--) {
      result += bits & (1 << j) ? chars[2 - j] : "-";
    }
  }
  return result;
}

function formatDate(d: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${mon} ${day} ${h}:${m}`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes).padStart(5);
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  return (bytes / (1024 * 1024)).toFixed(1) + "M";
}
