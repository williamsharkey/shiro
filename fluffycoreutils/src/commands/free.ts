import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const free: FluffyCommand = {
  name: "free",
  description: "Display amount of free and used memory",
  async exec(args, io) {
    const { flags } = parseArgs(args);

    const humanReadable = flags.h;
    const bytes = flags.b;
    const mega = flags.m;
    const giga = flags.g;

    // In browser environment, show mock values for script compatibility
    const output: string[] = [];

    // Mock memory values
    const total = 8388608; // 8GB in KB
    const used = 4194304; // 4GB in KB
    const free = 4194304; // 4GB in KB
    const shared = 524288; // 512MB in KB
    const buffCache = 1048576; // 1GB in KB
    const available = 5242880; // 5GB in KB

    if (humanReadable) {
      output.push("               total        used        free      shared  buff/cache   available");
      output.push("Mem:            8.0G        4.0G        4.0G       512M        1.0G        5.0G");
      output.push("Swap:           2.0G          0B        2.0G");
    } else if (bytes) {
      output.push("               total        used        free      shared  buff/cache   available");
      output.push(`Mem:    ${total * 1024} ${used * 1024} ${free * 1024} ${shared * 1024} ${buffCache * 1024} ${available * 1024}`);
      output.push(`Swap:   ${2097152 * 1024}           0 ${2097152 * 1024}`);
    } else if (mega) {
      output.push("               total        used        free      shared  buff/cache   available");
      output.push(`Mem:           ${Math.floor(total / 1024)}        ${Math.floor(used / 1024)}        ${Math.floor(free / 1024)}         ${Math.floor(shared / 1024)}        ${Math.floor(buffCache / 1024)}        ${Math.floor(available / 1024)}`);
      output.push(`Swap:          ${2048}           0        ${2048}`);
    } else if (giga) {
      output.push("               total        used        free      shared  buff/cache   available");
      output.push(`Mem:               8           4           4           0           1           5`);
      output.push(`Swap:              2           0           2`);
    } else {
      // Default: KB
      output.push("               total        used        free      shared  buff/cache   available");
      output.push(`Mem:        ${total}     ${used}     ${free}      ${shared}     ${buffCache}     ${available}`);
      output.push(`Swap:       ${2097152}           0     ${2097152}`);
    }

    return {
      stdout: output.join("\n") + "\n",
      stderr: "",
      exitCode: 0
    };
  },
};
