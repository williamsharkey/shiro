import type { FluffyCommand } from "../types.js";

const trueCmd: FluffyCommand = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
};

export { trueCmd as true };
