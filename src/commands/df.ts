import type { Command } from './index';
import { parseArgs } from './flags';
import { storageInfo } from '../utils/sysinfo';

/** df: the origin's storage estimate (the numbers `doctor` prints), as one filesystem on / */
export const df: Command = {
  name: "df",
  description: "Report file system disk space usage",
  async exec(ctx) {
    const { flags } = parseArgs(ctx.args);
    const { size, used, avail } = await storageInfo();
    const pct = size ? `${Math.ceil((used / size) * 100)}%` : '-';

    if (flags.i) {
      ctx.stdout += "Filesystem      Inodes  IUsed   IFree IUse% Mounted on\nrootfs               0      0       0     - /\n";
      return 0;
    }
    if (flags.h) {
      const human = (n: number) => {
        const units = ['', 'K', 'M', 'G', 'T'];
        let i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return i === 0 ? String(n) : (n < 10 ? (Math.ceil(n * 10) / 10).toFixed(1) : String(Math.ceil(n))) + units[i];
      };
      ctx.stdout += 'Filesystem      Size  Used Avail Use% Mounted on\n'
        + `rootfs ${human(size).padStart(14)} ${human(used).padStart(5)} ${human(avail).padStart(5)} ${pct.padStart(4)} /\n`;
      return 0;
    }
    const kb = (n: number) => String(Math.floor(n / 1024));
    ctx.stdout += 'Filesystem     1K-blocks      Used  Available Use% Mounted on\n'
      + `rootfs ${kb(size).padStart(18)} ${kb(used).padStart(9)} ${kb(avail).padStart(10)} ${pct.padStart(4)} /\n`;
    return 0;
  },
};
