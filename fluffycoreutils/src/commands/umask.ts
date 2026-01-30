import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const umask: FluffyCommand = {
  name: "umask",
  description: "Set or display file creation mask",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args, ["S", "p"]);

    const symbolic = flags.S;
    const portable = flags.p;

    // Default umask value (022 is common default)
    // In a real implementation, this would be stored in shell state
    const currentUmask = "0022";

    // If no arguments, display current umask
    if (positional.length === 0) {
      if (symbolic) {
        // Display in symbolic form
        const mask = parseInt(currentUmask, 8);
        const symbolic = maskToSymbolic(mask);
        return {
          stdout: symbolic + "\n",
          stderr: "",
          exitCode: 0,
        };
      } else if (portable) {
        // Display in portable form
        return {
          stdout: `umask ${currentUmask}\n`,
          stderr: "",
          exitCode: 0,
        };
      } else {
        // Display in octal form
        return {
          stdout: currentUmask + "\n",
          stderr: "",
          exitCode: 0,
        };
      }
    }

    // Setting umask
    const newMask = positional[0];

    // Validate the mask
    if (/^[0-7]{3,4}$/.test(newMask)) {
      // Valid octal mask
      // In a real implementation, this would update the shell's umask
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    } else if (/^[ugoa]*[+-=][rwxXst]*$/.test(newMask)) {
      // Valid symbolic mask (e.g., u=rwx,g=rx,o=rx)
      // In a real implementation, this would parse and set the mask
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    } else {
      return {
        stdout: "",
        stderr: `umask: ${newMask}: invalid symbolic mode\n`,
        exitCode: 1,
      };
    }
  },
};

function maskToSymbolic(mask: number): string {
  // Convert octal mask to symbolic notation
  // Full permissions are 0777 (rwxrwxrwx)
  // umask removes permissions, so we invert it
  const permissions = 0o777 & ~mask;

  const user = (permissions >> 6) & 0o7;
  const group = (permissions >> 3) & 0o7;
  const other = permissions & 0o7;

  const permsToStr = (p: number): string => {
    return (p & 0o4 ? "r" : "-") + (p & 0o2 ? "w" : "-") + (p & 0o1 ? "x" : "-");
  };

  return `u=${permsToStr(user)},g=${permsToStr(group)},o=${permsToStr(other)}`;
}
