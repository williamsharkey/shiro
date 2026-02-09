import type { OSProvider } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export const globTool: ToolDefinition = {
  name: "Glob",
  description:
    'Find files matching a glob pattern (e.g., "**/*.ts", "src/**/*.js").',
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match",
      },
      path: {
        type: "string",
        description: "Base directory to search from",
      },
    },
    required: ["pattern"],
  },
};

export async function executeGlob(
  input: { pattern: string; path?: string },
  provider: OSProvider
): Promise<string> {
  const base = input.path ? provider.resolvePath(input.path) : provider.getCwd();
  const results = await provider.glob(input.pattern, base);
  if (results.length === 0) return "No files found";
  return results.join("\n");
}
