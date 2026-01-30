import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const awk: FluffyCommand = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["F", "v"]);

    if (positional.length === 0) {
      return { stdout: "", stderr: "awk: missing program\n", exitCode: 1 };
    }

    // First positional arg is the program, rest are files
    const program = positional[0];
    const files = positional.slice(1);

    // AWK context with built-in variables
    const awkContext = {
      FS: values.F || " ",  // Field separator
      OFS: " ",             // Output field separator
      RS: "\n",             // Record separator
      ORS: "\n",            // Output record separator
      NR: 0,                // Number of records
      NF: 0,                // Number of fields
      FILENAME: files[0] || "-",
      variables: {} as Record<string, string>,
    };

    // User variables (-v var=value)
    if (values.v) {
      const parts = values.v.split("=");
      if (parts.length === 2) {
        awkContext.variables[parts[0]] = parts[1];
      }
    }

    try {
      const { content } = await readInput(
        files,
        io.stdin,
        io.fs,
        io.cwd,
        io.fs.resolvePath
      );

      const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
      const output: string[] = [];

      // Parse the AWK program (simplified - supports basic patterns and actions)
      // Format: /pattern/ { action } or BEGIN { action } or { action }
      const beginMatch = program.match(/BEGIN\s*\{\s*([^}]*)\s*\}/);
      const endMatch = program.match(/END\s*\{\s*([^}]*)\s*\}/);
      const mainMatch = program.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);

      // Execute BEGIN block
      if (beginMatch) {
        const result = executeAction(beginMatch[1], [], awkContext);
        if (result) output.push(result);
      }

      // Process each line
      for (const line of lines) {
        awkContext.NR++;

        // Split by field separator
        const fieldSepRegex = typeof awkContext.FS === "string" && awkContext.FS !== " "
          ? new RegExp(awkContext.FS)
          : /\s+/;
        const fields = line.split(fieldSepRegex).filter(f => f !== "");
        awkContext.NF = fields.length;

        // Check if we have a pattern
        let shouldProcess = true;
        if (mainMatch) {
          const pattern = mainMatch[1];
          const action = mainMatch[2];

          if (pattern) {
            // Simple pattern matching (regex)
            try {
              const patternRegex = new RegExp(pattern);
              shouldProcess = patternRegex.test(line);
            } catch {
              shouldProcess = false;
            }
          }

          if (shouldProcess) {
            const result = executeAction(action, fields, awkContext);
            if (result !== null) output.push(result);
          }
        } else if (!beginMatch && !endMatch) {
          // No braces - treat as action for all lines
          const result = executeAction(program, fields, awkContext);
          if (result !== null) output.push(result);
        }
      }

      // Execute END block
      if (endMatch) {
        const result = executeAction(endMatch[1], [], awkContext);
        if (result) output.push(result);
      }

      return {
        stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `awk: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

interface AwkContext {
  FS: string;
  OFS: string;
  RS: string;
  ORS: string;
  NR: number;
  NF: number;
  FILENAME: string;
  variables: Record<string, string>;
}

function executeAction(
  action: string,
  fields: string[],
  ctx: AwkContext
): string | null {
  // Replace AWK special variables
  let code = action.trim();

  // Process string functions
  code = processStringFunctions(code, fields, ctx);

  // Handle printf statement
  if (code.startsWith("printf")) {
    const printfMatch = code.match(/printf\s+(.+)/);
    if (printfMatch) {
      return formatPrintf(printfMatch[1], fields, ctx);
    }
  }

  // Handle print statement
  if (code.startsWith("print")) {
    const printExpr = code.substring(5).trim();

    if (!printExpr || printExpr === "") {
      // print with no args prints the whole line
      return fields.join(ctx.OFS);
    }

    // Handle comma-separated print arguments (use OFS)
    if (printExpr.includes(",")) {
      const parts = printExpr.split(/\s*,\s*/);
      const outputs = parts.map(part => {
        let output = substituteVariables(part.trim(), fields, ctx);
        output = evaluateArithmetic(output);
        return output.replace(/^["'](.*)["']$/, "$1");
      });
      return outputs.join(ctx.OFS);
    }

    // Replace field references $1, $2, etc.
    let output = printExpr;

    // Substitute variables and fields
    output = substituteVariables(output, fields, ctx);

    // Evaluate arithmetic expressions if present
    output = evaluateArithmetic(output);

    // Remove quotes if present
    output = output.replace(/^["'](.*)["']$/, "$1");

    // Handle string concatenation (space-separated items)
    output = output.replace(/\s+/g, " ").trim();

    return output;
  }

  // If no print statement, return null (no output)
  return null;
}

function substituteVariables(
  str: string,
  fields: string[],
  ctx: AwkContext
): string {
  let output = str;

  // Replace $0 with whole line
  output = output.replace(/\$0/g, fields.join(ctx.OFS));

  // Replace $NF with last field
  output = output.replace(/\$NF/g, fields[fields.length - 1] || "");

  // Replace numbered fields
  for (let i = 1; i <= fields.length; i++) {
    output = output.replace(new RegExp(`\\$${i}\\b`, "g"), fields[i - 1] || "");
  }

  // Replace built-in variables
  output = output.replace(/\bNR\b/g, String(ctx.NR));
  output = output.replace(/\bNF\b/g, String(ctx.NF));
  output = output.replace(/\bFS\b/g, ctx.FS);
  output = output.replace(/\bOFS\b/g, ctx.OFS);
  output = output.replace(/\bRS\b/g, ctx.RS);
  output = output.replace(/\bORS\b/g, ctx.ORS);
  output = output.replace(/\bFILENAME\b/g, ctx.FILENAME);

  // Replace user variables
  for (const [key, value] of Object.entries(ctx.variables)) {
    output = output.replace(new RegExp(`\\b${key}\\b`, "g"), value);
  }

  return output;
}

function evaluateArithmetic(str: string): string {
  // Simple arithmetic evaluation for expressions like "$1 + $2" or "NR * 2"
  // Only evaluates if the entire string is a simple arithmetic expression
  const arithmeticPattern = /^([\d.]+)\s*([\+\-\*\/])\s*([\d.]+)$/;
  const match = str.match(arithmeticPattern);

  if (match) {
    const left = parseFloat(match[1]);
    const op = match[2];
    const right = parseFloat(match[3]);

    let result: number;
    switch (op) {
      case "+": result = left + right; break;
      case "-": result = left - right; break;
      case "*": result = left * right; break;
      case "/": result = left / right; break;
      default: return str;
    }

    return String(result);
  }

  return str;
}

function formatPrintf(
  expr: string,
  fields: string[],
  ctx: AwkContext
): string {
  // Parse printf format: printf "format", arg1, arg2, ...
  const parts = expr.split(/,\s*/);
  if (parts.length === 0) return "";

  // Extract format string (remove quotes)
  let format = parts[0].trim().replace(/^["'](.*)["']$/, "$1");

  // Get arguments
  const args: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const arg = substituteVariables(parts[i].trim(), fields, ctx);
    args.push(arg);
  }

  // Process format string
  let output = format;
  let argIdx = 0;

  // Replace format specifiers
  output = output.replace(/%(-)?(\d+)?(?:\.(\d+))?([sdifgex%])/g, (match, leftAlign, width, precision, type) => {
    if (type === "%") return "%";

    if (argIdx >= args.length) return match;
    const arg = args[argIdx++];

    let formatted: string;
    switch (type) {
      case "s": // string
        formatted = arg;
        break;
      case "d": // decimal integer
      case "i": // integer
        formatted = String(parseInt(arg) || 0);
        break;
      case "f": // floating point
        const num = parseFloat(arg) || 0;
        formatted = precision ? num.toFixed(parseInt(precision)) : String(num);
        break;
      case "g": // general format
      case "e": // exponential
      case "x": // hexadecimal
        formatted = arg; // Simplified implementation
        break;
      default:
        formatted = arg;
    }

    // Apply width
    if (width) {
      const w = parseInt(width);
      if (leftAlign) {
        formatted = formatted.padEnd(w, " ");
      } else {
        formatted = formatted.padStart(w, " ");
      }
    }

    return formatted;
  });

  // Handle escape sequences
  output = output.replace(/\\n/g, "\n");
  output = output.replace(/\\t/g, "\t");
  output = output.replace(/\\r/g, "\r");
  output = output.replace(/\\\\/g, "\\");

  // Remove trailing newline for consistency
  if (output.endsWith("\n")) {
    output = output.slice(0, -1);
  }

  return output;
}

function processStringFunctions(
  code: string,
  fields: string[],
  ctx: AwkContext
): string {
  let result = code;

  // length(s) - return length of string s
  result = result.replace(/length\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    const str = arg ? substituteVariables(arg, fields, ctx) : fields.join(ctx.OFS);
    return String(str.length);
  });

  // substr(s, start, length) - extract substring
  result = result.replace(/substr\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, str, start, len) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const startIdx = parseInt(substituteVariables(start.trim(), fields, ctx)) - 1; // AWK uses 1-based indexing
    const length = len ? parseInt(substituteVariables(len.trim(), fields, ctx)) : undefined;
    return length ? s.slice(startIdx, startIdx + length) : s.slice(startIdx);
  });

  // index(s, t) - return position of substring t in s (1-based, 0 if not found)
  result = result.replace(/index\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (_, str, substr) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const t = substituteVariables(substr.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const idx = s.indexOf(t);
    return String(idx === -1 ? 0 : idx + 1); // AWK uses 1-based indexing
  });

  // tolower(s) - convert to lowercase
  result = result.replace(/tolower\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    const str = substituteVariables(arg, fields, ctx);
    return str.toLowerCase();
  });

  // toupper(s) - convert to uppercase
  result = result.replace(/toupper\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    const str = substituteVariables(arg, fields, ctx);
    return str.toUpperCase();
  });

  // split(s, a, fs) - split string s into array a using separator fs
  // Note: This is a simplified version that doesn't create actual arrays
  result = result.replace(/split\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, str, arr, sep) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const separator = sep ? substituteVariables(sep.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1") : ctx.FS;
    const parts = s.split(new RegExp(separator));
    return String(parts.length);
  });

  // gsub(regex, replacement, target) - global substitution
  result = result.replace(/gsub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, pattern, repl, target) => {
    const pat = substituteVariables(pattern.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const replacement = substituteVariables(repl.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const tgt = target ? substituteVariables(target.trim(), fields, ctx) : fields[0] || "";
    try {
      const regex = new RegExp(pat, "g");
      return tgt.replace(regex, replacement);
    } catch {
      return tgt;
    }
  });

  // sub(regex, replacement, target) - single substitution
  result = result.replace(/sub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, pattern, repl, target) => {
    const pat = substituteVariables(pattern.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const replacement = substituteVariables(repl.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const tgt = target ? substituteVariables(target.trim(), fields, ctx) : fields[0] || "";
    try {
      const regex = new RegExp(pat);
      return tgt.replace(regex, replacement);
    } catch {
      return tgt;
    }
  });

  // match(s, regex) - return position of regex match (1-based, 0 if no match)
  result = result.replace(/match\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (_, str, pattern) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const pat = substituteVariables(pattern.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    try {
      const regex = new RegExp(pat);
      const match = s.match(regex);
      return match ? String(match.index! + 1) : "0"; // AWK uses 1-based indexing
    } catch {
      return "0";
    }
  });

  return result;
}
