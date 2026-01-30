import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const expr: FluffyCommand = {
  name: "expr",
  description: "Evaluate expressions",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    if (positional.length === 0) {
      return { stdout: "", stderr: "expr: missing operand\n", exitCode: 1 };
    }

    try {
      const result = evaluateExpression(positional);
      return {
        stdout: String(result) + "\n",
        stderr: "",
        exitCode: result === 0 || result === "" ? 1 : 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `expr: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 2
      };
    }
  },
};

function evaluateExpression(tokens: string[]): string | number {
  if (tokens.length === 0) {
    throw new Error("syntax error");
  }

  // Handle single token
  if (tokens.length === 1) {
    return tokens[0];
  }

  // Handle binary operators with precedence
  // Precedence (lowest to highest): |, &, =/</>/<=/>=, +/-, */%

  // OR operator (|)
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "|") {
      const left = evaluateExpression(tokens.slice(0, i));
      const right = evaluateExpression(tokens.slice(i + 1));
      return (left && left !== "0" && left !== "") ? left : right;
    }
  }

  // AND operator (&)
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "&") {
      const left = evaluateExpression(tokens.slice(0, i));
      const right = evaluateExpression(tokens.slice(i + 1));
      return (left && left !== "0" && left !== "" && right && right !== "0" && right !== "") ? left : 0;
    }
  }

  // Comparison operators
  for (let i = 0; i < tokens.length; i++) {
    const op = tokens[i];
    if (["=", "!=", "<", ">", "<=", ">="].includes(op)) {
      const left = String(evaluateExpression(tokens.slice(0, i)));
      const right = String(evaluateExpression(tokens.slice(i + 1)));

      const leftNum = parseFloat(left);
      const rightNum = parseFloat(right);
      const isNumeric = !isNaN(leftNum) && !isNaN(rightNum);

      let result = false;
      if (isNumeric) {
        switch (op) {
          case "=": result = leftNum === rightNum; break;
          case "!=": result = leftNum !== rightNum; break;
          case "<": result = leftNum < rightNum; break;
          case ">": result = leftNum > rightNum; break;
          case "<=": result = leftNum <= rightNum; break;
          case ">=": result = leftNum >= rightNum; break;
        }
      } else {
        switch (op) {
          case "=": result = left === right; break;
          case "!=": result = left !== right; break;
          case "<": result = left < right; break;
          case ">": result = left > right; break;
          case "<=": result = left <= right; break;
          case ">=": result = left >= right; break;
        }
      }
      return result ? 1 : 0;
    }
  }

  // Addition and subtraction
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] === "+" || tokens[i] === "-") {
      const left = Number(evaluateExpression(tokens.slice(0, i)));
      const right = Number(evaluateExpression(tokens.slice(i + 1)));
      return tokens[i] === "+" ? left + right : left - right;
    }
  }

  // Multiplication, division, modulo
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (["*", "/", "%"].includes(tokens[i])) {
      const left = Number(evaluateExpression(tokens.slice(0, i)));
      const right = Number(evaluateExpression(tokens.slice(i + 1)));
      if (tokens[i] === "*") return left * right;
      if (tokens[i] === "/") {
        if (right === 0) throw new Error("division by zero");
        return Math.floor(left / right);
      }
      if (tokens[i] === "%") {
        if (right === 0) throw new Error("division by zero");
        return left % right;
      }
    }
  }

  // String operations
  if (tokens.length === 3) {
    if (tokens[1] === ":") {
      // Pattern matching: STRING : REGEX
      const str = tokens[0];
      const pattern = tokens[2];
      try {
        const regex = new RegExp("^" + pattern);
        const match = str.match(regex);
        return match ? match[0].length : 0;
      } catch {
        throw new Error("invalid regular expression");
      }
    }

    // String functions
    if (tokens[0] === "length") {
      return String(tokens[1]).length;
    }

    if (tokens[0] === "index") {
      const str = tokens[1];
      const chars = tokens[2];
      for (let i = 0; i < str.length; i++) {
        if (chars.includes(str[i])) {
          return i + 1; // 1-indexed
        }
      }
      return 0;
    }
  }

  if (tokens.length === 4 && tokens[0] === "substr") {
    const str = tokens[1];
    const pos = Number(tokens[2]) - 1; // 1-indexed to 0-indexed
    const len = Number(tokens[3]);
    return str.substring(pos, pos + len);
  }

  // If no operator found, try to parse as number or return as string
  if (tokens.length === 1) {
    const num = parseFloat(tokens[0]);
    return isNaN(num) ? tokens[0] : num;
  }

  throw new Error("syntax error");
}
