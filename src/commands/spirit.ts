import { Command } from './index';
import { SpiritAgent } from '../../spirit/src/spirit.js';
import type { ShiroProvider } from '../spirit-provider';

/**
 * Spirit command - invokes the full Spirit agent for browser.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY, GOOGLE_API_KEY
 *   spirit                          # interactive REPL mode
 *   spirit "create a hello world"   # one-shot mode
 *
 * Spirit is a git submodule providing the complete AI agent loop
 * with streaming, extended thinking, permissions, sub-agents, and all tools
 * (Bash, Read, Write, Edit, Glob, AskUser).
 */
export const spiritCmd: Command = {
  name: 'spirit',
  description: 'AI coding agent',
  async exec(ctx) {
    // Check for API keys from multiple providers
    const anthropicKey = ctx.env['ANTHROPIC_API_KEY']
      || (typeof localStorage !== 'undefined' ? localStorage.getItem('shiro_anthropic_key') || '' : '');
    const openaiKey = ctx.env['OPENAI_API_KEY']
      || (typeof localStorage !== 'undefined' ? localStorage.getItem('shiro_openai_key') || '' : '');
    const googleKey = ctx.env['GOOGLE_API_KEY']
      || (typeof localStorage !== 'undefined' ? localStorage.getItem('shiro_google_key') || '' : '');

    // Also check legacy key storage
    const legacyKey = typeof localStorage !== 'undefined' ? localStorage.getItem('shiro_api_key') || '' : '';

    // Use first available key (priority: Anthropic > OpenAI > Google > legacy)
    const apiKey = anthropicKey || openaiKey || googleKey || legacyKey;
    const provider_type = anthropicKey ? 'anthropic'
      : openaiKey ? 'openai'
      : googleKey ? 'google'
      : legacyKey ? 'anthropic' : '';

    if (!apiKey) {
      ctx.stdout = [
        'Spirit - AI Coding Agent for Shiro OS',
        '',
        'Spirit is not configured. Set an API key for your preferred provider:',
        '',
        '  Anthropic (Claude):',
        '    export ANTHROPIC_API_KEY=sk-ant-your-key-here',
        '',
        '  OpenAI (GPT):',
        '    export OPENAI_API_KEY=sk-your-key-here',
        '',
        '  Google (Gemini):',
        '    export GOOGLE_API_KEY=your-key-here',
        '',
        'Or persist keys across sessions:',
        '  shiro config set anthropic_key sk-ant-...',
        '  shiro config set openai_key sk-...',
        '  shiro config set google_key ...',
        '',
        'Then run:',
        '  spirit                          # interactive mode',
        '  spirit "your prompt here"       # one-shot mode',
        '',
        'Slash commands: /help, /clear, /model, /stats, /thinking, /cost, /exit',
        '',
      ].join('\n');
      return 1;
    }

    // Store provider type for potential future multi-provider support
    ctx.env['SPIRIT_PROVIDER'] = provider_type;

    const provider = (ctx.shell as any)._spiritProvider as ShiroProvider | undefined;
    if (!provider) {
      ctx.stderr = 'spirit: provider not initialized\n';
      return 1;
    }

    const agent = createAgent(ctx, provider, apiKey);

    const prompt = ctx.args.join(' ');
    if (prompt) {
      // One-shot mode
      return await runOneShot(ctx, agent, provider, prompt);
    }

    // Interactive REPL mode
    return await runRepl(ctx, agent, provider);
  },
};

function createAgent(
  ctx: { env: Record<string, string> },
  provider: ShiroProvider,
  apiKey: string,
): SpiritAgent {
  return new SpiritAgent(provider, {
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
}

async function runOneShot(
  ctx: { stdout: string; stderr: string },
  agent: SpiritAgent,
  provider: ShiroProvider,
  prompt: string,
): Promise<number> {
  try {
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
}

async function runRepl(
  ctx: { stdout: string; stderr: string },
  agent: SpiritAgent,
  provider: ShiroProvider,
): Promise<number> {
  provider.writeToTerminal('\x1b[1;95mSpirit\x1b[0m — AI Coding Agent\r\n');
  provider.writeToTerminal('\x1b[90mType your prompt, /help for commands, /exit to quit.\x1b[0m\r\n\r\n');

  while (true) {
    const input = await provider.readFromUser('\x1b[95mspirit>\x1b[0m');
    const trimmed = input.trim();

    // Empty input (Ctrl+C) or /exit exits the REPL
    if (trimmed === '' || trimmed === '/exit' || trimmed === '/quit') {
      provider.writeToTerminal('\r\n');
      break;
    }

    // Handle slash commands
    if (trimmed.startsWith('/')) {
      try {
        const { handled, output } = await agent.handleSlashCommand(trimmed);
        if (handled) {
          provider.writeToTerminal(output + '\r\n\r\n');
          continue;
        }
      } catch (e: any) {
        provider.writeToTerminal(`\x1b[31mError: ${e.message}\x1b[0m\r\n`);
        continue;
      }
    }

    // Run the prompt through the agent
    try {
      await agent.run(trimmed);
      provider.writeToTerminal('\r\n');
    } catch (e: any) {
      provider.writeToTerminal(`\x1b[31mError: ${e.message}\x1b[0m\r\n`);
    }
  }

  return 0;
}
