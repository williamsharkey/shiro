import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const uptime: FluffyCommand = {
  name: "uptime",
  description: "Tell how long the system has been running",
  async exec(args, io) {
    const { flags } = parseArgs(args);

    const pretty = flags.p || flags.pretty;
    const since = flags.s || flags.since;

    // In browser environment, show mock uptime
    // Use a reasonable uptime value
    const uptimeSeconds = 86400 + 3600 * 5 + 60 * 23; // 1 day, 5 hours, 23 minutes

    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    const now = new Date();
    const startTime = new Date(now.getTime() - uptimeSeconds * 1000);

    const output: string[] = [];

    if (since) {
      output.push(startTime.toISOString());
    } else if (pretty) {
      const parts: string[] = [];
      if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
      if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
      if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
      output.push(`up ${parts.join(", ")}`);
    } else {
      // Default format
      const timeStr = now.toTimeString().split(" ")[0];
      const upStr = days > 0
        ? `${days} day${days !== 1 ? "s" : ""}, ${hours}:${String(minutes).padStart(2, "0")}`
        : `${hours}:${String(minutes).padStart(2, "0")}`;

      output.push(` ${timeStr} up ${upStr}, 1 user, load average: 0.50, 0.40, 0.35`);
    }

    return {
      stdout: output.join("\n") + "\n",
      stderr: "",
      exitCode: 0
    };
  },
};
