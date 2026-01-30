import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

/**
 * read - Read a line from stdin
 *
 * Reads a line from stdin and assigns it to variables.
 * In a real shell, this would be interactive and set shell variables.
 * This implementation reads from stdin and can set environment variables.
 *
 * Syntax:
 *   read [-r] [-p prompt] [-n nchars] [-t timeout] [-d delim] [var...]
 *
 * Options:
 *   -r: Do not allow backslashes to escape characters
 *   -p: Display prompt before reading
 *   -n: Read only N characters
 *   -t: Timeout after N seconds
 *   -d: Use DELIM as line delimiter instead of newline
 *   -a: Read into array (bash extension)
 *   -s: Silent mode (don't echo input)
 */
export const read: FluffyCommand = {
  name: "read",
  description: "Read a line from stdin into variables",
  async exec(args, io) {
    const { positional, flags, values } = parseArgs(args, ["r", "p", "n", "t", "d", "a", "s"]);

    // Get stdin content
    let input = io.stdin || "";

    // -p prompt: would display prompt in interactive shell
    const prompt = values.p;
    if (prompt) {
      // In a real shell, this would output the prompt to stderr
      // For now, we acknowledge it exists
    }

    // -d delimiter: use custom delimiter instead of newline
    const delimiter = values.d || "\n";

    // -n nchars: read only N characters
    const nchars = values.n ? parseInt(values.n) : undefined;

    // Read the input
    let line: string;
    if (nchars !== undefined) {
      line = input.slice(0, nchars);
    } else {
      const delimIndex = input.indexOf(delimiter);
      if (delimIndex >= 0) {
        line = input.slice(0, delimIndex);
      } else {
        line = input;
      }
    }

    // -r: raw mode (don't interpret backslashes)
    if (!flags.r) {
      // Process escape sequences
      line = line.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
    }

    // Assign to variables
    if (positional.length === 0) {
      // No variables specified: set REPLY
      if (io.env) {
        io.env.REPLY = line;
      }
    } else if (positional.length === 1) {
      // Single variable: assign entire line
      if (io.env) {
        io.env[positional[0]] = line;
      }
    } else {
      // Multiple variables: split by IFS (default: whitespace)
      const ifs = io.env?.IFS || " \t\n";
      const ifsRegex = new RegExp(`[${ifs.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}]+`);
      const words = line.split(ifsRegex).filter(w => w);

      for (let i = 0; i < positional.length; i++) {
        const varName = positional[i];
        if (i < positional.length - 1) {
          // Assign one word to each variable
          if (io.env) {
            io.env[varName] = words[i] || "";
          }
        } else {
          // Last variable gets remaining words
          if (io.env) {
            io.env[varName] = words.slice(i).join(" ");
          }
        }
      }
    }

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
