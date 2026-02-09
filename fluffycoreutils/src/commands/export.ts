import type { FluffyCommand } from "../types.js";

export const exportCmd: FluffyCommand = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(args, io) {
    // export without args: list all exported variables
    if (args.length === 0) {
      const lines = Object.entries(io.env)
        .map(([k, v]) => `export ${k}="${v}"`)
        .sort();
      return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
    }

    // Parse variable assignments
    const output: string[] = [];
    const errors: string[] = [];

    for (const arg of args) {
      // Handle: export VAR=value or export VAR
      const eqIndex = arg.indexOf("=");

      if (eqIndex === -1) {
        // export VAR (mark existing variable as exported)
        const varName = arg;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
          errors.push(`export: \`${varName}': not a valid identifier`);
          continue;
        }

        if (varName in io.env) {
          output.push(`export ${varName}="${io.env[varName]}"`);
        } else {
          // Variable doesn't exist yet; mark it for export but with empty value
          output.push(`export ${varName}=""`);
        }
      } else {
        // export VAR=value
        const varName = arg.slice(0, eqIndex);
        let value = arg.slice(eqIndex + 1);

        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
          errors.push(`export: \`${varName}': not a valid identifier`);
          continue;
        }

        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        // Note: In a real shell, this would modify io.env in place.
        // Since io.env is passed by reference, we can actually do this:
        io.env[varName] = value;
        output.push(`export ${varName}="${value}"`);
      }
    }

    if (errors.length > 0) {
      return {
        stdout: "",
        stderr: errors.join("\n") + "\n",
        exitCode: 1
      };
    }

    // In verbose mode or with no errors, show what was exported
    // For a real export command, we typically output nothing on success
    return { stdout: "", stderr: "", exitCode: 0 };
  },
};
