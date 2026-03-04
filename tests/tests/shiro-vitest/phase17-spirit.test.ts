/**
 * Phase 17: Spirit command tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';

describe('spirit command', () => {
  it('spirit --help shows usage', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'spirit --help');
    expect(exitCode).toBe(0);
    expect(output).toContain('Usage: spirit');
    expect(output).toContain('--model');
    expect(output).toContain('--system');
  });

  it('spirit -h shows usage', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'spirit -h');
    expect(exitCode).toBe(0);
    expect(output).toContain('Usage: spirit');
  });

  it('spirit --list-models shows models', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'spirit --list-models');
    expect(exitCode).toBe(0);
    expect(output).toContain('claude-sonnet-4-20250514');
    expect(output).toContain('claude-opus-4-20250514');
    expect(output).toContain('(default)');
  });

  it('spirit with no args and no stdin shows help and exits 1', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'spirit');
    expect(exitCode).toBe(1);
    expect(output).toContain('Usage: spirit');
  });

  it('spirit without API key returns error', async () => {
    const { shell } = await createTestShell();
    // Ensure no API key is set
    delete shell.env['ANTHROPIC_API_KEY'];
    const { output, exitCode } = await run(shell, 'spirit "hello"');
    expect(exitCode).toBe(1);
    expect(output).toContain('ANTHROPIC_API_KEY not set');
  });

  it('spirit with prompt sets up correct API request body', async () => {
    const { shell } = await createTestShell();
    shell.env['ANTHROPIC_API_KEY'] = 'sk-test-key';

    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      }), { status: 200 });
    });

    try {
      const { exitCode } = await run(shell, 'spirit "tell me a joke"');
      expect(exitCode).toBe(0);
      expect(capturedBody).toBeTruthy();
      expect(capturedBody.model).toBe('claude-sonnet-4-20250514');
      expect(capturedBody.stream).toBe(true);
      expect(capturedBody.messages[0].content).toContain('tell me a joke');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('spirit pipe mode includes stdin in message', async () => {
    const { shell } = await createTestShell();
    shell.env['ANTHROPIC_API_KEY'] = 'sk-test-key';

    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Summary"}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      }), { status: 200 });
    });

    try {
      const { exitCode } = await run(shell, 'echo "csv data here" | spirit "summarize this"');
      expect(exitCode).toBe(0);
      expect(capturedBody).toBeTruthy();
      expect(capturedBody.messages[0].content).toContain('csv data here');
      expect(capturedBody.messages[0].content).toContain('summarize this');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
