import type { Command } from './index';
import { parseArgs } from './flags';
import { memoryInfo } from '../utils/sysinfo';

/** free: the same memory /proc/meminfo and sysinfo(2) report (src/utils/sysinfo.ts); no swap */
export const free: Command = {
  name: "free",
  description: "Display amount of free and used memory",
  async exec(ctx) {
    const { flags } = parseArgs(ctx.args);
    const { total, used, free, available } = memoryInfo();
    const mem = [total, used, free, 0, 0, available];
    const swap = [0, 0, 0];

    let fmt: (n: number) => string;
    if (flags.h) {
      fmt = (n) => {
        if (n === 0) return '0B';
        const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
        let i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return (i === 0 ? String(n) : n < 10 ? n.toFixed(1) : String(Math.round(n))) + units[i];
      };
    } else {
      const div = flags.b ? 1 : flags.g ? 1024 ** 3 : flags.m ? 1024 ** 2 : 1024;
      fmt = (n) => String(Math.floor(n / div));
    }
    const row = (label: string, vals: number[]) => label.padEnd(7) + vals.map(v => fmt(v).padStart(12)).join('');
    ctx.stdout += '               total        used        free      shared  buff/cache   available\n'
      + row('Mem:', mem) + '\n' + row('Swap:', swap) + '\n';
    return 0;
  },
};
