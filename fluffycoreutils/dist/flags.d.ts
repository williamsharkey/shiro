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
export declare function parseArgs(args: string[], valueFlags?: string[]): ParsedArgs;
/**
 * Read input from either files or stdin.
 * If positional args are present, read files. Otherwise use stdin.
 */
export declare function readInput(positional: string[], stdin: string, fs: {
    readFile(path: string): Promise<string>;
}, cwd: string, resolvePath: (path: string, cwd: string) => string): Promise<{
    content: string;
    files: string[];
}>;
