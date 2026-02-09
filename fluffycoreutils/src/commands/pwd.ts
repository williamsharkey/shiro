import type { FluffyCommand } from "../types.js";

export const pwd: FluffyCommand = {
  name: "pwd",
  description: "Print working directory",
  async exec(_args, io) {
    return { stdout: io.cwd + "\n", stderr: "", exitCode: 0 };
  },
};
