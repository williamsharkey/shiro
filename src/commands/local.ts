
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
import type { Command } from './index';
import { parseArgs } from './flags';
export const local: Command = {
  name: "local",
  description: "Declare local variables in shell functions",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args, ["r", "a", "i", "x"]);

    if (positional.length === 0) {
      ctx.stderr += "local: usage: local [-r] [-a] [-i] [-x] [name[=value] ...]\n";
      return 1;
    }

    // In a real shell, this would create local variables
    // For now, just acknowledge the declarations
    const declarations = positional.map(arg => {
      const [name, value] = arg.split("=", 2);
      return value !== undefined ? `${name}=${value}` : name;
    });

    return 0;
  },
};

export const declare: Command = {
  name: "declare",
  description: "Declare variables and give them attributes",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args, []);

    // -p: display attributes and values
    if (flags.p) {
      if (positional.length === 0) {
        // In a real shell, this would list all variables
        ctx.stdout += "# Shell variables would be listed here\n";
        return 0;
      } else {
        // Display specific variables
        const output = positional.map(name => {
          const value = ctx.env[name];
          if (value !== undefined) {
            return `declare -- ${name}="${value}"\n`;
          }
          return "";
        }).join("");
        ctx.stdout += output;
        return 0;
      }
    }

    // -A: declare associative array
    if (flags.A && ctx.shell) {
      for (const arg of positional) {
        const name = arg.split("=", 1)[0];
        if (!ctx.shell.assocArrays.has(name)) {
          ctx.shell.assocArrays.set(name, new Map());
        }
      }
      return 0;
    }

    // -a: declare indexed array
    if (flags.a && ctx.shell) {
      for (const arg of positional) {
        const name = arg.split("=", 1)[0];
        if (!ctx.shell.arrays.has(name)) {
          ctx.shell.arrays.set(name, []);
        }
      }
      return 0;
    }

    // Variable declarations
    for (const arg of positional) {
      const [name, value] = arg.split("=", 2);
      if (value !== undefined && ctx.env) {
        ctx.env[name] = value;
      }
    }

    return 0;
  },
};

export const readonly: Command = {
  name: "readonly",
  description: "Mark variables as readonly",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args, ["p", "f"]);

    // -p: display readonly variables
    if (flags.p) {
      // In a real shell, this would list all readonly variables
      ctx.stdout += "# Readonly variables would be listed here\n";
      return 0;
    }

    if (positional.length === 0) {
      ctx.stderr += "readonly: usage: readonly [-p] [name[=value] ...]\n";
      return 1;
    }

    // In a real shell, this would mark variables as readonly
    // For now, just set the values if provided
    for (const arg of positional) {
      const [name, value] = arg.split("=", 2);
      if (value !== undefined && ctx.env) {
        ctx.env[name] = value;
      }
    }

    return 0;
  },
};

export const unset: Command = {
  name: "unset",
  description: "Unset variables or functions",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args, ["v", "f"]);

    if (positional.length === 0) {
      ctx.stderr += "unset: usage: unset [-v] [-f] [name ...]\n";
      return 1;
    }

    // -f: unset functions (not applicable here)
    // -v: unset variables (default)
    if (!flags.f) {
      for (const name of positional) {
        // unset arr[key] — remove single array/assoc element
        const bracketMatch = name.match(/^(\w+)\[(.+)\]$/);
        if (bracketMatch && ctx.shell) {
          const arrName = bracketMatch[1];
          const key = bracketMatch[2];
          // Associative array?
          const assoc = ctx.shell.assocArrays?.get(arrName);
          if (assoc) { assoc.delete(key); continue; }
          // Indexed array
          const arr = ctx.shell.arrays?.get(arrName);
          if (arr) {
            const idx = parseInt(key, 10);
            if (!isNaN(idx) && idx < arr.length) arr[idx] = '';
          }
          continue;
        }
        // unset entire array or variable
        if (ctx.shell?.assocArrays?.has(name)) {
          ctx.shell.assocArrays.delete(name);
        }
        if (ctx.shell?.arrays?.has(name)) {
          ctx.shell.arrays.delete(name);
        }
        if (ctx.env) {
          delete ctx.env[name];
        }
      }
    }

    return 0;
  },
};
