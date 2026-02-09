import type { OSProvider } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export const askUserTool: ToolDefinition = {
  name: "AskUserQuestion",
  description: "Ask the user a question and wait for their response.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user",
      },
    },
    required: ["question"],
  },
};

export async function executeAskUser(
  input: { question: string },
  provider: OSProvider
): Promise<string> {
  return provider.readFromUser(input.question);
}
