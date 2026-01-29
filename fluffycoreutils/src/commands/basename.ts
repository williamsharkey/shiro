import type { FluffyCommand } from "../types.js";

export const basename: FluffyCommand = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(args) {
    if (args.length === 0) {
      return { stdout: "", stderr: "basename: missing operand\n", exitCode: 1 };
    }
    let name = args[0].replace(/\/+$/, "").split("/").pop() || "/";
    if (args.length > 1 && name.endsWith(args[1])) {
      name = name.slice(0, -args[1].length);
    }
    return { stdout: name + "\n", stderr: "", exitCode: 0 };
  },
};
