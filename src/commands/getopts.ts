
/**
 * getopts - Parse option arguments
 *
 * This is a shell built-in used to parse positional parameters and
 * extract options and their arguments.
 *
 * Syntax:
 *   getopts OPTSTRING NAME [args...]
 *
 * OPTSTRING format:
 *   - Letters are option characters
 *   - A colon after a letter means that option requires an argument
 *   - If OPTSTRING starts with :, silent error reporting mode
 *
 * Example:
 *   getopts "ab:c" opt
 *   # -a and -c are boolean flags
 *   # -b requires an argument
 *
 * In a real shell, getopts:
 *   - Sets NAME to the next option character
 *   - Sets OPTARG to option argument (if any)
 *   - Sets OPTIND to index of next argument
 *   - Returns 0 if option found, 1 if no more options
 *
 * This implementation provides a stub that recognizes the syntax.
 */
import type { Command } from './index';
export const getopts: Command = {
  name: "getopts",
  description: "Parse option arguments (shell built-in)",
  async exec(ctx) {
    const args = ctx.args;
    if (args.length < 2) {
      ctx.stderr += "getopts: usage: getopts OPTSTRING NAME [args...]\n";
      return 1;
    }

    const optstring = args[0];
    const varname = args[1];
    const cmdArgs = args.slice(2);

    // In a real shell, getopts maintains state via OPTIND
    // and parses options one at a time in a while loop

    // Get current OPTIND (1-based index)
    let optind = parseInt(ctx.env?.OPTIND || "1");

    // Silent error reporting mode
    const silent = optstring.startsWith(":");
    const actualOptstring = silent ? optstring.slice(1) : optstring;

    // Parse the optstring to understand which options are valid
    const validOpts = new Map<string, boolean>(); // option -> requiresArg
    for (let i = 0; i < actualOptstring.length; i++) {
      const char = actualOptstring[i];
      if (char === ":") continue;
      const requiresArg = actualOptstring[i + 1] === ":";
      validOpts.set(char, requiresArg);
    }

    // Get arguments to parse (use cmdArgs if provided, else use positional params from env)
    const argsToProcess = cmdArgs.length > 0 ? cmdArgs :
                          (ctx.env?.$1 ? [ctx.env.$1, ctx.env.$2, ctx.env.$3].filter(Boolean) : []);

    if (argsToProcess.length === 0 || optind > argsToProcess.length) {
      // No more options to process
      if (ctx.env) {
        ctx.env.OPTIND = "1";
      }
      return 1;
    }

    const currentArg = argsToProcess[optind - 1];

    // Check if this looks like an option
    if (!currentArg || !currentArg.startsWith("-") || currentArg === "-" || currentArg === "--") {
      // Not an option or end of options
      if (ctx.env) {
        ctx.env.OPTIND = "1";
      }
      return 1;
    }

    // Get option character (skip the -)
    const optchar = currentArg[1];

    // Check if option is valid
    if (!validOpts.has(optchar)) {
      // Invalid option
      if (ctx.env) {
        ctx.env[varname] = "?";
        ctx.env.OPTARG = optchar;
        ctx.env.OPTIND = String(optind + 1);
      }
      if (!silent) {
        ctx.stderr += `getopts: illegal option -- ${optchar}\n`;
        return 0;
      }
      return 0;
    }

    const requiresArg = validOpts.get(optchar);

    if (requiresArg) {
      // Option requires an argument
      let optarg: string;

      if (currentArg.length > 2) {
        // Argument is attached: -bARG
        optarg = currentArg.slice(2);
      } else if (optind < argsToProcess.length) {
        // Argument is next parameter
        optarg = argsToProcess[optind];
        if (ctx.env) {
          ctx.env.OPTIND = String(optind + 2);
        }
      } else {
        // Missing required argument
        if (ctx.env) {
          ctx.env[varname] = "?";
          ctx.env.OPTARG = optchar;
          ctx.env.OPTIND = String(optind + 1);
        }
        if (!silent) {
          ctx.stderr += `getopts: option requires an argument -- ${optchar}\n`;
          return 0;
        }
        return 0;
      }

      if (ctx.env) {
        ctx.env[varname] = optchar;
        ctx.env.OPTARG = optarg;
        if (!ctx.env.OPTIND) {
          ctx.env.OPTIND = String(optind + 1);
        }
      }
    } else {
      // Option doesn't require an argument
      if (ctx.env) {
        ctx.env[varname] = optchar;
        ctx.env.OPTIND = String(optind + 1);
        delete ctx.env.OPTARG;
      }
    }

    return 0;
  },
};
