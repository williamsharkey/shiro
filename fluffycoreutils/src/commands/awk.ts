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

    // Field separator (default is whitespace)
    const fieldSep = values.F || /\s+/;
    const fieldSepRegex = typeof fieldSep === "string" ? new RegExp(fieldSep) : fieldSep;

    // Variables (-v var=value)
    const variables: Record<string, string> = {};
    if (values.v) {
      const parts = values.v.split("=");
      if (parts.length === 2) {
        variables[parts[0]] = parts[1];
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

      const lines = content.split("\n").filter(line => line !== "" || content.endsWith("\n"));
      const output: string[] = [];

      // Parse the AWK program (simplified - supports basic patterns and actions)
      // Format: /pattern/ { action } or BEGIN { action } or { action }
      const beginMatch = program.match(/BEGIN\s*\{\s*([^}]*)\s*\}/);
      const endMatch = program.match(/END\s*\{\s*([^}]*)\s*\}/);
      const mainMatch = program.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);

      // Special AWK variables
      let NR = 0; // Number of records (lines)
      let NF = 0; // Number of fields

      // Execute BEGIN block
      if (beginMatch) {
        const result = executeAction(beginMatch[1], [], 0, 0, variables);
        if (result) output.push(result);
      }

      // Process each line
      for (const line of lines) {
        NR++;
        const fields = line.split(fieldSepRegex).filter(f => f !== "");
        NF = fields.length;

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
            const result = executeAction(action, fields, NR, NF, variables);
            if (result !== null) output.push(result);
          }
        } else if (!beginMatch && !endMatch) {
          // No braces - treat as action for all lines
          const result = executeAction(program, fields, NR, NF, variables);
          if (result !== null) output.push(result);
        }
      }

      // Execute END block
      if (endMatch) {
        const result = executeAction(endMatch[1], [], NR, 0, variables);
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

function executeAction(
  action: string,
  fields: string[],
  NR: number,
  NF: number,
  variables: Record<string, string>
): string | null {
  // Replace AWK special variables
  let code = action.trim();

  // Handle print statement
  if (code.startsWith("print")) {
    const printExpr = code.substring(5).trim();

    if (!printExpr || printExpr === "") {
      // print with no args prints the whole line
      return fields.join(" ");
    }

    // Replace field references $1, $2, etc.
    let output = printExpr;

    // Replace $0 with whole line
    output = output.replace(/\$0/g, fields.join(" "));

    // Replace $NF with last field
    output = output.replace(/\$NF/g, fields[fields.length - 1] || "");

    // Replace numbered fields
    for (let i = 1; i <= fields.length; i++) {
      output = output.replace(new RegExp(`\\$${i}`, "g"), fields[i - 1] || "");
    }

    // Replace NR
    output = output.replace(/\bNR\b/g, String(NR));

    // Replace NF
    output = output.replace(/\bNF\b/g, String(NF));

    // Replace variables
    for (const [key, value] of Object.entries(variables)) {
      output = output.replace(new RegExp(`\\b${key}\\b`, "g"), value);
    }

    // Remove quotes if present
    output = output.replace(/^["'](.*)["']$/, "$1");

    // Handle string concatenation (space-separated items)
    output = output.replace(/\s+/g, " ").trim();

    return output;
  }

  // If no print statement, return null (no output)
  return null;
}
