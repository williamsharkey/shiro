import type { OSProvider } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export const bashTool: ToolDefinition = {
  name: "Bash",
  description:
    "Execute a shell command in the virtual terminal. Supports Unix commands, dev tools (node, npm, git, etc.), pipes, redirects, and shell operators.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
    },
    required: ["command"],
  },
};

export async function executeBash(
  input: { command: string },
  provider: OSProvider
): Promise<string> {
  const result = await provider.exec(input.command);
  let output = "";
  if (result.stdout) output += result.stdout;
  if (result.stderr)
    output += (output ? "\n" : "") + "STDERR: " + result.stderr;
  if (result.exitCode !== 0)
    output += `\n[Exit code: ${result.exitCode}]`;
  return output || "(no output)";
}
