/**
 * Simple flag parser for coreutils commands.
 * Handles: -f, -rf (combined), -n 10 (with value), --flag
 */

export interface ParsedArgs {
  flags: Record<string, boolean>;
  values: Record<string, string>;
  positional: string[];
}

/**
 * Parse command arguments into flags, values, and positional args.
 * @param args - raw argument array
 * @param valueFlags - flags that consume the next argument as a value (e.g., ["n"])
 */
export function parseArgs(args: string[], valueFlags: string[] = []): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const valueFlagSet = new Set(valueFlags);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valueFlagSet.has(name) && i + 1 < args.length) {
        values[name] = args[++i];
      } else {
        flags[name] = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) {
      // Combined short flags: -rf → r=true, f=true
      // Value flag: -n 10 → n="10"
      const chars = arg.slice(1);
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (valueFlagSet.has(ch)) {
          // Rest of chars or next arg is the value
          const rest = chars.slice(j + 1);
          if (rest) {
            values[ch] = rest;
          } else if (i + 1 < args.length) {
            values[ch] = args[++i];
          }
          break;
        }
        flags[ch] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, values, positional };
}

/**
 * Read input from either files or stdin.
 * If positional args are present, read files. Otherwise use stdin.
 */
export async function readInput(
  positional: string[],
  stdin: string,
  fs: { readFile(path: string): Promise<string> },
  cwd: string,
  resolvePath: (path: string, cwd: string) => string
): Promise<{ content: string; files: string[] }> {
  if (positional.length === 0) {
    return { content: stdin, files: [] };
  }
  const files: string[] = [];
  const parts: string[] = [];
  for (const p of positional) {
    const resolved = resolvePath(p, cwd);
    files.push(resolved);
    parts.push(await fs.readFile(resolved));
  }
  return { content: parts.join(""), files };
}
