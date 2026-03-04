/**
 * spirit — AI-native shell command.
 * Sends a prompt (with optional stdin) to the Claude API and streams the response.
 *
 * Usage:
 *   spirit "write a hello world Express app" > server.js
 *   cat data.csv | spirit "summarize this data"
 *   spirit --list-models
 */

import type { Command, CommandContext } from './index';
import { parseArgs } from './flags';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;

const USAGE =
  'Usage: spirit [options] <prompt>\n' +
  '\n' +
  '  spirit "write a hello world"          Generate mode — prompt only\n' +
  '  cat data.csv | spirit "summarize"     Pipe mode — stdin + prompt\n' +
  '  spirit --system "You are a poet" "write about the sea"\n' +
  '\n' +
  'Options:\n' +
  '  --model <name>          Model to use (default: ' + DEFAULT_MODEL + ')\n' +
  '  --max-tokens <n>        Max response tokens (default: 4096)\n' +
  '  --system <msg>          System prompt\n' +
  '  --list-models           Show available models\n' +
  '  -h, --help              Show this help\n';

const AVAILABLE_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-20250514',
];

export const spiritCmd: Command = {
  name: 'spirit',
  description: 'AI assistant — send prompt (+ optional stdin) to Claude',

  async exec(ctx: CommandContext): Promise<number> {
    const { flags, values, positional } = parseArgs(ctx.args, ['model', 'max-tokens', 'system']);

    if (flags['h'] || flags['help']) {
      ctx.stdout = USAGE;
      return 0;
    }

    if (flags['list-models']) {
      ctx.stdout = 'Available models:\n';
      for (const m of AVAILABLE_MODELS) {
        ctx.stdout += `  ${m}${m === DEFAULT_MODEL ? ' (default)' : ''}\n`;
      }
      return 0;
    }

    const prompt = positional.join(' ').trim();
    const stdinContent = ctx.stdin.trim();

    if (!prompt && !stdinContent) {
      ctx.stdout = USAGE;
      return 1;
    }

    const apiKey = ctx.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      ctx.stderr = 'spirit: ANTHROPIC_API_KEY not set. Use: export ANTHROPIC_API_KEY=sk-...\n';
      return 1;
    }

    const model = values['model'] || DEFAULT_MODEL;
    const maxTokens = parseInt(values['max-tokens'] || '') || DEFAULT_MAX_TOKENS;
    const systemPrompt = values['system'];

    // Build user message: stdin content + prompt
    let userContent: string;
    if (stdinContent && prompt) {
      userContent = `${stdinContent}\n\n${prompt}`;
    } else if (stdinContent) {
      userContent = stdinContent;
    } else {
      userContent = prompt;
    }

    // Build API request
    const body: any = {
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'user', content: userContent }],
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
    } catch (e: unknown) {
      ctx.stderr = `spirit: network error: ${e instanceof Error ? e.message : String(e)}\n`;
      return 1;
    }

    if (!response.ok) {
      let errMsg: string;
      try {
        const errBody = await response.json();
        errMsg = errBody.error?.message || JSON.stringify(errBody);
      } catch {
        errMsg = `HTTP ${response.status}`;
      }
      ctx.stderr = `spirit: API error: ${errMsg}\n`;
      return 1;
    }

    // Stream SSE response
    const reader = response.body?.getReader();
    if (!reader) {
      ctx.stderr = 'spirit: no response body\n';
      return 1;
    }

    const decoder = new TextDecoder();
    const writeOutput = ctx.terminal
      ? (s: string) => ctx.terminal!.writeOutput(s)
      : (s: string) => { ctx.stdout += s; };

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            writeOutput(event.delta.text);
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }

    writeOutput('\n');
    return 0;
  },
};
