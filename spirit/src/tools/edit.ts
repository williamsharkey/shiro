import type { OSProvider } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export const editTool: ToolDefinition = {
  name: "Edit",
  description:
    "Make a surgical edit to a file by replacing an exact string match with new content. The old_string must match exactly once in the file.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "Exact string to find (must match uniquely)",
      },
      new_string: {
        type: "string",
        description: "Replacement string",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
};

export async function executeEdit(
  input: { file_path: string; old_string: string; new_string: string },
  provider: OSProvider
): Promise<string> {
  const resolved = provider.resolvePath(input.file_path);
  const content = await provider.readFile(resolved);
  const occurrences = content.split(input.old_string).length - 1;

  if (occurrences === 0) {
    return `Error: old_string not found in ${resolved}`;
  }
  if (occurrences > 1) {
    return `Error: old_string found ${occurrences} times in ${resolved}. Must match exactly once. Add more surrounding context to make it unique.`;
  }

  const newContent = content.replace(input.old_string, input.new_string);
  await provider.writeFile(resolved, newContent);
  return `Successfully edited ${resolved}`;
}
