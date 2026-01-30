import type { FluffyCommand } from "../types.js";

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
export const getopts: FluffyCommand = {
  name: "getopts",
  description: "Parse option arguments (shell built-in)",
  async exec(args, io) {
    if (args.length < 2) {
      return {
        stdout: "",
        stderr: "getopts: usage: getopts OPTSTRING NAME [args...]\n",
        exitCode: 1
      };
    }

    const optstring = args[0];
    const varname = args[1];
    const cmdArgs = args.slice(2);

    // In a real shell, getopts maintains state via OPTIND
    // and parses options one at a time in a while loop

    // Get current OPTIND (1-based index)
    let optind = parseInt(io.env?.OPTIND || "1");

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
                          (io.env?.$1 ? [io.env.$1, io.env.$2, io.env.$3].filter(Boolean) : []);

    if (argsToProcess.length === 0 || optind > argsToProcess.length) {
      // No more options to process
      if (io.env) {
        io.env.OPTIND = "1";
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    }

    const currentArg = argsToProcess[optind - 1];

    // Check if this looks like an option
    if (!currentArg || !currentArg.startsWith("-") || currentArg === "-" || currentArg === "--") {
      // Not an option or end of options
      if (io.env) {
        io.env.OPTIND = "1";
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    }

    // Get option character (skip the -)
    const optchar = currentArg[1];

    // Check if option is valid
    if (!validOpts.has(optchar)) {
      // Invalid option
      if (io.env) {
        io.env[varname] = "?";
        io.env.OPTARG = optchar;
        io.env.OPTIND = String(optind + 1);
      }
      if (!silent) {
        return {
          stdout: "",
          stderr: `getopts: illegal option -- ${optchar}\n`,
          exitCode: 0
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
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
        if (io.env) {
          io.env.OPTIND = String(optind + 2);
        }
      } else {
        // Missing required argument
        if (io.env) {
          io.env[varname] = "?";
          io.env.OPTARG = optchar;
          io.env.OPTIND = String(optind + 1);
        }
        if (!silent) {
          return {
            stdout: "",
            stderr: `getopts: option requires an argument -- ${optchar}\n`,
            exitCode: 0
          };
        }
        return {
          stdout: "",
          stderr: "",
          exitCode: 0
        };
      }

      if (io.env) {
        io.env[varname] = optchar;
        io.env.OPTARG = optarg;
        if (!io.env.OPTIND) {
          io.env.OPTIND = String(optind + 1);
        }
      }
    } else {
      // Option doesn't require an argument
      if (io.env) {
        io.env[varname] = optchar;
        io.env.OPTIND = String(optind + 1);
        delete io.env.OPTARG;
      }
    }

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
