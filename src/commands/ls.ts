
import type { Command } from './index';
import { parseArgs, readdirEntries, statEntry } from './flags';

// Color codes for ls --color
const COLORS: Record<string, string> = {
  dir: '\x1b[1;34m',     // bold blue
  symlink: '\x1b[1;36m', // bold cyan
  exec: '\x1b[1;32m',    // bold green
  archive: '\x1b[1;31m', // bold red
  image: '\x1b[1;35m',   // bold magenta
  source: '\x1b[0;33m',  // yellow
  reset: '\x1b[0m',
};

const ARCHIVE_EXTS = new Set(['.tar', '.gz', '.bz2', '.xz', '.zip', '.rar', '.7z', '.tgz', '.zst']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico']);
const SOURCE_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.sh', '.rb', '.php']);

function getExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

function colorize(name: string, entry: { type: string; mode?: number }, useColor: boolean): string {
  if (!useColor) return name;
  if (entry.type === 'dir') return COLORS.dir + name + COLORS.reset;
  if (entry.type === 'symlink') return COLORS.symlink + name + COLORS.reset;
  const ext = getExt(name);
  if (ARCHIVE_EXTS.has(ext)) return COLORS.archive + name + COLORS.reset;
  if (IMAGE_EXTS.has(ext)) return COLORS.image + name + COLORS.reset;
  if (SOURCE_EXTS.has(ext)) return COLORS.source + name + COLORS.reset;
  const mode = entry.mode ?? 0;
  if ((mode & 0o111) !== 0 && entry.type === 'file') return COLORS.exec + name + COLORS.reset;
  return name;
}

function typeIndicator(entry: { type: string; mode?: number }): string {
  if (entry.type === 'dir') return '/';
  if (entry.type === 'symlink') return '@';
  const mode = entry.mode ?? 0;
  if ((mode & 0o111) !== 0 && entry.type === 'file') return '*';
  return '';
}

export const ls: Command = {
  name: "ls",
  description: "List directory contents",
  async exec(ctx) {
    const args = ctx.args;
    // Custom parsing for --color=VALUE and --group-directories-first
    let colorMode = 'never'; // 'always', 'auto', 'never'
    let onePerLine = false;
    let sortBySize = false;
    let sortByTime = false;
    let dirsOnly = false;
    let groupDirsFirst = false;
    let classify = false;

    // Pre-process args to handle --color[=VALUE], -1, -S, -t, -d, -F
    const processedArgs: string[] = [];
    for (const arg of args) {
      if (arg === '--color' || arg === '--color=always') {
        colorMode = 'always';
      } else if (arg === '--color=auto') {
        colorMode = 'auto';
      } else if (arg === '--color=never') {
        colorMode = 'never';
      } else if (arg === '--group-directories-first') {
        groupDirsFirst = true;
      } else if (arg === '-1') {
        onePerLine = true;
      } else if (arg === '-S') {
        sortBySize = true;
      } else if (arg === '-t') {
        sortByTime = true;
      } else if (arg === '-d') {
        dirsOnly = true;
      } else if (arg === '-F') {
        classify = true;
      } else {
        processedArgs.push(arg);
      }
    }

    const { flags, positional } = parseArgs(processedArgs);
    const paths = positional.length > 0 ? positional : ["."];
    const showAll = flags.a;
    const longFormat = flags.l;
    const humanReadable = flags.h;
    const recursive = flags.R;
    if (flags.S) sortBySize = true;
    if (flags.F) classify = true;
    const useColor = colorMode === 'always';
    const results: string[] = [];

    async function listDir(dirPath: string, label: string, showLabel: boolean) {
      const entries = await readdirEntries(ctx.fs, dirPath);
      let filtered = showAll ? entries : entries.filter((e) => !e.name.startsWith("."));

      // Sort entries
      if (sortBySize) {
        filtered.sort((a, b) => (b.size || 0) - (a.size || 0));
      } else if (sortByTime) {
        filtered.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      } else {
        filtered.sort((a, b) => a.name.localeCompare(b.name));
      }

      // Group directories first
      if (groupDirsFirst) {
        const dirs = filtered.filter(e => e.type === 'dir');
        const nonDirs = filtered.filter(e => e.type !== 'dir');
        filtered = [...dirs, ...nonDirs];
      }

      if (showLabel) results.push(`${label}:`);

      if (longFormat) {
        results.push(`total ${filtered.length}`);
        for (const entry of filtered) {
          const name = colorize(entry.name, entry, useColor) + (classify ? typeIndicator(entry) : '');
          results.push(formatLong(name, entry, humanReadable));
        }
      } else if (onePerLine) {
        for (const entry of filtered) {
          const name = colorize(entry.name, entry, useColor);
          const suffix = classify ? typeIndicator(entry) : (entry.type === 'dir' ? '/' : '');
          results.push(name + suffix);
        }
      } else {
        results.push(filtered.map((e) => {
          const name = colorize(e.name, e, useColor);
          const suffix = classify ? typeIndicator(e) : (e.type === "dir" ? "/" : "");
          return name + suffix;
        }).join("  "));
      }

      if (recursive) {
        for (const entry of filtered) {
          if (entry.type === "dir") {
            results.push("");
            const subPath = dirPath === "/" ? "/" + entry.name : dirPath + "/" + entry.name;
            const subLabel = label === "." ? entry.name : label + "/" + entry.name;
            await listDir(subPath, subLabel, true);
          }
        }
      }
    }

    for (const p of paths) {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      const stat = await statEntry(ctx.fs, resolved);

      if (dirsOnly) {
        // -d: list the directory entry itself
        const name = colorize(p, stat, useColor) + (classify ? typeIndicator(stat) : '');
        if (longFormat) {
          results.push(formatLong(name, stat, humanReadable));
        } else {
          results.push(name);
        }
        continue;
      }

      if (stat.type === "file" || stat.type === "symlink") {
        const baseName = resolved.split("/").pop()!;
        const name = colorize(baseName, stat, useColor) + (classify ? typeIndicator(stat) : '');
        results.push(longFormat ? formatLong(name, stat, humanReadable) : name);
        continue;
      }

      const showLabel = paths.length > 1 || recursive;
      await listDir(resolved, p, showLabel);
    }

    ctx.stdout += results.join("\n") + "\n";
    return 0;
  },
};

function formatLong(
  name: string,
  entry: { type: string; size: number; mtime: number; mode?: number; target?: string },
  human?: boolean
): string {
  const typeChar = entry.type === "symlink" ? "l" : entry.type === "dir" ? "d" : "-";
  const mode = entry.mode ?? (entry.type === "symlink" ? 0o777 : entry.type === "dir" ? 0o755 : 0o644);
  const perms = formatPerms(mode);
  const size = human ? humanSize(entry.size) : String(entry.size).padStart(8);
  const date = new Date(entry.mtime);
  const dateStr = formatDate(date);
  const suffix = entry.type === "symlink" && entry.target ? ` -> ${entry.target}` : "";
  return `${typeChar}${perms}  1 user user ${size} ${dateStr} ${name}${suffix}`;
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
