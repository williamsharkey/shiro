import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

/**
 * trap - Trap signals and execute commands
 *
 * In real shells, trap sets up signal handlers. This implementation provides
 * a stub that shells can recognize for signal handling.
 *
 * Syntax:
 *   trap 'COMMANDS' SIGNAL...
 *   trap - SIGNAL...          (reset to default)
 *   trap -l                   (list signals)
 *   trap -p [SIGNAL...]       (print current traps)
 *
 * Common signals:
 *   EXIT, INT, TERM, HUP, QUIT, USR1, USR2, ERR, DEBUG, RETURN
 */
export const trap: FluffyCommand = {
  name: "trap",
  description: "Trap signals and execute commands",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args, ["l", "p"]);

    // -l: list signals
    if (flags.l) {
      const signals = [
        "EXIT", "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS",
        "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM",
        "STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG",
        "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS",
        "ERR", "DEBUG", "RETURN"
      ];

      return {
        stdout: signals.map((sig, i) => `${i}) SIG${sig}`).join("\n") + "\n",
        stderr: "",
        exitCode: 0
      };
    }

    // -p: print current traps
    if (flags.p) {
      if (positional.length === 0) {
        // In a real shell, this would list all traps
        return {
          stdout: "# Trap handlers would be listed here\n",
          stderr: "",
          exitCode: 0
        };
      } else {
        // Print specific signal traps
        return {
          stdout: positional.map(sig => `# trap for ${sig} would be shown here`).join("\n") + "\n",
          stderr: "",
          exitCode: 0
        };
      }
    }

    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "trap: usage: trap [-lp] [ACTION] [SIGNAL...]\n",
        exitCode: 1
      };
    }

    // First argument is the action (command string or -)
    const action = positional[0];
    const signals = positional.slice(1);

    if (signals.length === 0) {
      return {
        stdout: "",
        stderr: "trap: usage: trap ACTION SIGNAL...\n",
        exitCode: 1
      };
    }

    // In a real shell, this would register signal handlers
    // For now, just acknowledge the trap registration
    const actionDesc = action === "-" ? "reset to default" : `set to '${action}'`;

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};

export const kill: FluffyCommand = {
  name: "kill",
  description: "Send signal to process",
  async exec(args, io) {
    const { flags, values, positional } = parseArgs(args, ["l", "L", "s"]);

    // -l: list signals
    if (flags.l || flags.L) {
      const signals = [
        "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE",
        "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM", "STKFLT",
        "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU",
        "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS"
      ];

      if (flags.L) {
        return {
          stdout: signals.map((sig, i) => `${i + 1}) SIG${sig}`).join("\n") + "\n",
          stderr: "",
          exitCode: 0
        };
      } else {
        return {
          stdout: signals.join(" ") + "\n",
          stderr: "",
          exitCode: 0
        };
      }
    }

    const signal = values.s || "TERM";

    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "kill: usage: kill [-s SIGNAL] PID...\n",
        exitCode: 1
      };
    }

    // In a browser environment, we can't actually send signals to processes
    // This is a stub for compatibility
    return {
      stdout: "",
      stderr: `kill: sending signal ${signal} to processes: ${positional.join(", ")}\n`,
      exitCode: 0
    };
  },
};
