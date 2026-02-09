import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const seq: FluffyCommand = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(args, io) {
    const { flags, values, positional } = parseArgs(args, ["separator", "s", "format", "f"]);

    if (positional.length === 0) {
      return { stdout: "", stderr: "seq: missing operand\n", exitCode: 1 };
    }

    let start = 1;
    let increment = 1;
    let end: number;

    // Parse arguments: seq [FIRST [INCREMENT]] LAST
    if (positional.length === 1) {
      end = parseFloat(positional[0]);
    } else if (positional.length === 2) {
      start = parseFloat(positional[0]);
      end = parseFloat(positional[1]);
    } else if (positional.length >= 3) {
      start = parseFloat(positional[0]);
      increment = parseFloat(positional[1]);
      end = parseFloat(positional[2]);
    } else {
      end = 1;
    }

    // Validate numbers
    if (isNaN(start) || isNaN(increment) || isNaN(end)) {
      return {
        stdout: "",
        stderr: "seq: invalid number\n",
        exitCode: 1
      };
    }

    if (increment === 0) {
      return {
        stdout: "",
        stderr: "seq: increment must not be 0\n",
        exitCode: 1
      };
    }

    const separator = values.s || values.separator || "\n";
    const format = values.f || values.format;
    const equalWidth = flags.w;

    const numbers: string[] = [];

    // Generate sequence
    if (increment > 0) {
      for (let i = start; i <= end; i += increment) {
        numbers.push(String(i));
      }
    } else {
      for (let i = start; i >= end; i += increment) {
        numbers.push(String(i));
      }
    }

    // Apply equal width padding if requested
    if (equalWidth) {
      const maxLen = Math.max(...numbers.map(n => n.length));
      for (let i = 0; i < numbers.length; i++) {
        numbers[i] = numbers[i].padStart(maxLen, "0");
      }
    }

    // Apply format if specified (simple %g support)
    if (format && typeof format === "string") {
      for (let i = 0; i < numbers.length; i++) {
        const num = parseFloat(numbers[i]);
        // Simple format support: just %g, %f, %e
        if (format.includes("%g") || format.includes("%d") || format.includes("%i")) {
          numbers[i] = format.replace(/%[gdi]/, String(num));
        } else if (format.includes("%f")) {
          numbers[i] = format.replace(/%f/, num.toFixed(6));
        } else if (format.includes("%e")) {
          numbers[i] = format.replace(/%e/, num.toExponential());
        }
      }
    }

    const output = numbers.join(separator);
    const finalSeparator = typeof separator === "string" ? separator : "\n";
    return {
      stdout: output + (finalSeparator === "\n" ? "\n" : ""),
      stderr: "",
      exitCode: 0
    };
  },
};
