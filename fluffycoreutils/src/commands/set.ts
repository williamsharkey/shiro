import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

/**
 * set - Set or unset shell options and positional parameters
 *
 * This command controls shell behavior and manipulates positional parameters.
 *
 * Common options:
 *   -e: Exit immediately if a command exits with non-zero status
 *   -u: Treat unset variables as an error
 *   -x: Print commands before executing (debug mode)
 *   -v: Print shell input lines as they are read
 *   -n: Read commands but don't execute (syntax check)
 *   -o: Set option by name (e.g., set -o pipefail)
 *   --: End of options, treat remaining args as positional parameters
 *
 * Without options, displays all shell variables.
 */
export const set: FluffyCommand = {
  name: "set",
  description: "Set or unset shell options and positional parameters",
  async exec(args, io) {
    const { flags, values, positional } = parseArgs(args, ["e", "u", "x", "v", "n", "o"]);

    // No arguments: display all variables
    if (args.length === 0) {
      const output = Object.entries(io.env || {})
        .map(([key, val]) => `${key}=${val}`)
        .join("\n");
      return {
        stdout: output ? output + "\n" : "",
        stderr: "",
        exitCode: 0
      };
    }

    // -o option: named options
    if (flags.o || values.o) {
      const optionName = values.o || positional[0];
      const validOptions = [
        "pipefail", "errexit", "nounset", "xtrace", "verbose",
        "noclobber", "noglob", "ignoreeof", "monitor", "posix"
      ];

      if (!optionName) {
        // List all options
        return {
          stdout: validOptions.map(opt => `${opt}\t\toff`).join("\n") + "\n",
          stderr: "",
          exitCode: 0
        };
      }

      if (!validOptions.includes(optionName)) {
        return {
          stdout: "",
          stderr: `set: ${optionName}: invalid option name\n`,
          exitCode: 1
        };
      }

      // In a real shell, this would set the option
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }

    // Shell options set via flags
    const enabledOptions: string[] = [];
    if (flags.e) enabledOptions.push("errexit");
    if (flags.u) enabledOptions.push("nounset");
    if (flags.x) enabledOptions.push("xtrace");
    if (flags.v) enabledOptions.push("verbose");
    if (flags.n) enabledOptions.push("noexec");

    // In a real shell, these options would affect shell behavior
    // For now, just acknowledge them
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
