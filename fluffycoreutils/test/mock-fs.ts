/**
 * In-memory FluffyFS for testing commands without IndexedDB.
 */
import type { FluffyFS, FluffyEntry, FluffyStat } from "../src/types.js";

export class MemFS implements FluffyFS {
  private files = new Map<string, string>();
  private dirs = new Set<string>(["/"]);

  resolvePath(path: string, cwd: string): string {
    if (path.startsWith("/")) return path;
    return cwd === "/" ? "/" + path : cwd + "/" + path;
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined)
      throw new Error(`${path}: No such file or directory`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (opts?.recursive) {
      const parts = path.split("/").filter(Boolean);
      let cur = "";
      for (const p of parts) {
        cur += "/" + p;
        this.dirs.add(cur);
      }
    } else {
      this.dirs.add(path);
    }
  }

  async readdir(path: string): Promise<FluffyEntry[]> {
    const prefix = path === "/" ? "/" : path + "/";
    const entries: FluffyEntry[] = [];
    const seen = new Set<string>();

    for (const [p, content] of this.files) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !seen.has(name) && !rest.includes("/")) {
          seen.add(name);
          entries.push({ name, type: "file", size: content.length, mtime: 0 });
        }
      }
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && d !== path) {
        const rest = d.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !seen.has(name) && !rest.slice(name.length).includes("/")) {
          seen.add(name);
          entries.push({ name, type: "dir", size: 0, mtime: 0 });
        }
      }
    }
    return entries;
  }

  async stat(path: string): Promise<FluffyStat> {
    if (this.dirs.has(path))
      return { type: "dir", size: 0, mode: 0o755, mtime: 0 };
    const content = this.files.get(path);
    if (content !== undefined)
      return { type: "file", size: content.length, mode: 0o644, mtime: 0 };
    throw new Error(`${path}: No such file or directory`);
  }

  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path) || this.files.has(path);
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content !== undefined) {
      this.files.set(newPath, content);
      this.files.delete(oldPath);
    }
  }

  async rmdir(path: string): Promise<void> {
    this.dirs.delete(path);
  }
}
