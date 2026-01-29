import type { FluffyCommand } from "../types.js";

const falseCmd: FluffyCommand = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  },
};

export { falseCmd as false };
