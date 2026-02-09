import type { OSProvider } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export const writeTool: ToolDefinition = {
  name: "Write",
  description:
    "Create or overwrite a file with the given content. Creates parent directories if needed.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to write to",
      },
      content: {
        type: "string",
        description: "Content to write",
      },
    },
    required: ["file_path", "content"],
  },
};

export async function executeWrite(
  input: { file_path: string; content: string },
  provider: OSProvider
): Promise<string> {
  const resolved = provider.resolvePath(input.file_path);
  const lastSlash = resolved.lastIndexOf("/");
  if (lastSlash > 0) {
    const parent = resolved.substring(0, lastSlash);
    if (!(await provider.exists(parent))) {
      await provider.mkdir(parent, { recursive: true });
    }
  }
  await provider.writeFile(resolved, input.content);
  return `Successfully wrote to ${resolved}`;
}
