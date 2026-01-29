import { Command } from './index';

/**
 * Spirit command - invokes the Spirit agent (Claude Code for browser).
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   spirit "create a hello world file"
 *
 * Spirit is a git submodule that implements the Claude Code agent loop.
 * This command is the integration point. When Spirit is not yet installed,
 * it prints setup instructions.
 */
export const spiritCmd: Command = {
  name: 'spirit',
  description: 'AI coding agent (Claude Code for browser)',
  async exec(ctx) {
    const apiKey = ctx.env['ANTHROPIC_API_KEY'];

    if (!apiKey) {
      ctx.stdout = [
        'Spirit - AI Coding Agent for Shiro OS',
        '',
        'Spirit is not configured. To set up:',
        '',
        '  export ANTHROPIC_API_KEY=sk-ant-your-key-here',
        '  spirit "your prompt here"',
        '',
        'Spirit will use Claude to read, write, and edit files',
        'in your Shiro filesystem with direct access to all',
        'shell commands.',
        '',
      ].join('\n');
      return 1;
    }

    const prompt = ctx.args.join(' ');
    if (!prompt) {
      ctx.stderr = 'spirit: please provide a prompt\n';
      return 1;
    }

    // Check if Spirit module is available
    const provider = (ctx.shell as any)._spiritProvider;
    if (!provider) {
      ctx.stderr = 'spirit: provider not initialized\n';
      return 1;
    }

    // Try to import and run Spirit
    try {
      // Spirit will be available as a git submodule at /spirit
      // For now, use the direct Anthropic API as a minimal agent loop
      ctx.stdout = await runMinimalAgent(apiKey, prompt, provider);
      return 0;
    } catch (e: any) {
      ctx.stderr = `spirit: ${e.message}\n`;
      return 1;
    }
  },
};

/**
 * Minimal agent loop that will be replaced by Spirit once it's built.
 * This gives us a working `spirit` command immediately using the
 * Anthropic API directly with basic tool support.
 */
async function runMinimalAgent(
  apiKey: string,
  prompt: string,
  provider: any,
): Promise<string> {
  const tools = [
    {
      name: 'bash',
      description: 'Run a shell command',
      input_schema: {
        type: 'object' as const,
        properties: { command: { type: 'string' as const, description: 'The command to run' } },
        required: ['command'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a file and return its contents with line numbers',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string' as const, description: 'File path to read' } },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file (creates parent dirs automatically)',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' as const, description: 'File path to write' },
          content: { type: 'string' as const, description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'glob',
      description: 'Find files matching a glob pattern',
      input_schema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string' as const, description: 'Glob pattern (e.g., **/*.ts)' },
        },
        required: ['pattern'],
      },
    },
  ];

  const systemPrompt = [
    `You are Spirit, an AI coding assistant running inside Shiro OS (a browser-based Unix environment).`,
    `You have access to a virtual filesystem backed by IndexedDB and a shell with Unix commands.`,
    `Current directory: ${provider.getCwd()}`,
    `Available shell commands: ls, cat, grep, sed, git, find, diff, mkdir, rm, cp, mv, etc.`,
    `Use the tools to accomplish the user's request. Be concise in your responses.`,
  ].join('\n');

  const messages: any[] = [{ role: 'user', content: prompt }];
  let output = '';

  // Agent loop: call API, execute tools, repeat until no more tool_use
  for (let turn = 0; turn < 20; turn++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API error ${response.status}: ${err}`);
    }

    const data = await response.json();

    // Collect text and tool_use blocks
    const toolUses: any[] = [];
    for (const block of data.content) {
      if (block.type === 'text') {
        output += block.text + '\n';
        provider.writeToTerminal(block.text + '\n');
      } else if (block.type === 'tool_use') {
        toolUses.push(block);
      }
    }

    if (toolUses.length === 0 || data.stop_reason === 'end_turn') {
      break;
    }

    // Execute tools
    messages.push({ role: 'assistant', content: data.content });
    const toolResults: any[] = [];

    for (const toolUse of toolUses) {
      let result: string;
      try {
        switch (toolUse.name) {
          case 'bash': {
            const { stdout, stderr, exitCode } = await provider.exec(toolUse.input.command);
            result = stdout + (stderr ? '\nSTDERR: ' + stderr : '') + `\n(exit code: ${exitCode})`;
            break;
          }
          case 'read_file': {
            const content = await provider.readFile(toolUse.input.path);
            const lines = content.split('\n');
            result = lines.map((l: string, i: number) => `${(i + 1).toString().padStart(4)}  ${l}`).join('\n');
            break;
          }
          case 'write_file': {
            await provider.writeFile(toolUse.input.path, toolUse.input.content);
            result = `File written: ${toolUse.input.path}`;
            break;
          }
          case 'glob': {
            const matches = await provider.glob(toolUse.input.pattern);
            result = matches.length > 0 ? matches.join('\n') : 'No matches found';
            break;
          }
          default:
            result = `Unknown tool: ${toolUse.name}`;
        }
      } catch (e: any) {
        result = `Error: ${e.message}`;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return output;
}
