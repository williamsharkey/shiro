import type { OSProvider } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export const readTool: ToolDefinition = {
  name: "Read",
  description:
    "Read the contents of a file. Returns the file content with line numbers.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to read",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read",
      },
    },
    required: ["file_path"],
  },
};

export async function executeRead(
  input: { file_path: string; offset?: number; limit?: number },
  provider: OSProvider
): Promise<string> {
  const resolved = provider.resolvePath(input.file_path);
  const content = await provider.readFile(resolved);
  const lines = content.split("\n");
  const start = (input.offset ?? 1) - 1;
  const end = input.limit ? start + input.limit : lines.length;
  const slice = lines.slice(start, end);
  return slice
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join("\n");
}
