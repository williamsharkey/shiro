import type { FluffyCommand } from "./types";

export const whoami: FluffyCommand = {
  name: "whoami",
  description: "Print current user name",
  async exec(_args, io) {
    const user = io.env.USER ?? io.env.USERNAME ?? "user";
    return { stdout: user + "\n", stderr: "", exitCode: 0 };
  },
};
