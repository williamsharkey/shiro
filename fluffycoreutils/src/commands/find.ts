import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const find: FluffyCommand = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(args, io) {
    const { values, positional } = parseArgs(args, ["name", "type"]);
    const startPath = positional[0] ?? ".";
    const namePattern = values.name;
    const typeFilter = values.type; // "f" or "d"

    const resolved = io.fs.resolvePath(startPath, io.cwd);
    const results: string[] = [];

    let nameRegex: RegExp | undefined;
    if (namePattern) {
      // Convert glob to regex: * -> .*, ? -> .
      const escaped = namePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      nameRegex = new RegExp(`^${escaped}$`);
    }

    async function walk(dir: string, rel: string): Promise<void> {
      let entries;
      try {
        entries = await io.fs.readdir(dir);
      } catch { return; }

      for (const entry of entries) {
        const fullPath = dir + "/" + entry.name;
        const relPath = rel ? rel + "/" + entry.name : entry.name;
        const displayPath = startPath === "." ? "./" + relPath : startPath + "/" + relPath;

        let include = true;
        if (nameRegex && !nameRegex.test(entry.name)) include = false;
        if (typeFilter === "f" && entry.type !== "file") include = false;
        if (typeFilter === "d" && entry.type !== "dir") include = false;

        if (include) results.push(displayPath);

        if (entry.type === "dir") {
          await walk(fullPath, relPath);
        }
      }
    }

    // Include root directory unless filtered
    if (!typeFilter || typeFilter === "d") {
      if (!nameRegex) results.push(startPath === "." ? "." : startPath);
    }

    await walk(resolved, "");

    return { stdout: results.join("\n") + "\n", stderr: "", exitCode: 0 };
  },
};
