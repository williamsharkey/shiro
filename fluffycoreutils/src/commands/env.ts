import type { FluffyCommand } from "../types.js";

// Patterns that indicate a sensitive env var (case-insensitive match on key)
const SECRET_PATTERNS = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|GITHUB_TOKEN)$/i;

export const env: FluffyCommand = {
  name: "env",
  description: "Print environment variables",
  async exec(_args, io) {
    const lines = Object.entries(io.env)
      .map(([k, v]) => {
        if (SECRET_PATTERNS.test(k) && v && v.length >= 8) {
          return `${k}=${v.slice(0, 4)}${'*'.repeat(Math.min(v.length - 4, 20))}`;
        }
        return `${k}=${v}`;
      })
      .sort();
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  },
};
