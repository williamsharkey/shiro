
import type { Command } from './index';
import { parseArgs } from './flags';
export const sleep: Command = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(ctx) {
    const args = ctx.args;
    const { positional } = parseArgs(args);

    if (positional.length === 0) {
      ctx.stderr += "sleep: missing operand\n";
      return 1;
    }

    const input = positional[0];
    let seconds = 0;

    // Parse duration: supports s (seconds), m (minutes), h (hours), d (days)
    const match = input.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);

    if (!match) {
      ctx.stderr += `sleep: invalid time interval '${input}'\n`;
      return 1;
    }

    const value = parseFloat(match[1]);
    const unit = match[2] || "s";

    switch (unit) {
      case "s":
        seconds = value;
        break;
      case "m":
        seconds = value * 60;
        break;
      case "h":
        seconds = value * 3600;
        break;
      case "d":
        seconds = value * 86400;
        break;
    }

    // A timer; the shell's abort (Ctrl-C, `kill` of the job it runs in) ends it early
    const signal: AbortSignal | undefined = ctx.shell?.abortController?.signal;
    if (signal?.aborted) return 130;
    let aborted = false;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => { aborted = true; done(); };
      const t = (globalThis as any).setTimeout(done, seconds * 1000);
      signal?.addEventListener('abort', onAbort);
    });

    return aborted ? 130 : 0;
  },
};
