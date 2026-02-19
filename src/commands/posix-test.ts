
import type { Command } from './index';
import type { FileSystem } from '../filesystem';
import { statEntry } from './flags';

export const test: Command = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(ctx) {
    const args = ctx.args;
    // Remove trailing ] if called as [
    const exprs = args[args.length - 1] === "]" ? args.slice(0, -1) : [...args];

    try {
      const result = await evaluate(exprs, ctx.fs, ctx.cwd);
      return result ? 0 : 1;
    } catch (e: unknown) {
      ctx.stderr += `test: ${e instanceof Error ? e.message : e}\n`;
      return 2;
    }
  },
};

async function evaluate(
  args: string[],
  fs: FileSystem,
  cwd: string,
): Promise<boolean> {
  if (args.length === 0) return false;
  if (args.length === 1) return args[0] !== "";

  // Unary operators
  if (args.length === 2) {
    const [op, val] = args;
    switch (op) {
      // String tests
      case "-z": return val === "";
      case "-n": return val !== "";
      case "!": return val === "";

      // File existence and type tests
      case "-e": case "-f": case "-d": case "-L": case "-h": case "-S": case "-p": case "-b": case "-c": {
        try {
          const resolved = fs.resolvePath(val, cwd);
          const stat = await statEntry(fs, resolved);
          if (op === "-f") return stat.type === "file";
          if (op === "-d") return stat.type === "dir";
          if (op === "-L" || op === "-h") return stat.type === "symlink";
          if (op === "-S") return (stat.type as string) === "socket";
          if (op === "-p") return (stat.type as string) === "fifo";
          if (op === "-b") return (stat.type as string) === "block";
          if (op === "-c") return (stat.type as string) === "char";
          return true; // -e: exists
        } catch { return false; }
      }

      // File permissions (simplified - always return false in browser)
      case "-r": case "-w": case "-x": case "-s": case "-u": case "-g": case "-k": {
        try {
          const resolved = fs.resolvePath(val, cwd);
          await statEntry(fs, resolved);
          // -s: file exists and has size > 0
          if (op === "-s") {
            try {
              const content = await (fs as any).readFile?.(resolved);
              return content && content.length > 0;
            } catch {
              return false;
            }
          }
          // In browser context, we can't check real permissions
          // Return true for basic permission checks if file exists
          return op === "-r" || op === "-w";
        } catch { return false; }
      }

      // Terminal tests (always false in browser)
      case "-t": return false;
    }
  }

  // Negation
  if (args[0] === "!" && args.length > 1) {
    return !(await evaluate(args.slice(1), fs, cwd));
  }

  // Binary operators
  if (args.length === 3) {
    const [left, op, right] = args;
    switch (op) {
      case "=": case "==": return left === right;
      case "!=": return left !== right;
      case "-eq": return parseInt(left) === parseInt(right);
      case "-ne": return parseInt(left) !== parseInt(right);
      case "-lt": return parseInt(left) < parseInt(right);
      case "-le": return parseInt(left) <= parseInt(right);
      case "-gt": return parseInt(left) > parseInt(right);
      case "-ge": return parseInt(left) >= parseInt(right);
    }
  }

  // Compound: -a (AND), -o (OR)
  const aIdx = args.indexOf("-a");
  if (aIdx > 0) {
    return (
      (await evaluate(args.slice(0, aIdx), fs, cwd)) &&
      (await evaluate(args.slice(aIdx + 1), fs, cwd))
    );
  }
  const oIdx = args.indexOf("-o");
  if (oIdx > 0) {
    return (
      (await evaluate(args.slice(0, oIdx), fs, cwd)) ||
      (await evaluate(args.slice(oIdx + 1), fs, cwd))
    );
  }

  return false;
}
