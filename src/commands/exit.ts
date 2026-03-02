
import type { Command } from './index';
import { parseArgs } from './flags';
export const exit: Command = {
  name: "exit",
  description: "Exit the shell with a status code",
  async exec(ctx) {
    const args = ctx.args;
    const { positional } = parseArgs(args);

    const code = positional.length > 0 ? parseInt(positional[0]) : 0;
    const exitCode = isNaN(code) ? 2 : code;

    // Fire EXIT trap if set
    if (ctx.shell.traps.has('EXIT')) {
      const exitCmd = ctx.shell.traps.get('EXIT')!;
      ctx.shell.traps.delete('EXIT'); // prevent re-entry
      let trapOutput = '';
      await ctx.shell.execute(exitCmd, (s: string) => { trapOutput += s; });
      if (trapOutput) ctx.stdout += trapOutput;
    }

    return exitCode;
  },
};
