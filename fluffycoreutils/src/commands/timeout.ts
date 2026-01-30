import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const timeout: FluffyCommand = {
  name: "timeout",
  description: "Run a command with a time limit",
  async exec(args, io) {
    const { positional, flags, values } = parseArgs(args, ["k", "kill-after", "s", "signal"]);

    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "timeout: missing duration\n",
        exitCode: 1
      };
    }

    const durationStr = positional[0];
    const command = positional.slice(1);

    if (command.length === 0) {
      return {
        stdout: "",
        stderr: "timeout: missing command\n",
        exitCode: 1
      };
    }

    // Parse duration
    let duration = parseDuration(durationStr);
    if (duration === null) {
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${durationStr}'\n`,
        exitCode: 1
      };
    }

    const killAfter = values.k || values["kill-after"];
    const signal = values.s || values.signal || "TERM";
    const preserveStatus = flags["preserve-status"];
    const foreground = flags.foreground;
    const verbose = flags.v || flags.verbose;

    try {
      // In browser environment, we can't actually execute commands with signals
      // This is a simulation showing what would happen
      const commandStr = command.join(" ");

      if (verbose) {
        return {
          stdout: "",
          stderr: `timeout: would run command '${commandStr}' with ${duration}s timeout using signal ${signal}\n`,
          exitCode: 0
        };
      }

      // Simulate timeout
      // In a real implementation, this would:
      // 1. Start the command
      // 2. Wait for timeout duration
      // 3. Send signal if command hasn't finished
      // 4. Optionally send KILL after kill-after duration

      const timeoutMs = duration * 1000;
      let timedOut = false;

      await new Promise((resolve) => {
        const timer = (globalThis as any).setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, timeoutMs);

        // In real implementation, would wait for command to complete
        // For now, just simulate immediate completion
        (globalThis as any).clearTimeout(timer);
        resolve(null);
      });

      if (timedOut) {
        const exitCode = preserveStatus ? 143 : 124; // 124 = timeout, 143 = SIGTERM
        return {
          stdout: "",
          stderr: `timeout: command '${commandStr}' timed out after ${duration}s\n`,
          exitCode
        };
      }

      return {
        stdout: `Command: ${commandStr}\n`,
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `timeout: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

function parseDuration(str: string): number | null {
  const match = str.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2] || "s";

  switch (unit) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 3600;
    case "d": return value * 86400;
    default: return null;
  }
}
