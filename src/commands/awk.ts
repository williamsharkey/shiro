
import type { Command } from './index';
import { parseArgs, readInput } from './flags';

// Signal classes for control flow
class AwkNext {}
class AwkExit { constructor(public code: number) {} }

export const awk: Command = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["F", "v"]);

    if (positional.length === 0) {
      ctx.stderr += "awk: missing program\n";
      return 1;
    }

    const program = positional[0];
    const files = positional.slice(1);

    const awkCtx: AwkContext = {
      FS: values.F || " ",
      OFS: " ",
      RS: "\n",
      ORS: "\n",
      NR: 0,
      NF: 0,
      FILENAME: files[0] || "-",
      variables: {},
      arrays: {},
    };

    // User variables (-v var=value)
    if (values.v) {
      const parts = values.v.split("=");
      if (parts.length === 2) {
        awkCtx.variables[parts[0]] = parts[1];
      }
    }

    try {
      const { content } = await readInput(files, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
      const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
      const output: string[] = [];

      const blocks = parseBlocks(program);

      // Execute BEGIN block
      if (blocks.begin) {
        const r = executeBlock(blocks.begin, [], awkCtx);
        if (r !== null) output.push(r);
      }

      // Process each line
      let exitCode = 0;
      try {
        for (const line of lines) {
          awkCtx.NR++;
          const fieldSepRegex = typeof awkCtx.FS === "string" && awkCtx.FS !== " "
            ? new RegExp(awkCtx.FS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            : /\s+/;
          const fields = awkCtx.FS === " "
            ? line.split(fieldSepRegex).filter(f => f !== "")
            : line.split(fieldSepRegex);
          awkCtx.NF = fields.length;

          // Process all pattern-action pairs
          try {
            for (const rule of blocks.rules) {
              let shouldProcess = true;
              if (rule.pattern) {
                if (rule.pattern.startsWith('/') && rule.pattern.endsWith('/')) {
                  const pat = rule.pattern.slice(1, -1);
                  try { shouldProcess = new RegExp(pat).test(line); } catch { shouldProcess = false; }
                } else {
                  // Expression pattern
                  shouldProcess = evalCondition(rule.pattern, fields, awkCtx);
                }
              }
              if (shouldProcess) {
                const r = executeBlock(rule.action, fields, awkCtx);
                if (r !== null) output.push(r);
              }
            }
          } catch (e) {
            if (e instanceof AwkNext) continue;
            throw e;
          }
        }
      } catch (e) {
        if (e instanceof AwkExit) {
          exitCode = e.code;
        } else {
          throw e;
        }
      }

      // Execute END block
      if (blocks.end) {
        const r = executeBlock(blocks.end, [], awkCtx);
        if (r !== null) output.push(r);
      }

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return exitCode;
    } catch (e: unknown) {
      ctx.stderr += `awk: ${e instanceof Error ? e.message : e}\n`;
      return 1;
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

interface AwkRule {
  pattern: string | null;
  action: string;
}

interface AwkBlocks {
  begin?: string;
  end?: string;
  rules: AwkRule[];
}

function parseBlocks(program: string): AwkBlocks {
  const result: AwkBlocks = { rules: [] };
  let i = 0;
  const p = program.trim();

  while (i < p.length) {
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

    // Check for /pattern/ { action } or condition { action } or just { action }
    let pattern: string | null = null;

    if (p[i] === '/') {
      const endSlash = p.indexOf('/', i + 1);
      if (endSlash > i) {
        pattern = p.slice(i, endSlash + 1);
        i = endSlash + 1;
        while (i < p.length && /\s/.test(p[i])) i++;
      }
    } else if (p[i] !== '{') {
      // Condition expression (e.g. $1 > 5)
      let condStart = i;
      while (i < p.length && p[i] !== '{') i++;
      pattern = p.slice(condStart, i).trim();
      if (!pattern) pattern = null;
    }

    if (p[i] === '{') {
      const body = extractBlock(p, i);
      result.rules.push({ pattern, action: body.content });
      i = body.end;
      continue;
    }

    // If we have just a pattern with no block at all, treat the whole program as action
    if (i >= p.length && result.rules.length === 0 && !result.begin && !result.end) {
      result.rules.push({ pattern: null, action: p });
      break;
    }

    i++;
  }

  // If no blocks were found, treat entire program as action
  if (result.rules.length === 0 && !result.begin && !result.end) {
    result.rules.push({ pattern: null, action: p });
  }

  return result;
}

function extractBlock(str: string, start: number): { content: string; end: number } {
  let depth = 0;
  let i = start;
  let inStr = false;
  let strCh = '';
  while (i < str.length) {
    if (inStr) {
      if (str[i] === strCh && str[i - 1] !== '\\') inStr = false;
      i++;
      continue;
    }
    if (str[i] === '"' || str[i] === "'") { inStr = true; strCh = str[i]; }
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth === 0) return { content: str.slice(start + 1, i), end: i + 1 };
    }
    i++;
  }
  return { content: str.slice(start + 1), end: str.length };
}

function resolveFieldRefs(ref: string, fields: string[]): string {
  return ref.replace(/\$(\d+)/g, (_, n) => fields[parseInt(n) - 1] || "");
}

function resolveVar(name: string, ctx: AwkContext): number {
  const arrMatch = name.match(/^(\w+)\[(.+)\]$/);
  if (arrMatch) {
    const [, arrName, key] = arrMatch;
    return parseFloat(ctx.arrays[arrName]?.[key]) || 0;
  }
  return parseFloat(ctx.variables[name]) || 0;
}

function getVarStr(name: string, ctx: AwkContext): string {
  const arrMatch = name.match(/^(\w+)\[(.+)\]$/);
  if (arrMatch) {
    const [, arrName, key] = arrMatch;
    return ctx.arrays[arrName]?.[key] ?? "";
  }
  return ctx.variables[name] ?? "";
}

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

function evalCondition(cond: string, fields: string[], ctx: AwkContext): boolean {
  const c = cond.trim();

  // Check for (key in array) — membership test
  const inMatch = c.match(/^\(?\s*(\S+)\s+in\s+(\w+)\s*\)?$/);
  if (inMatch) {
    const key = substituteVariables(inMatch[1], fields, ctx);
    return ctx.arrays[inMatch[2]]?.[key] !== undefined;
  }

  // Comparison operators
  const compMatch = c.match(/^(.+?)\s*(==|!=|>=|<=|>|<|~|!~)\s*(.+)$/);
  if (compMatch) {
    let left = substituteVariables(compMatch[1].trim(), fields, ctx);
    left = evaluateExpr(left);
    let right = substituteVariables(compMatch[3].trim(), fields, ctx);
    right = evaluateExpr(right);
    const op = compMatch[2];
    const lNum = parseFloat(left);
    const rNum = parseFloat(right);
    const bothNum = !isNaN(lNum) && !isNaN(rNum) && left.trim() !== '' && right.trim() !== '';

    switch (op) {
      case '==': return bothNum ? lNum === rNum : left === right;
      case '!=': return bothNum ? lNum !== rNum : left !== right;
      case '>': return bothNum ? lNum > rNum : left > right;
      case '<': return bothNum ? lNum < rNum : left < right;
      case '>=': return bothNum ? lNum >= rNum : left >= right;
      case '<=': return bothNum ? lNum <= rNum : left <= right;
      case '~': try { return new RegExp(right.replace(/^\/|\/$/g, '')).test(left); } catch { return false; }
      case '!~': try { return !new RegExp(right.replace(/^\/|\/$/g, '')).test(left); } catch { return true; }
    }
  }

  // Regex match: /pattern/
  if (c.startsWith('/') && c.endsWith('/')) {
    try { return new RegExp(c.slice(1, -1)).test(fields.join(ctx.OFS)); } catch { return false; }
  }

  // Truthy check
  const val = substituteVariables(c, fields, ctx);
  const num = parseFloat(val);
  if (!isNaN(num)) return num !== 0;
  return val !== '' && val !== '0';
}

function executeBlock(action: string, fields: string[], ctx: AwkContext): string | null {
  let code = action.trim();
  code = processStringFunctions(code, fields, ctx);
  const statements = splitStatements(code);
  let printResult: string | null = null;

  for (const rawStmt of statements) {
    const stmt = rawStmt.trim();
    if (!stmt) continue;
    const r = execStatement(stmt, fields, ctx);
    if (r !== null) printResult = printResult !== null ? printResult + "\n" + r : r;
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
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; current += ch; continue; }
    if (ch === '(' || ch === '{') { depth++; current += ch; continue; }
    if (ch === ')' || ch === '}') { depth--; current += ch; continue; }
    if (ch === ';' && depth === 0) { result.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) result.push(current);
  return result;
}

function execStatement(stmt: string, fields: string[], ctx: AwkContext): string | null {
  const s = stmt.trim();
  if (!s) return null;

  // Handle next
  if (s === 'next') throw new AwkNext();

  // Handle exit
  const exitMatch = s.match(/^exit\s*(\d*)$/);
  if (exitMatch) throw new AwkExit(parseInt(exitMatch[1] || '0', 10));

  // Handle delete array[key]
  const deleteMatch = s.match(/^delete\s+(\w+)\[([^\]]+)\]$/);
  if (deleteMatch) {
    const [, arrName, key] = deleteMatch;
    const resolvedKey = substituteVariables(key, fields, ctx);
    if (ctx.arrays[arrName]) delete ctx.arrays[arrName][resolvedKey];
    return null;
  }

  // Handle if/else
  if (s.startsWith('if')) {
    return execIfElse(s, fields, ctx);
  }

  // Handle while(cond) { ... }
  const whileMatch = s.match(/^while\s*\((.+?)\)\s*\{([\s\S]*)\}$/);
  if (whileMatch) {
    const [, cond, body] = whileMatch;
    let result: string | null = null;
    let safety = 10000;
    while (evalCondition(cond, fields, ctx) && safety-- > 0) {
      const r = executeBlock(body, fields, ctx);
      if (r !== null) result = result !== null ? result + "\n" + r : r;
    }
    return result;
  }

  // Handle C-style for(init; cond; incr) { ... }
  const forMatch = s.match(/^for\s*\(\s*([^;]*)\s*;\s*([^;]*)\s*;\s*([^)]*)\s*\)\s*\{([\s\S]*)\}$/);
  if (forMatch) {
    const [, init, cond, incr, body] = forMatch;
    if (init.trim()) execStatement(init.trim(), fields, ctx);
    let result: string | null = null;
    let safety = 10000;
    while (evalCondition(cond.trim(), fields, ctx) && safety-- > 0) {
      const r = executeBlock(body, fields, ctx);
      if (r !== null) result = result !== null ? result + "\n" + r : r;
      if (incr.trim()) execStatement(incr.trim(), fields, ctx);
    }
    return result;
  }

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
      if (r !== null) result = result !== null ? result + "\n" + r : r;
    }
    return result;
  }

  // Handle printf statement
  if (s.startsWith("printf")) {
    const printfMatch = s.match(/printf\s+(.+)/);
    if (printfMatch) return formatPrintf(printfMatch[1], fields, ctx);
    return null;
  }

  // Handle print statement
  if (s.startsWith("print")) {
    const printExpr = s.substring(5).trim();

    if (!printExpr || printExpr === "") {
      return fields.join(ctx.OFS);
    } else if (printExpr.includes(",")) {
      const parts = smartSplit(printExpr, ',');
      const outputs = parts.map(part => {
        let p = part.trim();
        // Strip string literal quotes before substitution
        if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
          return p.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        }
        let output = substituteVariables(p, fields, ctx);
        output = evaluateExpr(output);
        return output.replace(/^["'](.*)["']$/, "$1");
      });
      return outputs.join(ctx.OFS);
    } else {
      let p = printExpr;
      // Strip string literal quotes
      if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
        return p.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      }
      let output = substituteVariables(p, fields, ctx);
      output = evaluateExpr(output);
      output = output.replace(/^["'](.*)["']$/, "$1");
      output = output.replace(/\s+/g, " ").trim();
      return output;
    }
  }

  // Handle increment/decrement
  const incrMatch = s.match(/^(\w+(?:\[[^\]]+\])?)(\+\+|--)$/);
  if (incrMatch) {
    const [, ref, op] = incrMatch;
    const resolved = resolveFieldRefs(ref, fields);
    const current = resolveVar(resolved, ctx);
    setVar(resolved, String(op === "++" ? current + 1 : current - 1), ctx);
    return null;
  }

  // Handle assignment
  const assignMatch = s.match(/^(\w+(?:\[[^\]]+\])?)\s*([\+\-\*\/]?)=\s*(.+)$/);
  if (assignMatch) {
    const [, ref, op, exprStr] = assignMatch;
    const resolved = resolveFieldRefs(ref, fields);
    let value = substituteVariables(exprStr, fields, ctx);
    value = evaluateExpr(value);

    if (op) {
      const numVal = parseFloat(value) || 0;
      const current = resolveVar(resolved, ctx);
      switch (op) {
        case "+": setVar(resolved, String(current + numVal), ctx); break;
        case "-": setVar(resolved, String(current - numVal), ctx); break;
        case "*": setVar(resolved, String(current * numVal), ctx); break;
        case "/": setVar(resolved, String(current / numVal), ctx); break;
      }
    } else {
      // Plain assignment — could be string or number
      const stripped = value.replace(/^["'](.*)["']$/, '$1');
      setVar(resolved, stripped, ctx);
    }
    return null;
  }

  return null;
}

function execIfElse(s: string, fields: string[], ctx: AwkContext): string | null {
  // Parse: if (cond) { body } else if (cond) { body } else { body }
  // Also: if (cond) stmt; else stmt
  const ifMatch = s.match(/^if\s*\((.+?)\)\s*\{([\s\S]*?)\}(?:\s*else\s+if\s*\((.+?)\)\s*\{([\s\S]*?)\})*(?:\s*else\s*\{([\s\S]*?)\})?$/);
  if (ifMatch) {
    if (evalCondition(ifMatch[1], fields, ctx)) {
      return executeBlock(ifMatch[2], fields, ctx);
    }
    // Check else-if chains
    const rest = s.slice(ifMatch[0].indexOf('}') + 1).trim();
    if (rest.startsWith('else if')) {
      return execIfElse(rest.slice(5).trim(), fields, ctx);
    }
    if (ifMatch[5] !== undefined) {
      return executeBlock(ifMatch[5], fields, ctx);
    }
    return null;
  }

  // Simpler form: if (cond) stmt
  const simpleIf = s.match(/^if\s*\((.+?)\)\s+(.+?)(?:\s+else\s+(.+))?$/);
  if (simpleIf) {
    if (evalCondition(simpleIf[1], fields, ctx)) {
      // Handle braced body
      const body = simpleIf[2].trim();
      if (body.startsWith('{') && body.endsWith('}')) {
        return executeBlock(body.slice(1, -1), fields, ctx);
      }
      return execStatement(body, fields, ctx);
    } else if (simpleIf[3]) {
      const elseBody = simpleIf[3].trim();
      if (elseBody.startsWith('{') && elseBody.endsWith('}')) {
        return executeBlock(elseBody.slice(1, -1), fields, ctx);
      }
      return execStatement(elseBody, fields, ctx);
    }
    return null;
  }

  return null;
}

function smartSplit(str: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) { current += ch; if (ch === strCh && str[i - 1] !== '\\') inStr = false; continue; }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; current += ch; continue; }
    if (ch === '(' || ch === '[') { depth++; current += ch; continue; }
    if (ch === ')' || ch === ']') { depth--; current += ch; continue; }
    if (ch === delimiter && depth === 0) { result.push(current); current = ''; continue; }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}

function substituteVariables(str: string, fields: string[], ctx: AwkContext): string {
  let output = str;

  // Handle string concatenation with spaces (e.g. "foo" " " "bar")
  // and sprintf
  const sprintfMatch = output.match(/sprintf\s*\((.+)\)/);
  if (sprintfMatch) {
    const result = formatPrintf(sprintfMatch[1], fields, ctx);
    output = output.replace(/sprintf\s*\(.+\)/, result || '');
  }

  // Ternary operator: cond ? val1 : val2
  const ternMatch = output.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);
  if (ternMatch) {
    const cond = evalCondition(ternMatch[1].trim(), fields, ctx);
    const branch = cond ? ternMatch[2].trim() : ternMatch[3].trim();
    return substituteVariables(branch, fields, ctx);
  }

  output = output.replace(/\$0/g, fields.join(ctx.OFS));
  output = output.replace(/\$NF/g, fields[fields.length - 1] || "");

  // Indirect field references: $var where var is a variable
  output = output.replace(/\$(\w+)/g, (match, name) => {
    const num = parseInt(name, 10);
    if (!isNaN(num)) {
      // Direct: $1, $2, etc.
      return fields[num - 1] || "";
    }
    // Indirect: $var → resolve var to number, then get that field
    const varVal = ctx.variables[name];
    if (varVal !== undefined) {
      const idx = parseInt(varVal, 10);
      if (!isNaN(idx) && idx > 0) return fields[idx - 1] || "";
      if (idx === 0) return fields.join(ctx.OFS);
    }
    return match;
  });

  output = output.replace(/\bNR\b/g, String(ctx.NR));
  output = output.replace(/\bNF\b/g, String(ctx.NF));
  output = output.replace(/\bFS\b/g, ctx.FS);
  output = output.replace(/\bOFS\b/g, ctx.OFS);
  output = output.replace(/\bRS\b/g, ctx.RS);
  output = output.replace(/\bORS\b/g, ctx.ORS);
  output = output.replace(/\bFILENAME\b/g, ctx.FILENAME);

  // Replace array references
  output = output.replace(/(\w+)\[([^\]]+)\]/g, (_, arrName, key) => {
    const resolvedKey = substituteVariables(key, fields, ctx);
    return ctx.arrays[arrName]?.[resolvedKey] ?? "0";
  });

  for (const [key, value] of Object.entries(ctx.variables)) {
    output = output.replace(new RegExp(`\\b${key}\\b`, "g"), value);
  }

  return output;
}

function evaluateExpr(str: string): string {
  // Handle string concatenation
  const strParts = str.match(/^"([^"]*)"(?:\s+"([^"]*)")*$/);
  if (strParts) {
    return '"' + str.replace(/"\s*"/g, '') + '"';
  }

  const arithmeticPattern = /^([\d.]+)\s*([\+\-\*\/%])\s*([\d.]+)$/;
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
      case "%": result = left % right; break;
      default: return str;
    }
    return String(result);
  }
  return str;
}

function formatPrintf(expr: string, fields: string[], ctx: AwkContext): string {
  const parts: string[] = smartSplit(expr, ',');
  if (parts.length === 0) return "";

  let format = parts[0].trim().replace(/^["'](.*)["']$/, "$1");
  const args: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    let arg = substituteVariables(parts[i].trim(), fields, ctx);
    arg = evaluateExpr(arg);
    args.push(arg);
  }

  let output = format;
  let argIdx = 0;

  output = output.replace(/%(-)?(\d+)?(?:\.(\d+))?([sdifgex%])/g, (match, leftAlign, width, precision, type) => {
    if (type === "%") return "%";
    if (argIdx >= args.length) return match;
    const arg = args[argIdx++];

    let formatted: string;
    switch (type) {
      case "s": formatted = arg; break;
      case "d": case "i": formatted = String(parseInt(arg) || 0); break;
      case "f": {
        const num = parseFloat(arg) || 0;
        formatted = precision ? num.toFixed(parseInt(precision)) : String(num);
        break;
      }
      case "g": case "e": case "x": formatted = arg; break;
      default: formatted = arg;
    }

    if (width) {
      const w = parseInt(width);
      formatted = leftAlign ? formatted.padEnd(w, " ") : formatted.padStart(w, " ");
    }
    return formatted;
  });

  output = output.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
  if (output.endsWith("\n")) output = output.slice(0, -1);
  return output;
}

function processStringFunctions(code: string, fields: string[], ctx: AwkContext): string {
  let result = code;

  result = result.replace(/length\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    const str = arg ? substituteVariables(arg, fields, ctx) : fields.join(ctx.OFS);
    return String(str.length);
  });

  result = result.replace(/substr\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, str, start, len) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const startIdx = parseInt(substituteVariables(start.trim(), fields, ctx)) - 1;
    const length = len ? parseInt(substituteVariables(len.trim(), fields, ctx)) : undefined;
    return length ? s.slice(startIdx, startIdx + length) : s.slice(startIdx);
  });

  result = result.replace(/index\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (_, str, substr) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const t = substituteVariables(substr.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const idx = s.indexOf(t);
    return String(idx === -1 ? 0 : idx + 1);
  });

  result = result.replace(/tolower\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    return substituteVariables(arg, fields, ctx).toLowerCase();
  });

  result = result.replace(/toupper\s*\(\s*([^)]*)\s*\)/g, (_, arg) => {
    return substituteVariables(arg, fields, ctx).toUpperCase();
  });

  result = result.replace(/split\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, str, arr, sep) => {
    const s = substituteVariables(str.trim(), fields, ctx);
    const arrName = arr.trim();
    const separator = sep ? substituteVariables(sep.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1") : ctx.FS;
    const parts = s.split(new RegExp(separator));
    // Store split results in array
    if (!ctx.arrays[arrName]) ctx.arrays[arrName] = {};
    parts.forEach((p, i) => { ctx.arrays[arrName][String(i + 1)] = p; });
    return String(parts.length);
  });

  result = result.replace(/gsub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, pattern, repl, target) => {
    const pat = substituteVariables(pattern.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const replacement = substituteVariables(repl.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const tgt = target ? substituteVariables(target.trim(), fields, ctx) : fields[0] || "";
    try { return tgt.replace(new RegExp(pat, "g"), replacement); } catch { return tgt; }
  });

  result = result.replace(/sub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_, pattern, repl, target) => {
    const pat = substituteVariables(pattern.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const replacement = substituteVariables(repl.trim(), fields, ctx).replace(/^["'](.*)["']$/, "$1");
    const tgt = target ? substituteVariables(target.trim(), fields, ctx) : fields[0] || "";
    try { return tgt.replace(new RegExp(pat), replacement); } catch { return tgt; }
  });

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
