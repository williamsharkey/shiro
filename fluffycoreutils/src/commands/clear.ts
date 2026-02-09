import type { FluffyCommand } from "../types.js";

export const clear: FluffyCommand = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1b[2J\x1b[H", stderr: "", exitCode: 0 };
  },
};
