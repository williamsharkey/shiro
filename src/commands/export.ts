
import type { Command } from './index';
export const exportCmd: Command = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(ctx) {
    const args = ctx.args;
    // export without args: list all exported variables
    if (args.length === 0) {
      const lines = Object.entries(ctx.env)
        .map(([k, v]) => `export ${k}="${v}"`)
        .sort();
      ctx.stdout += lines.join("\n") + "\n";
      return 0;
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

        if (varName in ctx.env) {
          output.push(`export ${varName}="${ctx.env[varName]}"`);
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

        // Note: In a real shell, this would modify ctx.env in place.
        // Since ctx.env is passed by reference, we can actually do this:
        ctx.env[varName] = value;
        output.push(`export ${varName}="${value}"`);
      }
    }

    if (errors.length > 0) {
      ctx.stderr += errors.join("\n") + "\n";
      return 1;
    }

    // In verbose mode or with no errors, show what was exported
    // For a real export command, we typically output nothing on success
    return 0;
  },
};
