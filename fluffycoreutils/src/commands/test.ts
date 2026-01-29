import type { FluffyCommand } from "../types.js";

export const test: FluffyCommand = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(args, io) {
    // Remove trailing ] if called as [
    const exprs = args[args.length - 1] === "]" ? args.slice(0, -1) : [...args];

    try {
      const result = await evaluate(exprs, io);
      return { stdout: "", stderr: "", exitCode: result ? 0 : 1 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `test: ${e instanceof Error ? e.message : e}\n`, exitCode: 2 };
    }
  },
};

async function evaluate(
  args: string[],
  io: { cwd: string; fs: { stat(p: string): Promise<{ type: string }>; resolvePath(p: string, cwd: string): string } }
): Promise<boolean> {
  if (args.length === 0) return false;
  if (args.length === 1) return args[0] !== "";

  // Unary operators
  if (args.length === 2) {
    const [op, val] = args;
    switch (op) {
      case "-z": return val === "";
      case "-n": return val !== "";
      case "!": return val === "";
      case "-e": case "-f": case "-d": {
        try {
          const resolved = io.fs.resolvePath(val, io.cwd);
          const stat = await io.fs.stat(resolved);
          if (op === "-f") return stat.type === "file";
          if (op === "-d") return stat.type === "dir";
          return true;
        } catch { return false; }
      }
    }
  }

  // Negation
  if (args[0] === "!" && args.length > 1) {
    return !(await evaluate(args.slice(1), io));
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
      (await evaluate(args.slice(0, aIdx), io)) &&
      (await evaluate(args.slice(aIdx + 1), io))
    );
  }
  const oIdx = args.indexOf("-o");
  if (oIdx > 0) {
    return (
      (await evaluate(args.slice(0, oIdx), io)) ||
      (await evaluate(args.slice(oIdx + 1), io))
    );
  }

  return false;
}
