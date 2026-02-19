
import type { Command } from './index';
import { parseArgs } from './flags';
export const df: Command = {
  name: "df",
  description: "Report file system disk space usage",
  async exec(ctx) {
    const args = ctx.args;
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

    ctx.stdout += output.join("\n") + "\n";
    return 0;
  },
};
