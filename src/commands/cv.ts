/**
 * cv — Computer Vision command.
 * Captures a webcam frame (or reads an image file) and sends it to the
 * Anthropic Messages API with a user prompt. Streams the response to stdout.
 *
 * Usage:
 *   cv "describe this"                  # capture from camera + prompt
 *   cv -f photo.png "what's here?"      # use existing file
 *   camera | cv "transcribe this"       # pipe camera output path
 *   cv --list-models                    # show available models
 */

import type { Command, CommandContext } from './index';
import { parseArgs } from './flags';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;

const USAGE =
  'Usage: cv [options] <prompt>\n' +
  '\n' +
  '  cv "describe this"                Capture webcam + prompt\n' +
  '  cv -f image.png "what is this?"   Use existing image file\n' +
  '  camera | cv "transcribe this"     Pipe image path from camera\n' +
  '\n' +
  'Options:\n' +
  '  -f, --file <path>       Read image from file instead of camera\n' +
  '  --model <name>          Model to use (default: ' + DEFAULT_MODEL + ')\n' +
  '  --max-tokens <n>        Max response tokens (default: 4096)\n' +
  '  --list-models           Show available models\n';

const AVAILABLE_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-20250514',
];

async function captureWebcam(): Promise<Uint8Array> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });

  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    document.body.appendChild(video);

    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video stream'));
      setTimeout(() => resolve(), 3000);
    });
    await new Promise(r => setTimeout(r, 500));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx2d = canvas.getContext('2d')!;
    ctx2d.drawImage(video, 0, 0);
    video.remove();

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => b ? resolve(b) : reject(new Error('Failed to create image')),
        'image/png',
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    stream.getTracks().forEach(t => t.stop());
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export const cvCmd: Command = {
  name: 'cv',
  description: 'Computer vision — send image + prompt to Claude',

  async exec(ctx: CommandContext): Promise<number> {
    const { flags, values, positional } = parseArgs(ctx.args, ['f', 'file', 'model', 'max-tokens']);

    if (flags['list-models']) {
      ctx.stdout = 'Available models:\n';
      for (const m of AVAILABLE_MODELS) {
        ctx.stdout += `  ${m}${m === DEFAULT_MODEL ? ' (default)' : ''}\n`;
      }
      return 0;
    }

    const prompt = positional.join(' ').trim();
    if (!prompt) {
      ctx.stdout = USAGE;
      return 1;
    }

    const apiKey = ctx.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      ctx.stderr = 'cv: ANTHROPIC_API_KEY not set. Use: export ANTHROPIC_API_KEY=sk-...\n';
      return 1;
    }

    const model = values['model'] || DEFAULT_MODEL;
    const maxTokens = parseInt(values['max-tokens'] || '') || DEFAULT_MAX_TOKENS;

    // Acquire image bytes
    let imageBytes: Uint8Array;
    const filePath = values['f'] || values['file'];

    if (filePath) {
      // Read from file
      const resolved = ctx.fs.resolvePath(filePath, ctx.cwd);
      try {
        const data = await ctx.fs.readFile(resolved);
        imageBytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
      } catch {
        ctx.stderr = `cv: cannot read file: ${filePath}\n`;
        return 1;
      }
    } else if (ctx.stdin.trim()) {
      // Pipe: stdin is a file path from camera
      const pipedPath = ctx.stdin.trim();
      const resolved = ctx.fs.resolvePath(pipedPath, ctx.cwd);
      try {
        const data = await ctx.fs.readFile(resolved);
        imageBytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
      } catch {
        ctx.stderr = `cv: cannot read piped file: ${pipedPath}\n`;
        return 1;
      }
    } else {
      // Capture from webcam
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        ctx.stderr = 'cv: webcam not available (no getUserMedia)\n';
        return 1;
      }
      try {
        imageBytes = await captureWebcam();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('denied') || msg.includes('NotAllowed')) {
          ctx.stderr = 'cv: webcam access denied\n';
        } else {
          ctx.stderr = `cv: webcam capture failed: ${msg}\n`;
        }
        return 1;
      }
    }

    const base64 = uint8ToBase64(imageBytes);

    // Build API request
    const body = {
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    };

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
      ctx.stderr = `cv: network error: ${e instanceof Error ? e.message : String(e)}\n`;
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
      ctx.stderr = `cv: API error: ${errMsg}\n`;
      return 1;
    }

    // Stream SSE response
    const reader = response.body?.getReader();
    if (!reader) {
      ctx.stderr = 'cv: no response body\n';
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
