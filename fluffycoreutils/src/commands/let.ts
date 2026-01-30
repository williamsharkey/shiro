import type { FluffyCommand } from "../types.js";

/**
 * let - Evaluate arithmetic expressions
 *
 * The let command evaluates arithmetic expressions and returns 0 if the
 * result is non-zero, 1 if the result is zero.
 *
 * Syntax:
 *   let arg [arg ...]
 *   let "expression"
 *   let var=expression
 *
 * Operators (in order of precedence):
 *   - Unary: -, +, !, ~
 *   - Arithmetic: *, /, %
 *   - Addition: +, -
 *   - Shift: <<, >>
 *   - Comparison: <, >, <=, >=
 *   - Equality: ==, !=
 *   - Bitwise: &, ^, |
 *   - Logical: &&, ||
 *   - Assignment: =, +=, -=, *=, /=, %=
 *
 * Examples:
 *   let "x = 5 + 3"
 *   let "y = x * 2"
 *   let "z = x > 5"
 */
export const letCmd: FluffyCommand = {
  name: "let",
  description: "Evaluate arithmetic expressions",
  async exec(args, io) {
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "let: usage: let arg [arg ...]\n",
        exitCode: 1
      };
    }

    try {
      // Combine all arguments
      const expression = args.join(" ");

      // Check for assignment
      const assignMatch = expression.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
      if (assignMatch) {
        const varName = assignMatch[1];
        const expr = assignMatch[2];

        const result = evaluateArithmetic(expr, io.env || {});

        // Set the variable
        if (io.env) {
          io.env[varName] = String(result);
        }

        // Return 0 if result is non-zero, 1 if zero
        return {
          stdout: "",
          stderr: "",
          exitCode: result === 0 ? 1 : 0
        };
      }

      // No assignment, just evaluate
      const result = evaluateArithmetic(expression, io.env || {});

      return {
        stdout: "",
        stderr: "",
        exitCode: result === 0 ? 1 : 0
      };
    } catch (err: any) {
      return {
        stdout: "",
        stderr: `let: ${err.message}\n`,
        exitCode: 1
      };
    }
  },
};

function evaluateArithmetic(expr: string, env: Record<string, string>): number {
  // Replace variables with their values
  let processed = expr.trim();

  // Replace $var and ${var} with values
  processed = processed.replace(/\$\{?([a-zA-Z_][a-zA-Z0-9_]*)\}?/g, (_, varName) => {
    return env[varName] || "0";
  });

  // Simple arithmetic evaluation (basic implementation)
  // In a real shell, this would use a proper expression parser

  try {
    // Remove spaces
    processed = processed.replace(/\s+/g, "");

    // Handle basic operators
    // This is a simplified evaluator - a real implementation would use
    // a proper lexer/parser with operator precedence

    // Try to evaluate simple expressions
    if (/^[\d+\-*/%()]+$/.test(processed)) {
      // Safe to evaluate with Function (only contains numbers and basic operators)
      const result = new Function(`return (${processed})`)();
      return Math.floor(result);
    }

    // Handle comparison operators
    if (processed.includes("==") || processed.includes("!=") ||
        processed.includes("<=") || processed.includes(">=") ||
        processed.includes("<") || processed.includes(">")) {
      const result = new Function(`return (${processed}) ? 1 : 0`)();
      return result;
    }

    // Handle logical operators
    if (processed.includes("&&") || processed.includes("||")) {
      const result = new Function(`return (${processed}) ? 1 : 0`)();
      return result;
    }

    // Try to parse as a number
    const num = parseFloat(processed);
    if (!isNaN(num)) {
      return Math.floor(num);
    }

    throw new Error(`invalid arithmetic expression: ${expr}`);
  } catch (err: any) {
    throw new Error(`invalid arithmetic expression: ${expr}`);
  }
}

/**
 * Arithmetic expansion helper - used by shells for $(( )) syntax
 */
export const arithmeticExpansion = {
  evaluate: evaluateArithmetic
};
