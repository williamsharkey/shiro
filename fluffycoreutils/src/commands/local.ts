import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

/**
 * local - Declare local variables (shell built-in)
 *
 * In shell functions, local creates variables with local scope.
 * This implementation provides a stub that shells can recognize.
 *
 * Syntax:
 *   local VAR=value
 *   local VAR
 *   local -r VAR=value  (readonly)
 *   local -a ARRAY      (array)
 *   local -i INT        (integer)
 */
export const local: FluffyCommand = {
  name: "local",
  description: "Declare local variables in shell functions",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args, ["r", "a", "i", "x"]);

    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "local: usage: local [-r] [-a] [-i] [-x] [name[=value] ...]\n",
        exitCode: 1
      };
    }

    // In a real shell, this would create local variables
    // For now, just acknowledge the declarations
    const declarations = positional.map(arg => {
      const [name, value] = arg.split("=", 2);
      return value !== undefined ? `${name}=${value}` : name;
    });

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};

export const declare: FluffyCommand = {
  name: "declare",
  description: "Declare variables and give them attributes",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args, ["r", "a", "A", "i", "x", "p", "f", "g"]);

    // -p: display attributes and values
    if (flags.p) {
      if (positional.length === 0) {
        // In a real shell, this would list all variables
        return {
          stdout: "# Shell variables would be listed here\n",
          stderr: "",
          exitCode: 0
        };
      } else {
        // Display specific variables
        const output = positional.map(name => {
          const value = io.env[name];
          if (value !== undefined) {
            return `declare -- ${name}="${value}"\n`;
          }
          return "";
        }).join("");
        return {
          stdout: output,
          stderr: "",
          exitCode: 0
        };
      }
    }

    // Variable declarations
    for (const arg of positional) {
      const [name, value] = arg.split("=", 2);
      if (value !== undefined && io.env) {
        io.env[name] = value;
      }
    }

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};

export const readonly: FluffyCommand = {
  name: "readonly",
  description: "Mark variables as readonly",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args, ["p", "f"]);

    // -p: display readonly variables
    if (flags.p) {
      // In a real shell, this would list all readonly variables
      return {
        stdout: "# Readonly variables would be listed here\n",
        stderr: "",
        exitCode: 0
      };
    }

    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "readonly: usage: readonly [-p] [name[=value] ...]\n",
        exitCode: 1
      };
    }

    // In a real shell, this would mark variables as readonly
    // For now, just set the values if provided
    for (const arg of positional) {
      const [name, value] = arg.split("=", 2);
      if (value !== undefined && io.env) {
        io.env[name] = value;
      }
    }

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};

export const unset: FluffyCommand = {
  name: "unset",
  description: "Unset variables or functions",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args, ["v", "f"]);

    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "unset: usage: unset [-v] [-f] [name ...]\n",
        exitCode: 1
      };
    }

    // -f: unset functions (not applicable here)
    // -v: unset variables (default)
    if (!flags.f && io.env) {
      for (const name of positional) {
        delete io.env[name];
      }
    }

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
