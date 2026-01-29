import type { OSProvider } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";
import { bashTool, executeBash } from "./bash.js";
import { readTool, executeRead } from "./read.js";
import { writeTool, executeWrite } from "./write.js";
import { editTool, executeEdit } from "./edit.js";
import { globTool, executeGlob } from "./glob.js";
import { grepTool, executeGrep } from "./grep.js";
import { askUserTool, executeAskUser } from "./ask-user.js";

type ToolExecutor = (
  input: Record<string, unknown>,
  provider: OSProvider
) => Promise<string>;

interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  constructor() {
    this.register(bashTool, executeBash as ToolExecutor);
    this.register(readTool, executeRead as ToolExecutor);
    this.register(writeTool, executeWrite as ToolExecutor);
    this.register(editTool, executeEdit as ToolExecutor);
    this.register(globTool, executeGlob as ToolExecutor);
    this.register(grepTool, executeGrep as ToolExecutor);
    this.register(askUserTool, executeAskUser as ToolExecutor);
  }

  register(definition: ToolDefinition, execute: ToolExecutor): void {
    this.tools.set(definition.name, { definition, execute });
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    provider: OSProvider
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(input, provider);
  }
}
