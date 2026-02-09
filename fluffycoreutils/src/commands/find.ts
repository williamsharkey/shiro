import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const find: FluffyCommand = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]);
    const startPath = positional[0] ?? ".";
    const namePattern = values.name;
    const inamePattern = values.iname; // case-insensitive name
    const pathPattern = values.path;
    const typeFilter = values.type; // "f" or "d"
    const maxDepth = values.maxdepth ? parseInt(values.maxdepth) : Infinity;
    const minDepth = values.mindepth ? parseInt(values.mindepth) : 0;
    const execCommand = values.exec;
    const printFlag = flags.print !== false; // default true

    const resolved = io.fs.resolvePath(startPath, io.cwd);
    const results: string[] = [];
    const execOutputs: string[] = [];

    let nameRegex: RegExp | undefined;
    if (namePattern) {
      // Convert glob to regex: * -> .*, ? -> .
      const escaped = namePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      nameRegex = new RegExp(`^${escaped}$`);
    }

    let inameRegex: RegExp | undefined;
    if (inamePattern) {
      const escaped = inamePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      inameRegex = new RegExp(`^${escaped}$`, "i");
    }

    let pathRegex: RegExp | undefined;
    if (pathPattern) {
      const escaped = pathPattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      pathRegex = new RegExp(escaped);
    }

    async function walk(dir: string, rel: string, depth: number): Promise<void> {
      let entries;
      try {
        entries = await io.fs.readdir(dir);
      } catch { return; }

      for (const entry of entries) {
        const fullPath = dir + "/" + entry.name;
        const relPath = rel ? rel + "/" + entry.name : entry.name;
        const displayPath = startPath === "." ? "./" + relPath : startPath + "/" + relPath;
        const currentDepth = depth + 1;

        let include = true;

        // Apply depth filters
        if (currentDepth > maxDepth) continue;
        if (currentDepth < minDepth) include = false;

        // Apply name filters
        if (nameRegex && !nameRegex.test(entry.name)) include = false;
        if (inameRegex && !inameRegex.test(entry.name)) include = false;
        if (pathRegex && !pathRegex.test(displayPath)) include = false;

        // Apply type filter
        if (typeFilter === "f" && entry.type !== "file") include = false;
        if (typeFilter === "d" && entry.type !== "dir") include = false;

        if (include) {
          if (printFlag) {
            results.push(displayPath);
          }

          // Execute command if -exec is specified
          if (execCommand) {
            // Replace {} with the file path
            const cmd = execCommand.replace(/\{\}/g, displayPath);
            execOutputs.push(`Executing: ${cmd}`);
            // Note: In a real implementation, this would execute the command
            // For browser environment, we just show what would be executed
          }
        }

        if (entry.type === "dir" && currentDepth < maxDepth) {
          await walk(fullPath, relPath, currentDepth);
        }
      }
    }

    // Include root directory unless filtered
    if (0 >= minDepth && (!typeFilter || typeFilter === "d")) {
      if (!nameRegex && !inameRegex && !pathRegex) {
        if (printFlag) {
          results.push(startPath === "." ? "." : startPath);
        }
      }
    }

    await walk(resolved, "", 0);

    let stdout = "";
    if (results.length > 0) {
      stdout = results.join("\n") + "\n";
    }
    if (execOutputs.length > 0) {
      stdout += execOutputs.join("\n") + "\n";
    }

    return { stdout, stderr: "", exitCode: 0 };
  },
};
