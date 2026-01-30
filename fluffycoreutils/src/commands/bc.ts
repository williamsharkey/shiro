import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const bc: FluffyCommand = {
  name: "bc",
  description: "Arbitrary precision calculator language",
  async exec(args, io) {
    const { flags, positional, values } = parseArgs(args, ["l", "q", "s", "w"]);

    const mathLib = flags.l; // Load math library
    const quiet = flags.q; // Don't print welcome message
    const scale = values.s ? parseInt(values.s) : 0; // Number of decimal places
    const warn = flags.w; // Warn about non-standard bc

    let input: string;

    // Read from file or stdin
    if (positional.length > 0) {
      try {
        const path = io.fs.resolvePath(positional[0], io.cwd);
        input = await io.fs.readFile(path);
      } catch (err) {
        return {
          stdout: "",
          stderr: `bc: ${positional[0]}: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    } else {
      input = io.stdin;
    }

    if (!input.trim()) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    const lines = input.split("\n").map(l => l.trim()).filter(Boolean);
    const output: string[] = [];
    const variables = new Map<string, number>();
    let currentScale = scale;

    // Add math library functions if -l flag is set
    if (mathLib) {
      currentScale = 20; // Math library defaults to scale 20
    }

    for (const line of lines) {
      // Skip comments
      if (line.startsWith("#") || line.startsWith("/*")) continue;

      // Handle special commands
      if (line === "quit" || line === "q") break;

      // Handle scale command
      if (line.startsWith("scale=")) {
        currentScale = parseInt(line.substring(6)) || 0;
        continue;
      }

      if (line === "scale") {
        output.push(String(currentScale));
        continue;
      }

      // Handle variable assignment
      const assignMatch = line.match(/^([a-z_][a-z0-9_]*)\s*=\s*(.+)$/i);
      if (assignMatch) {
        const varName = assignMatch[1];
        const expr = assignMatch[2];
        try {
          const value = evaluateExpression(expr, variables, currentScale, mathLib);
          variables.set(varName, value);
          continue;
        } catch (err) {
          return {
            stdout: "",
            stderr: `bc: ${err instanceof Error ? err.message : String(err)}\n`,
            exitCode: 1,
          };
        }
      }

      // Evaluate expression
      try {
        const result = evaluateExpression(line, variables, currentScale, mathLib);
        const formatted = formatNumber(result, currentScale);
        output.push(formatted);
      } catch (err) {
        return {
          stdout: "",
          stderr: `bc: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    }

    return {
      stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
      stderr: "",
      exitCode: 0,
    };
  },
};

function evaluateExpression(
  expr: string,
  variables: Map<string, number>,
  scale: number,
  mathLib: boolean
): number {
  let normalized = expr.trim();

  // Replace variables
  for (const [name, value] of variables) {
    normalized = normalized.replace(new RegExp(`\\b${name}\\b`, "g"), String(value));
  }

  // Handle math library functions
  if (mathLib) {
    normalized = handleMathFunctions(normalized);
  }

  // Handle power operator (^)
  normalized = normalized.replace(/(\d+(?:\.\d+)?)\s*\^\s*(\d+(?:\.\d+)?)/g, (_, base, exp) => {
    return String(Math.pow(parseFloat(base), parseFloat(exp)));
  });

  // Handle sqrt
  normalized = normalized.replace(/sqrt\s*\(\s*([^)]+)\s*\)/g, (_, arg) => {
    const val = parseFloat(arg);
    return String(Math.sqrt(val));
  });

  // Evaluate using JavaScript (limited precision)
  try {
    // eslint-disable-next-line no-eval
    const result = eval(normalized);
    if (typeof result !== "number" || !isFinite(result)) {
      throw new Error("invalid expression");
    }
    return result;
  } catch (err) {
    throw new Error(`parse error: ${expr}`);
  }
}

function handleMathFunctions(expr: string): string {
  let result = expr;

  // sin, cos, tan (arguments in radians)
  result = result.replace(/s\s*\(\s*([^)]+)\s*\)/g, (_, arg) => {
    return String(Math.sin(parseFloat(arg)));
  });

  result = result.replace(/c\s*\(\s*([^)]+)\s*\)/g, (_, arg) => {
    return String(Math.cos(parseFloat(arg)));
  });

  // atan
  result = result.replace(/a\s*\(\s*([^)]+)\s*\)/g, (_, arg) => {
    return String(Math.atan(parseFloat(arg)));
  });

  // ln (natural log)
  result = result.replace(/l\s*\(\s*([^)]+)\s*\)/g, (_, arg) => {
    return String(Math.log(parseFloat(arg)));
  });

  // exp (e^x)
  result = result.replace(/e\s*\(\s*([^)]+)\s*\)/g, (_, arg) => {
    return String(Math.exp(parseFloat(arg)));
  });

  return result;
}

function formatNumber(num: number, scale: number): string {
  if (scale === 0) {
    return String(Math.floor(num));
  }

  // Format with specified decimal places
  const fixed = num.toFixed(scale);

  // Remove trailing zeros after decimal point
  return fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
