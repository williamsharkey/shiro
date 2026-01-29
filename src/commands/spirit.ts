import { Command } from './index';
import { SpiritAgent } from '../../spirit/src/spirit.js';
import type { ShiroProvider } from '../spirit-provider';

/**
 * Spirit command - invokes the full Spirit agent (Claude Code for browser).
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   spirit "create a hello world file"
 *
 * Spirit is a git submodule providing the complete Claude Code agent loop
 * with streaming, extended thinking, permissions, sub-agents, and all tools
 * (Bash, Read, Write, Edit, Glob, AskUser).
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
        'Spirit uses Claude to read, write, and edit files',
        'in your Shiro filesystem with access to all shell commands.',
        '',
        'Slash commands: /help, /clear, /model, /stats, /thinking, /cost',
        '',
      ].join('\n');
      return 1;
    }

    const prompt = ctx.args.join(' ');
    if (!prompt) {
      ctx.stderr = 'spirit: please provide a prompt\n';
      return 1;
    }

    const provider = (ctx.shell as any)._spiritProvider as ShiroProvider | undefined;
    if (!provider) {
      ctx.stderr = 'spirit: provider not initialized\n';
      return 1;
    }

    try {
      const agent = new SpiritAgent(provider, {
        apiKey,
        model: ctx.env['SPIRIT_MODEL'] || 'claude-sonnet-4-20250514',
        maxTurns: parseInt(ctx.env['SPIRIT_MAX_TURNS'] || '30', 10),
        maxTokens: parseInt(ctx.env['SPIRIT_MAX_TOKENS'] || '8192', 10),
        thinkingBudget: ctx.env['SPIRIT_THINKING']
          ? parseInt(ctx.env['SPIRIT_THINKING'], 10)
          : undefined,
        onText: (text: string) => {
          provider.writeToTerminal(text);
        },
        onThinking: (thinking: string) => {
          provider.writeToTerminal(`\x1b[2m${thinking}\x1b[0m`);
        },
        onToolStart: (name: string, input: Record<string, unknown>) => {
          const summary = name === 'Bash'
            ? `$ ${input.command}`
            : name === 'Read'
              ? `Reading ${input.file_path}`
              : name === 'Write'
                ? `Writing ${input.file_path}`
                : name === 'Edit'
                  ? `Editing ${input.file_path}`
                  : name === 'Glob'
                    ? `Glob ${input.pattern}`
                    : `${name}`;
          provider.writeToTerminal(`\x1b[36m⟫ ${summary}\x1b[0m\n`);
        },
        onToolEnd: (_name: string, _result: string) => {
          // Tool results are shown by the agent's text output
        },
        onError: (error: Error) => {
          provider.writeToTerminal(`\x1b[31mError: ${error.message}\x1b[0m\n`);
        },
      });

      // Check for slash commands first
      if (prompt.startsWith('/')) {
        const { handled, output } = await agent.handleSlashCommand(prompt);
        if (handled) {
          ctx.stdout = output + '\n';
          return 0;
        }
      }

      const result = await agent.run(prompt);
      ctx.stdout = result;
      return 0;
    } catch (e: any) {
      ctx.stderr = `spirit: ${e.message}\n`;
      return 1;
    }
  },
};
