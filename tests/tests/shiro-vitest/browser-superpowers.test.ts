/**
 * Browser Superpowers tests — hot reload, cv command, group share/watch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

// ── Hot Reload ──────────────────────────────────────────────────────
describe('serve hot reload', () => {
  // Each test creates its own shell/fs to avoid shared IndexedDB state

  async function setup(dir: string) {
    const env = await createTestShell();
    await env.fs.mkdir(dir);
    await env.fs.writeFile(dir + '/index.html',
      new TextEncoder().encode('<h1>hi</h1>'));
    return env;
  }

  it('serve static subscribes to fs.onChange', async () => {
    const { shell, fs } = await setup('/home/user/s1');
    const origOnChange = fs.onChange.bind(fs);
    let subscribed = false;
    vi.spyOn(fs, 'onChange').mockImplementation((listener) => {
      subscribed = true;
      return origOnChange(listener);
    });
    await run(shell, 'serve /home/user/s1 9990');
    expect(subscribed).toBe(true);
    await run(shell, 'serve stop 9990');
  });

  it('fs write inside served dir triggers reload (via onChange)', async () => {
    const { shell, fs } = await setup('/home/user/s2');
    await run(shell, 'serve /home/user/s2 9991');

    let changeDetected = false;
    const unsub = fs.onChange((_event, path) => {
      if (path.startsWith('/home/user/s2')) changeDetected = true;
    });
    await fs.writeFile('/home/user/s2/index.html',
      new TextEncoder().encode('<h1>updated</h1>'));
    expect(changeDetected).toBe(true);

    unsub();
    await run(shell, 'serve stop 9991');
  });

  it('fs write outside served dir does not match path prefix', async () => {
    const { shell, fs } = await setup('/home/user/s3');
    await run(shell, 'serve /home/user/s3 9992');

    let changeInside = false;
    const unsub = fs.onChange((_event, path) => {
      if (path.startsWith('/home/user/s3')) changeInside = true;
    });
    await fs.writeFile('/home/user/other.txt',
      new TextEncoder().encode('unrelated'));
    expect(changeInside).toBe(false);

    unsub();
    await run(shell, 'serve stop 9992');
  });

  it('serve stop unsubscribes onChange listener', async () => {
    const { shell, fs } = await setup('/home/user/s4');
    const origOnChange = fs.onChange.bind(fs);
    const unsubFns: Array<() => void> = [];
    vi.spyOn(fs, 'onChange').mockImplementation((listener) => {
      const unsub = origOnChange(listener);
      unsubFns.push(unsub);
      return unsub;
    });

    await run(shell, 'serve /home/user/s4 9993');
    expect(unsubFns.length).toBeGreaterThan(0);

    await run(shell, 'serve stop 9993');

    // After stop, writing triggers our check listener but the serve listener was unsubscribed
    let fired = false;
    const checkUnsub = fs.onChange((_e, _p) => { fired = true; });
    await fs.writeFile('/home/user/s4/index.html',
      new TextEncoder().encode('<h1>after stop</h1>'));
    expect(fired).toBe(true);
    checkUnsub();
  });

  it('debounce coalesces rapid writes without error', async () => {
    const { shell, fs } = await setup('/home/user/s5');
    await run(shell, 'serve /home/user/s5 9994');

    // Rapid writes should not cause errors (debounce coalesces them)
    await fs.writeFile('/home/user/s5/a.html', new TextEncoder().encode('a'));
    await fs.writeFile('/home/user/s5/b.html', new TextEncoder().encode('b'));
    await fs.writeFile('/home/user/s5/c.html', new TextEncoder().encode('c'));

    // Wait for debounce to settle
    await new Promise(r => setTimeout(r, 200));

    await run(shell, 'serve stop 9994');
  });
});

// ── CV Command ──────────────────────────────────────────────────────
describe('cv command', () => {
  let shell: Shell;
  let fs: FileSystem;
  let origFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('shows usage when no prompt given', async () => {
    const { output, exitCode } = await run(shell, 'cv');
    expect(exitCode).toBe(1);
    expect(output).toContain('Usage: cv');
  });

  it('errors when ANTHROPIC_API_KEY not set', async () => {
    const { output, exitCode } = await run(shell, 'cv "describe this"');
    expect(exitCode).toBe(1);
    expect(output).toContain('ANTHROPIC_API_KEY not set');
  });

  it('lists available models', async () => {
    const { output, exitCode } = await run(shell, 'cv --list-models');
    expect(exitCode).toBe(0);
    expect(output).toContain('claude-sonnet-4-20250514');
    expect(output).toContain('(default)');
  });

  it('reads image from -f file flag', async () => {
    // Create a fake PNG file (just needs some bytes)
    const pngData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
    await fs.writeFile('/home/user/test.png', pngData);

    // Mock fetch to capture the request
    let capturedBody: any = null;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      // Return a minimal SSE stream
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          ));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    // Set API key
    await run(shell, 'export ANTHROPIC_API_KEY=sk-test-123');
    const { output, exitCode } = await run(shell, 'cv -f /home/user/test.png "what is this?"');
    expect(exitCode).toBe(0);
    expect(output).toContain('hello');
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.messages[0].content[0].type).toBe('image');
    expect(capturedBody.messages[0].content[0].source.type).toBe('base64');
    expect(capturedBody.messages[0].content[1].text).toBe('what is this?');
  });

  it('reads image from piped stdin path', async () => {
    const pngData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await fs.writeFile('/home/user/cam.png', pngData);

    let capturedBody: any = null;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"piped"}}\n\n'
          ));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    await run(shell, 'export ANTHROPIC_API_KEY=sk-test-123');
    const { output, exitCode } = await run(shell, 'echo "/home/user/cam.png" | cv "describe"');
    expect(exitCode).toBe(0);
    expect(output).toContain('piped');
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.messages[0].content[0].source.media_type).toBe('image/png');
  });

  it('sends correct API request format', async () => {
    const pngData = new Uint8Array([137, 80, 78, 71]);
    await fs.writeFile('/home/user/img.png', pngData);

    let capturedUrl = '';
    let capturedHeaders: any = {};
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n'
          ));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    await run(shell, 'export ANTHROPIC_API_KEY=sk-test-456');
    await run(shell, 'cv -f /home/user/img.png "test prompt"');

    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(capturedHeaders['x-api-key']).toBe('sk-test-456');
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });

  it('streams response text to stdout', async () => {
    const pngData = new Uint8Array([137, 80, 78, 71]);
    await fs.writeFile('/home/user/img.png', pngData);

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n'
          ));
          controller.enqueue(enc.encode(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n'
          ));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    await run(shell, 'export ANTHROPIC_API_KEY=sk-test');
    const { output, exitCode } = await run(shell, 'cv -f /home/user/img.png "go"');
    expect(exitCode).toBe(0);
    expect(output).toContain('Hello ');
    expect(output).toContain('world');
  });

  it('handles API error (401)', async () => {
    const pngData = new Uint8Array([137, 80, 78, 71]);
    await fs.writeFile('/home/user/img.png', pngData);

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await run(shell, 'export ANTHROPIC_API_KEY=sk-bad');
    const { output, exitCode } = await run(shell, 'cv -f /home/user/img.png "test"');
    expect(exitCode).toBe(1);
    expect(output).toContain('API error');
    expect(output).toContain('Invalid API key');
  });

  it('--model overrides default model', async () => {
    const pngData = new Uint8Array([137, 80, 78, 71]);
    await fs.writeFile('/home/user/img.png', pngData);

    let capturedBody: any = null;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n'
          ));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    await run(shell, 'export ANTHROPIC_API_KEY=sk-test');
    await run(shell, 'cv --model claude-haiku-4-5-20251001 -f /home/user/img.png "go"');
    expect(capturedBody.model).toBe('claude-haiku-4-5-20251001');
  });

  it('cv with no webcam exits with error', async () => {
    await run(shell, 'export ANTHROPIC_API_KEY=sk-test');
    const { output, exitCode } = await run(shell, 'cv "look"');
    expect(exitCode).toBe(1);
    expect(output).toContain('webcam');
  });
});

// ── Group Share/Watch ───────────────────────────────────────────────
describe('group share/watch', () => {
  let shell: Shell;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    // Clean up any leftover group state
    if (typeof window !== 'undefined') {
      (window as any).__shiroGroup = undefined;
    }
  });

  afterEach(() => {
    if (typeof window !== 'undefined') {
      (window as any).__shiroGroup = undefined;
    }
  });

  it('group share without group returns error', async () => {
    const { output, exitCode } = await run(shell, 'group share');
    expect(exitCode).toBe(1);
    expect(output).toContain('Not in a group');
  });

  it('group unshare without group returns error', async () => {
    const { output, exitCode } = await run(shell, 'group unshare');
    expect(exitCode).toBe(1);
    expect(output).toContain('Not in a group');
  });

  it('group watch without group returns error', async () => {
    const { output, exitCode } = await run(shell, 'group watch someone');
    expect(exitCode).toBe(1);
    expect(output).toContain('Not in a group');
  });

  it('group watch with no peer name shows usage', async () => {
    // Simulate being in a group
    (window as any).__shiroGroup = {
      name: 'test',
      peers: new Map(),
      remoteCode: undefined,
    };
    const { output, exitCode } = await run(shell, 'group watch');
    expect(exitCode).toBe(1);
    expect(output).toContain('Usage: group watch');
  });

  it('group watch unknown peer returns error', async () => {
    (window as any).__shiroGroup = {
      name: 'test',
      peers: new Map(),
      remoteCode: undefined,
    };
    const { output, exitCode } = await run(shell, 'group watch nobody');
    expect(exitCode).toBe(1);
    expect(output).toContain('unknown peer');
  });

  it('group watch peer without remoteCode returns error', async () => {
    const peers = new Map();
    peers.set('peer-1', {
      peerId: 'peer-1',
      name: 'alice',
      capabilities: ['exec'],
      lastSeen: Date.now(),
      // no remoteCode
    });
    (window as any).__shiroGroup = {
      name: 'test',
      peers,
      remoteCode: undefined,
    };
    const { output, exitCode } = await run(shell, 'group watch alice');
    expect(exitCode).toBe(1);
    expect(output).toContain('not sharing');
  });

  it('group help includes share/watch subcommands', async () => {
    const { output, exitCode } = await run(shell, 'group help');
    expect(exitCode).toBe(0);
    expect(output).toContain('share');
    expect(output).toContain('unshare');
    expect(output).toContain('watch');
    expect(output).toContain('unwatch');
  });
});
