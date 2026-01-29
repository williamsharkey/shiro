import type { FluffyCommand } from "../types.js";

export const env: FluffyCommand = {
  name: "env",
  description: "Print environment variables",
  async exec(_args, io) {
    const lines = Object.entries(io.env)
      .map(([k, v]) => `${k}=${v}`)
      .sort();
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  },
};
