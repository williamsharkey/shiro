import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const df: FluffyCommand = {
  name: "df",
  description: "Report file system disk space usage",
  async exec(args, io) {
    const { flags } = parseArgs(args);

    const humanReadable = flags.h;
    const inodes = flags.i;

    // In browser environment, we show mock values for script compatibility
    const output: string[] = [];

    if (inodes) {
      output.push("Filesystem      Inodes  IUsed   IFree IUse% Mounted on");
      output.push("virtual             0      0       0    0% /");
    } else {
      if (humanReadable) {
        output.push("Filesystem      Size  Used Avail Use% Mounted on");
        output.push("virtual         100G   10G   90G  10% /");
      } else {
        output.push("Filesystem     1K-blocks    Used Available Use% Mounted on");
        output.push("virtual        104857600 10485760  94371840  10% /");
      }
    }

    return {
      stdout: output.join("\n") + "\n",
      stderr: "",
      exitCode: 0
    };
  },
};
