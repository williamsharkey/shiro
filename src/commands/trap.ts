
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
import type { Command } from './index';
import { parseArgs } from './flags';
export const trap: Command = {
  name: "trap",
  description: "Trap signals and execute commands",
  async exec(ctx) {
    const args = ctx.args;
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

      ctx.stdout += signals.map((sig, i) => `${i}) SIG${sig}`).join("\n") + "\n";
      return 0;
    }

    // -p: print current traps
    if (flags.p) {
      if (positional.length === 0) {
        // In a real shell, this would list all traps
        ctx.stdout += "# Trap handlers would be listed here\n";
        return 0;
      } else {
        // Print specific signal traps
        ctx.stdout += positional.map(sig => `# trap for ${sig} would be shown here`).join("\n") + "\n";
        return 0;
      }
    }

    if (positional.length === 0) {
      ctx.stderr += "trap: usage: trap [-lp] [ACTION] [SIGNAL...]\n";
      return 1;
    }

    // First argument is the action (command string or -)
    const action = positional[0];
    const signals = positional.slice(1);

    if (signals.length === 0) {
      ctx.stderr += "trap: usage: trap ACTION SIGNAL...\n";
      return 1;
    }

    // In a real shell, this would register signal handlers
    // For now, just acknowledge the trap registration
    const actionDesc = action === "-" ? "reset to default" : `set to '${action}'`;

    return 0;
  },
};

export const kill: Command = {
  name: "kill",
  description: "Send signal to process",
  async exec(ctx) {
    const args = ctx.args;
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
        ctx.stdout += signals.map((sig, i) => `${i + 1}) SIG${sig}`).join("\n") + "\n";
        return 0;
      } else {
        ctx.stdout += signals.join(" ") + "\n";
        return 0;
      }
    }

    const signal = values.s || "TERM";

    if (positional.length === 0) {
      ctx.stderr += "kill: usage: kill [-s SIGNAL] PID...\n";
      return 1;
    }

    // In a browser environment, we can't actually send signals to processes
    // This is a stub for compatibility
    ctx.stderr += `kill: sending signal ${signal} to processes: ${positional.join(", ")}\n`;
    return 0;
  },
};
