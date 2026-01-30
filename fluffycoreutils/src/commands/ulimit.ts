import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const ulimit: FluffyCommand = {
  name: "ulimit",
  description: "Control user resource limits",
  async exec(args, io) {
    const { flags, positional, values } = parseArgs(args, [
      "S", "soft",
      "H", "hard",
      "a", "all",
      "c", "core-size",
      "d", "data-size",
      "f", "file-size",
      "l", "lock-memory",
      "m", "memory-size",
      "n", "open-files",
      "s", "stack-size",
      "t", "cpu-time",
      "u", "user-processes",
      "v", "virtual-memory",
    ]);

    const soft = flags.S || flags.soft;
    const hard = flags.H || flags.hard;
    const all = flags.a || flags.all;

    // In browser environment, we provide mock values
    const limits = {
      "core file size": { value: "unlimited", unit: "blocks" },
      "data seg size": { value: "unlimited", unit: "kbytes" },
      "file size": { value: "unlimited", unit: "blocks" },
      "max locked memory": { value: "unlimited", unit: "kbytes" },
      "max memory size": { value: "unlimited", unit: "kbytes" },
      "open files": { value: "1024", unit: "" },
      "stack size": { value: "8192", unit: "kbytes" },
      "cpu time": { value: "unlimited", unit: "seconds" },
      "max user processes": { value: "2048", unit: "" },
      "virtual memory": { value: "unlimited", unit: "kbytes" },
    };

    // -a: display all limits
    if (all) {
      const limitType = hard ? "hard" : soft ? "soft" : "soft";
      const output = Object.entries(limits)
        .map(([name, { value, unit }]) => {
          const unitStr = unit ? ` (${unit})` : "";
          return `${name}${unitStr.padEnd(25 - name.length)} ${value}`;
        })
        .join("\n") + "\n";
      return {
        stdout: output,
        stderr: "",
        exitCode: 0,
      };
    }

    // Individual resource flags
    let resource: string | null = null;
    if (flags.c || flags["core-size"]) resource = "core file size";
    else if (flags.d || flags["data-size"]) resource = "data seg size";
    else if (flags.f || flags["file-size"]) resource = "file size";
    else if (flags.l || flags["lock-memory"]) resource = "max locked memory";
    else if (flags.m || flags["memory-size"]) resource = "max memory size";
    else if (flags.n || flags["open-files"]) resource = "open files";
    else if (flags.s || flags["stack-size"]) resource = "stack size";
    else if (flags.t || flags["cpu-time"]) resource = "cpu time";
    else if (flags.u || flags["user-processes"]) resource = "max user processes";
    else if (flags.v || flags["virtual-memory"]) resource = "virtual memory";

    // If no specific resource specified, default to file size (-f)
    if (!resource) {
      resource = "file size";
    }

    // Get limit value
    const limit = limits[resource as keyof typeof limits];
    if (!limit) {
      return {
        stdout: "",
        stderr: `ulimit: invalid resource\n`,
        exitCode: 1,
      };
    }

    // If setting a limit (has positional argument)
    if (positional.length > 0) {
      const newValue = positional[0];
      // In a real implementation, this would set the limit
      // For browser environment, we just simulate success
      if (newValue !== "unlimited" && isNaN(parseInt(newValue))) {
        return {
          stdout: "",
          stderr: `ulimit: ${newValue}: invalid number\n`,
          exitCode: 1,
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    }

    // Display the limit
    return {
      stdout: limit.value + "\n",
      stderr: "",
      exitCode: 0,
    };
  },
};
