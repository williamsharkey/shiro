import type { FluffyCommand } from "../types.js";

export const hostname: FluffyCommand = {
  name: "hostname",
  description: "Print system hostname",
  async exec(_args, io) {
    const name = io.env.HOSTNAME ?? "localhost";
    return { stdout: name + "\n", stderr: "", exitCode: 0 };
  },
};
