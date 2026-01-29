import type { FluffyCommand } from "../types.js";

export const dirname: FluffyCommand = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(args) {
    if (args.length === 0) {
      return { stdout: "", stderr: "dirname: missing operand\n", exitCode: 1 };
    }
    const path = args[0].replace(/\/+$/, "");
    const lastSlash = path.lastIndexOf("/");
    const result = lastSlash === -1 ? "." : lastSlash === 0 ? "/" : path.slice(0, lastSlash);
    return { stdout: result + "\n", stderr: "", exitCode: 0 };
  },
};
