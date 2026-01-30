import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const xargs: FluffyCommand = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(args, io) {
    const { flags, positional, values } = parseArgs(args, ["n", "I", "i", "d", "delimiter"]);
    const onePerLine = flags.I || flags.L || flags.l;
    const replaceStr = values.I || values.i; // -I{} or -i
    const maxArgs = values.n ? parseInt(values.n) : undefined;
    const delimiter = values.d || values.delimiter || /\s+/;
    const verbose = flags.t || flags.verbose;
    const noRunIfEmpty = flags.r;

    const command = positional.length > 0 ? positional.join(" ") : "echo";

    // Parse input items
    let inputItems: string[];
    if (typeof delimiter === "string") {
      inputItems = io.stdin.split(delimiter).filter(Boolean);
    } else {
      inputItems = io.stdin.trim().split(delimiter).filter(Boolean);
    }

    if (inputItems.length === 0) {
      if (noRunIfEmpty) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // Run command with no arguments if not using -r
      inputItems = [""];
    }

    const outputs: string[] = [];
    const commands: string[] = [];

    // Handle -I (replace string) mode
    if (replaceStr) {
      const placeholder = typeof replaceStr === "string" ? replaceStr : "{}";
      for (const item of inputItems) {
        const cmd = command.replace(new RegExp(escapeRegex(placeholder), "g"), item);
        commands.push(cmd);
        if (verbose) {
          outputs.push(`+ ${cmd}`);
        }
      }
    }
    // Handle -n (max args per command) mode
    else if (maxArgs) {
      for (let i = 0; i < inputItems.length; i += maxArgs) {
        const batch = inputItems.slice(i, i + maxArgs);
        const cmd = `${command} ${batch.map(escapeArg).join(" ")}`;
        commands.push(cmd);
        if (verbose) {
          outputs.push(`+ ${cmd}`);
        }
      }
    }
    // Handle one-per-line mode
    else if (onePerLine) {
      for (const item of inputItems) {
        const cmd = `${command} ${escapeArg(item)}`;
        commands.push(cmd);
        if (verbose) {
          outputs.push(`+ ${cmd}`);
        }
      }
    }
    // Default: all items in one command
    else {
      const cmd = command === "echo"
        ? inputItems.join(" ")
        : `${command} ${inputItems.map(escapeArg).join(" ")}`;
      commands.push(cmd);
      if (verbose) {
        outputs.push(`+ ${cmd}`);
      }
    }

    // In browser environment, we output the commands
    // A shell integration would execute these
    if (command === "echo" && !replaceStr && !maxArgs) {
      // Special case: echo just outputs the items
      outputs.push(...inputItems);
    } else {
      // Output constructed command lines for execution
      outputs.push(...commands);
    }

    return {
      stdout: outputs.join("\n") + (outputs.length > 0 ? "\n" : ""),
      stderr: "",
      exitCode: 0
    };
  },
};

function escapeArg(s: string): string {
  if (/[^a-zA-Z0-9._\-/=]/.test(s)) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return s;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
