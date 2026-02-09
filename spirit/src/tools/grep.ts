import type { OSProvider, FileInfo } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export const grepTool: ToolDefinition = {
  name: "Grep",
  description:
    "Search file contents using a regular expression. More efficient than grep via Bash for multi-file searches. Returns matching lines with file paths and line numbers.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for",
      },
      path: {
        type: "string",
        description:
          "File or directory to search in (defaults to current directory)",
      },
      glob: {
        type: "string",
        description:
          'Glob pattern to filter files (e.g., "*.ts", "*.js")',
      },
      case_insensitive: {
        type: "boolean",
        description: "Case insensitive search (default false)",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matching lines to return (default 100)",
      },
    },
    required: ["pattern"],
  },
};

export async function executeGrep(
  input: {
    pattern: string;
    path?: string;
    glob?: string;
    case_insensitive?: boolean;
    max_results?: number;
  },
  provider: OSProvider
): Promise<string> {
  const flags = input.case_insensitive ? "gi" : "g";
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch {
    return `Error: invalid regex pattern "${input.pattern}"`;
  }

  const basePath = input.path
    ? provider.resolvePath(input.path)
    : provider.getCwd();
  const maxResults = input.max_results ?? 100;
  const results: string[] = [];

  // Determine if basePath is a file or directory
  const stat = await provider.stat(basePath);
  if (stat.isFile()) {
    await searchFile(basePath, regex, maxResults, results, provider);
  } else {
    // Get files to search
    let files: string[];
    if (input.glob) {
      files = await provider.glob(input.glob, basePath);
      files = files.map((f) =>
        f.startsWith("/") ? f : basePath === "/" ? "/" + f : basePath + "/" + f
      );
    } else {
      files = await collectFiles(basePath, provider);
    }

    for (const file of files) {
      if (results.length >= maxResults) break;
      await searchFile(file, regex, maxResults, results, provider);
    }
  }

  if (results.length === 0) return "No matches found";
  const suffix =
    results.length >= maxResults
      ? `\n(results truncated at ${maxResults} matches)`
      : "";
  return results.join("\n") + suffix;
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  maxResults: number,
  results: string[],
  provider: OSProvider
): Promise<void> {
  let content: string;
  try {
    content = await provider.readFile(filePath);
  } catch {
    return; // skip unreadable files
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (results.length >= maxResults) break;
    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      results.push(`${filePath}:${i + 1}:${lines[i]}`);
    }
  }
}

const MAX_COLLECT_DEPTH = 20;

async function collectFiles(
  dirPath: string,
  provider: OSProvider,
  depth = 0,
  visited: Set<string> = new Set()
): Promise<string[]> {
  if (depth > MAX_COLLECT_DEPTH || visited.has(dirPath)) return [];
  visited.add(dirPath);

  const files: string[] = [];
  let entries;
  try {
    entries = await provider.readdir(dirPath);
  } catch {
    return []; // skip unreadable directories
  }
  for (const entry of entries) {
    if (entry.type === "file") {
      files.push(entry.path);
    } else if (entry.type === "dir") {
      const subFiles = await collectFiles(
        entry.path,
        provider,
        depth + 1,
        visited
      );
      files.push(...subFiles);
    }
  }
  return files;
}
