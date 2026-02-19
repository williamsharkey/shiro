
// Patterns that indicate a sensitive env var (case-insensitive match on key)
import type { Command } from './index';
const SECRET_PATTERNS = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|GITHUB_TOKEN)$/i;

export const env: Command = {
  name: "env",
  description: "Print environment variables",
  async exec(ctx) {
    const lines = Object.entries(ctx.env)
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
