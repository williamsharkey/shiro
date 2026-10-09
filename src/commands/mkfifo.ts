import type { Command } from './index';

/** mkfifo [-m MODE] NAME...: create named pipes (FileSystem.mkfifo; the kernel attaches opens to a pipe). */
export const mkfifo: Command = {
  name: 'mkfifo',
  description: 'Make FIFOs (named pipes)',
  async exec(ctx) {
    const names: string[] = [];
    let mode = 0o644; // 0666 & ~umask 022
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-m' || a === '--mode') {
        const m = args[++i];
        if (m === undefined || !/^[0-7]{1,4}$/.test(m)) { ctx.stderr += `mkfifo: invalid mode '${m ?? ''}'\n`; return 1; }
        mode = parseInt(m, 8);
      } else if (a.startsWith('--mode=')) {
        const m = a.slice(7);
        if (!/^[0-7]{1,4}$/.test(m)) { ctx.stderr += `mkfifo: invalid mode '${m}'\n`; return 1; }
        mode = parseInt(m, 8);
      } else if (a === '--') {
        names.push(...args.slice(i + 1));
        break;
      } else names.push(a);
    }
    if (!names.length) { ctx.stderr += 'mkfifo: missing operand\n'; return 1; }
    let status = 0;
    for (const n of names) {
      try {
        await ctx.fs.mkfifo(ctx.fs.resolvePath(n, ctx.cwd), mode);
      } catch (e: any) {
        const why = e?.code === 'EEXIST' ? 'File exists' : e?.code === 'ENOENT' ? 'No such file or directory' : e?.code === 'ENOTDIR' ? 'Not a directory' : (e?.message ?? String(e));
        ctx.stderr += `mkfifo: cannot create fifo '${n}': ${why}\n`;
        status = 1;
      }
    }
    return status;
  },
};
