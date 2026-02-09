import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const grep: FluffyCommand = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(args, io) {
    const { flags, values, positional } = parseArgs(args, ["e"]);
    const ignoreCase = !!flags.i;
    const invertMatch = !!flags.v;
    const countOnly = !!flags.c;
    const filesOnly = !!flags.l;
    const lineNumbers = !!flags.n;
    const recursive = !!(flags.r || flags.R);

    // Pattern is first positional arg (or -e value)
    const pattern = values.e ?? positional.shift();
    if (!pattern) {
      return { stdout: "", stderr: "grep: missing pattern\n", exitCode: 2 };
    }

    const regexFlags = ignoreCase ? "i" : "";
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, regexFlags);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${pattern}\n`, exitCode: 2 };
    }

    const filePaths = positional.length > 0 ? positional : ["-"];
    const multiFile = filePaths.length > 1 || recursive;
    const output: string[] = [];
    let matched = false;

    async function searchFile(path: string, label: string): Promise<void> {
      let content: string;
      try {
        if (path === "-") {
          content = io.stdin;
        } else {
          const resolved = io.fs.resolvePath(path, io.cwd);
          content = await io.fs.readFile(resolved);
        }
      } catch {
        output.push(`grep: ${path}: No such file or directory`);
        return;
      }

      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      let count = 0;

      for (let i = 0; i < lines.length; i++) {
        const match = regex.test(lines[i]);
        if (match !== invertMatch) {
          matched = true;
          count++;
          if (!countOnly && !filesOnly) {
            const prefix = multiFile ? `${label}:` : "";
            const ln = lineNumbers ? `${i + 1}:` : "";
            output.push(`${prefix}${ln}${lines[i]}`);
          }
        }
      }

      if (countOnly) {
        output.push(multiFile ? `${label}:${count}` : String(count));
      }
      if (filesOnly && count > 0) {
        output.push(label);
      }
    }

    async function searchDir(dirPath: string): Promise<void> {
      const resolved = io.fs.resolvePath(dirPath, io.cwd);
      let entries;
      try {
        entries = await io.fs.readdir(resolved);
      } catch { return; }
      for (const entry of entries) {
        const full = resolved + "/" + entry.name;
        if (entry.type === "dir") {
          await searchDir(full);
        } else {
          await searchFile(full, full);
        }
      }
    }

    for (const fp of filePaths) {
      if (fp === "-") {
        await searchFile("-", "(standard input)");
      } else if (recursive) {
        const resolved = io.fs.resolvePath(fp, io.cwd);
        let stat;
        try { stat = await io.fs.stat(resolved); } catch { continue; }
        if (stat.type === "dir") {
          await searchDir(resolved);
        } else {
          await searchFile(fp, fp);
        }
      } else {
        await searchFile(fp, fp);
      }
    }

    const out = output.length > 0 ? output.join("\n") + "\n" : "";
    return { stdout: out, stderr: "", exitCode: matched ? 0 : 1 };
  },
};
