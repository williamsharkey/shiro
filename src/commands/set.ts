
/**
 * set - Set or unset shell options and positional parameters
 *
 * Common options:
 *   -e: Exit immediately if a command exits with non-zero status (errexit)
 *   -u: Treat unset variables as an error (nounset)
 *   -x: Print commands before executing (xtrace)
 *   -v: Print shell input lines as they are read (verbose)
 *   -o: Set option by name (e.g., set -o pipefail)
 *   +e/+u/+x/+v: Unset the option
 *   --: End of options, treat remaining args as positional parameters
 *
 * Without options, displays all shell variables.
 */
import type { Command } from './index';
export const set: Command = {
  name: "set",
  description: "Set or unset shell options and positional parameters",
  async exec(ctx) {
    const args = ctx.args;

    // No arguments: display all variables
    if (args.length === 0) {
      const output = Object.entries(ctx.env || {})
        .map(([key, val]) => `${key}=${val}`)
        .join("\n");
      ctx.stdout += output ? output + "\n" : "";
      return 0;
    }

    const optionMap: Record<string, string> = {
      'e': 'errexit',
      'u': 'nounset',
      'x': 'xtrace',
      'v': 'verbose',
      'n': 'noexec',
    };

    const namedOptionMap: Record<string, string> = {
      'errexit': 'errexit',
      'nounset': 'nounset',
      'xtrace': 'xtrace',
      'verbose': 'verbose',
      'noexec': 'noexec',
      'pipefail': 'pipefail',
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--') break;

      // -o optname / +o optname
      if (arg === '-o' || arg === '+o') {
        const optName = args[++i];
        if (!optName) {
          // List all options with on/off
          const allOpts = Object.keys(namedOptionMap);
          for (const opt of allOpts) {
            const isSet = ctx.shell.options.has(namedOptionMap[opt]);
            ctx.stdout += `${opt}\t\t${isSet ? 'on' : 'off'}\n`;
          }
          return 0;
        }
        const mapped = namedOptionMap[optName];
        if (!mapped) {
          ctx.stderr += `set: ${optName}: invalid option name\n`;
          return 1;
        }
        if (arg === '-o') {
          ctx.shell.options.add(mapped);
        } else {
          ctx.shell.options.delete(mapped);
        }
        continue;
      }

      // -exv... / +exv...
      if (arg.startsWith('-') && arg.length > 1 && arg[1] !== '-') {
        const enable = true;
        for (let j = 1; j < arg.length; j++) {
          const ch = arg[j];
          const mapped = optionMap[ch];
          if (mapped) {
            ctx.shell.options.add(mapped);
          }
        }
        continue;
      }

      if (arg.startsWith('+') && arg.length > 1) {
        for (let j = 1; j < arg.length; j++) {
          const ch = arg[j];
          const mapped = optionMap[ch];
          if (mapped) {
            ctx.shell.options.delete(mapped);
          }
        }
        continue;
      }
    }

    return 0;
  },
};
