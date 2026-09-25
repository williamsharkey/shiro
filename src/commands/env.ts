
// Patterns that indicate a sensitive env var (case-insensitive match on key)
import type { Command } from './index';
import { quoteArgsForShell } from '../shell';
const SECRET_PATTERNS = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|GITHUB_TOKEN)$/i;

export const env: Command = {
  name: "env",
  description: "Print environment variables",
  async exec(ctx) {
    // env [-i] [NAME=value ...] [command [args ...]]: run command with those settings
    let i = 0;
    while (i < ctx.args.length && /^-[iu0]$|^--$/.test(ctx.args[i])) i += ctx.args[i] === '-u' ? 2 : 1;
    const assignments: string[] = [];
    while (i < ctx.args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ctx.args[i])) assignments.push(ctx.args[i++]);
    if (i < ctx.args.length) {
      const prefix = assignments.map((a) => {
        const eq = a.indexOf('=');
        return a.slice(0, eq + 1) + quoteArgsForShell([a.slice(eq + 1)]);
      });
      const line = [...prefix, quoteArgsForShell(ctx.args.slice(i))].join(' ');
      return ctx.shell.execute(line, (s) => { ctx.stdout += s.replace(/\r\n/g, '\n'); }, (s) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }, false, ctx.terminal, true);
    }
    const shown = { ...ctx.env };
    for (const a of assignments) { const eq = a.indexOf('='); shown[a.slice(0, eq)] = a.slice(eq + 1); }
    const lines = Object.entries(shown)
      .map(([k, v]) => {
        if (SECRET_PATTERNS.test(k) && v && v.length >= 8) {
          return `${k}=${v.slice(0, 4)}${'*'.repeat(Math.min(v.length - 4, 20))}`;
        }
        return `${k}=${v}`;
      })
      .sort();
    ctx.stdout += lines.join("\n") + "\n";
    return 0;
  },
};
