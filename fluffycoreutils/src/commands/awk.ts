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
    const awkContext: AwkContext = {
      FS: values.F || " ",  // Field separator
      OFS: " ",             // Output field separator
      RS: "\n",             // Record separator
      ORS: "\n",            // Output record separator
      NR: 0,                // Number of records
      NF: 0,                // Number of fields
      FILENAME: files[0] || "-",
      variables: {} as Record<string, string>,
      arrays: {} as Record<string, Record<string, string>>,
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

      // Parse blocks: extract BEGIN, END, and main action blocks
      // Use brace-depth counting instead of [^}] to handle nested braces
      const blocks = parseBlocks(program);

      // Execute BEGIN block
      if (blocks.begin) {
        const result = executeAction(blocks.begin, [], awkContext);
        if (result) output.push(result);
      }

      // Process each line
      for (const line of lines) {
        awkContext.NR++;

        // Split by field separator
        const fieldSepRegex = typeof awkContext.FS === "string" && awkContext.FS !== " "
          ? new RegExp(awkContext.FS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          : /\s+/;
        const fields = awkContext.FS === " "
          ? line.split(fieldSepRegex).filter(f => f !== "")
          : line.split(fieldSepRegex);
        awkContext.NF = fields.length;

        if (blocks.main) {
          let shouldProcess = true;
          if (blocks.mainPattern) {
            try {
              shouldProcess = new RegExp(blocks.mainPattern).test(line);
            } catch {
              shouldProcess = false;
            }
          }
          if (shouldProcess) {
            const result = executeAction(blocks.main, fields, awkContext);
            if (result !== null) output.push(result);
          }
        } else if (!blocks.begin && !blocks.end) {
          const result = executeAction(program, fields, awkContext);
          if (result !== null) output.push(result);
        }
      }

      // Execute END block
      if (blocks.end) {
        const result = executeAction(blocks.end, [], awkContext);
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
  arrays: Record<string, Record<string, string>>;
}

interface AwkBlocks {
  begin?: string;
  end?: string;
  main?: string;
  mainPattern?: string;
}

/** Extract BEGIN, END, and main blocks using brace-depth counting. */
function parseBlocks(program: string): AwkBlocks {
  const result: AwkBlocks = {};
  let i = 0;
  const p = program.trim();

  while (i < p.length) {
    // Skip whitespace
    while (i < p.length && /\s/.test(p[i])) i++;
    if (i >= p.length) break;

    // Check for BEGIN
    if (p.startsWith("BEGIN", i) && (i + 5 >= p.length || /[\s{]/.test(p[i + 5]))) {
      i += 5;
      while (i < p.length && /\s/.test(p[i])) i++;
      if (p[i] === '{') {
        const body = extractBlock(p, i);
        result.begin = body.content;
        i = body.end;
        continue;
      }
    }

    // Check for END
    if (p.startsWith("END", i) && (i + 3 >= p.length || /[\s{]/.test(p[i + 3]))) {
      i += 3;
      while (i < p.length && /\s/.test(p[i])) i++;
      if (p[i] === '{') {
        const body = extractBlock(p, i);
        result.end = body.content;
        i = body.end;
        continue;
      }
    }

    // Check for /pattern/ { action }
    if (p[i] === '/') {
      const endSlash = p.indexOf('/', i + 1);
      if (endSlash > i) {
        result.mainPattern = p.slice(i + 1, endSlash);
        i = endSlash + 1;
        while (i < p.length && /\s/.test(p[i])) i++;
      }
    }

    // Main action block
    if (p[i] === '{') {
      const body = extractBlock(p, i);
      result.main = body.content;
      i = body.end;
      continue;
    }

    i++;
  }

  return result;
}

/** Extract content between matched braces, handling nesting. */
function extractBlock(str: string, start: number): { content: string; end: number } {
  let depth = 0;
  let i = start;
  while (i < str.length) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth === 0) {
        return { content: str.slice(start + 1, i), end: i + 1 };
      }
    }
    i++;
  }
  return { content: str.slice(start + 1), end: str.length };
}

/** Substitute only $N field references (not arrays/variables) for use in LHS of assignments. */
function resolveFieldRefs(ref: string, fields: string[]): string {
  return ref.replace(/\$(\d+)/g, (_, n) => fields[parseInt(n) - 1] || "");
}

/** Resolve a variable or array reference to its value. */
function resolveVar(name: string, ctx: AwkContext): number {
  // Check for array reference: name[key]
  const arrMatch = name.match(/^(\w+)\[(.+)\]$/);
  if (arrMatch) {
    const [, arrName, key] = arrMatch;
    return parseFloat(ctx.arrays[arrName]?.[key]) || 0;
  }
  return parseFloat(ctx.variables[name]) || 0;
}

/** Set a variable or array element. */
function setVar(name: string, value: string, ctx: AwkContext): void {
  const arrMatch = name.match(/^(\w+)\[(.+)\]$/);
  if (arrMatch) {
    const [, arrName, key] = arrMatch;
    if (!ctx.arrays[arrName]) ctx.arrays[arrName] = {};
    ctx.arrays[arrName][key] = value;
  } else {
    ctx.variables[name] = value;
  }
}

function executeAction(
  action: string,
  fields: string[],
  ctx: AwkContext
): string | null {
  let code = action.trim();

  // Process string functions
  code = processStringFunctions(code, fields, ctx);

  // Split on ; but not inside quotes or parens
  const statements = splitStatements(code);
  let printResult: string | null = null;

  for (const rawStmt of statements) {
    const stmt = rawStmt.trim();
    if (!stmt) continue;

    const r = execStatement(stmt, fields, ctx);
    if (r !== null) printResult = r;
  }

  return printResult;
}

function splitStatements(code: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  let inStr = false;
  let strCh = "";

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      current += ch;
      if (ch === strCh && code[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '{') { depth++; current += ch; continue; }
    if (ch === ')' || ch === '}') { depth--; current += ch; continue; }
    if (ch === ';' && depth === 0) {
      result.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current);
  return result;
}

function execStatement(
  stmt: string,
  fields: string[],
  ctx: AwkContext
): string | null {
  const s = stmt.trim();
  if (!s) return null;

  // Handle for(k in arr) { ... } or for(k in arr) stmt
  const forInMatch = s.match(/^for\s*\(\s*(\w+)\s+in\s+(\w+)\s*\)\s*(.+)$/);
  if (forInMatch) {
    const [, iterVar, arrName, body] = forInMatch;
    const arr = ctx.arrays[arrName];
    if (!arr) return null;
    let result: string | null = null;
    for (const key of Object.keys(arr)) {
      ctx.variables[iterVar] = key;
      const r = execStatement(body, fields, ctx);
      if (r !== null) {
        result = result !== null ? result + "\n" + r : r;
      }
    }
    return result;
  }

  // Handle printf statement
  if (s.startsWith("printf")) {
    const printfMatch = s.match(/printf\s+(.+)/);
    if (printfMatch) {
      return formatPrintf(printfMatch[1], fields, ctx);
    }
    return null;
  }

  // Handle print statement
  if (s.startsWith("print")) {
    const printExpr = s.substring(5).trim();

    if (!printExpr || printExpr === "") {
      return fields.join(ctx.OFS);
    } else if (printExpr.includes(",")) {
      const parts = printExpr.split(/\s*,\s*/);
      const outputs = parts.map(part => {
        let output = substituteVariables(part.trim(), fields, ctx);
        output = evaluateArithmetic(output);
        return output.replace(/^["'](.*)["']$/, "$1");
      });
      return outputs.join(ctx.OFS);
    } else {
      let output = substituteVariables(printExpr, fields, ctx);
      output = evaluateArithmetic(output);
      output = output.replace(/^["'](.*)["']$/, "$1");
      output = output.replace(/\s+/g, " ").trim();
      return output;
    }
  }

  // Handle increment/decrement: var++ or arr[key]++
  const incrMatch = s.match(/^(\w+(?:\[[^\]]+\])?)(\+\+|--)$/);
  if (incrMatch) {
    const [, ref, op] = incrMatch;
    // Only substitute $N field refs in the key, not the whole array reference
    const resolved = resolveFieldRefs(ref, fields);
    const current = resolveVar(resolved, ctx);
    setVar(resolved, String(op === "++" ? current + 1 : current - 1), ctx);
    return null;
  }

  // Handle assignment: var[key] op= expr or var op= expr
  const assignMatch = s.match(/^(\w+(?:\[[^\]]+\])?)\s*([\+\-\*\/]?)=\s*(.+)$/);
  if (assignMatch) {
    const [, ref, op, exprStr] = assignMatch;
    // Only substitute $N field refs in LHS, not full variable resolution
    const resolved = resolveFieldRefs(ref, fields);
    let value = substituteVariables(exprStr, fields, ctx);
    value = evaluateArithmetic(value);
    const numVal = parseFloat(value) || 0;
    const current = resolveVar(resolved, ctx);

    switch (op) {
      case "+": setVar(resolved, String(current + numVal), ctx); break;
      case "-": setVar(resolved, String(current - numVal), ctx); break;
      case "*": setVar(resolved, String(current * numVal), ctx); break;
      case "/": setVar(resolved, String(current / numVal), ctx); break;
      default: setVar(resolved, String(numVal), ctx); break;
    }
    return null;
  }

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

  // Replace array references: arr[key]
  output = output.replace(/(\w+)\[([^\]]+)\]/g, (_, arrName, key) => {
    const resolvedKey = substituteVariables(key, fields, ctx);
    return ctx.arrays[arrName]?.[resolvedKey] ?? "0";
  });

  // Replace user variables (but not array names that were already handled)
  for (const [key, value] of Object.entries(ctx.variables)) {
    output = output.replace(new RegExp(`\\b${key}\\b`, "g"), value);
  }

  return output;
}

function evaluateArithmetic(str: string): string {
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
  // Split carefully — don't split on commas inside array brackets
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inStr = false;
  let strCh = "";

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inStr) {
      current += ch;
      if (ch === strCh && expr[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; current += ch; continue; }
    if (ch === '[') { depth++; current += ch; continue; }
    if (ch === ']') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0 && !inStr) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  if (parts.length === 0) return "";

  // Extract format string (remove quotes)
  let format = parts[0].trim().replace(/^["'](.*)["']$/, "$1");

  // Get arguments
  const args: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    let arg = substituteVariables(parts[i].trim(), fields, ctx);
    arg = evaluateArithmetic(arg);
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
        formatted = arg;
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

  // length(s)
  result = result.replace(/length\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    const str = arg ? substituteVariables(arg, fields, ctx) : fields.join(ctx.OFS);
    return String(str.length);
  });

  // substr(s, start, length)
  result = result.replace(/substr\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, str, start, len) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const startIdx = parseInt(substituteVariables(start.trim(), fields, ctx)) - 1;
    const length = len ? parseInt(substituteVariables(len.trim(), fields, ctx)) : undefined;
    return length ? s.slice(startIdx, startIdx + length) : s.slice(startIdx);
  });

  // index(s, t)
  result = result.replace(/index\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (_, str, substr) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const t = substituteVariables(substr.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const idx = s.indexOf(t);
    return String(idx === -1 ? 0 : idx + 1);
  });

  // tolower(s)
  result = result.replace(/tolower\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    return substituteVariables(arg, fields, ctx).toLowerCase();
  });

  // toupper(s)
  result = result.replace(/toupper\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    return substituteVariables(arg, fields, ctx).toUpperCase();
  });

  // split(s, a, fs)
  result = result.replace(/split\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, str, arr, sep) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const separator = sep ? substituteVariables(sep.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1") : ctx.FS;
    const parts = s.split(new RegExp(separator));
    return String(parts.length);
  });

  // gsub(regex, replacement, target)
  result = result.replace(/gsub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, pattern, repl, target) => {
    const pat = substituteVariables(pattern.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const replacement = substituteVariables(repl.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const tgt = target ? substituteVariables(target.trim(), fields, ctx) : fields[0] || "";
    try { return tgt.replace(new RegExp(pat, "g"), replacement); } catch { return tgt; }
  });

  // sub(regex, replacement, target)
  result = result.replace(/sub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, pattern, repl, target) => {
    const pat = substituteVariables(pattern.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const replacement = substituteVariables(repl.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const tgt = target ? substituteVariables(target.trim(), fields, ctx) : fields[0] || "";
    try { return tgt.replace(new RegExp(pat), replacement); } catch { return tgt; }
  });

  // match(s, regex)
  result = result.replace(/match\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (_, str, pattern) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const pat = substituteVariables(pattern.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    try {
      const m = s.match(new RegExp(pat));
      return m ? String(m.index! + 1) : "0";
    } catch { return "0"; }
  });

  return result;
}
