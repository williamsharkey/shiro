import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { seedCmd } from '@shiro/commands/seed';
import { extractShiroSeed } from '@shiro/gif-encoder';

// ─── Polyfills & Mocks ──────────────────────────────────────

// localStorage polyfill
{
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

// ─── Canvas 2D Mock ──────────────────────────────────────────
// linkedom doesn't provide CanvasRenderingContext2D.
// We create a mock that stores pixel data in a backing buffer.

function createMockCanvas(w = 320, h = 176) {
  // Backing RGBA pixel buffer (all #1a1a2e background by default)
  const pixels = new Uint8ClampedArray(w * h * 4);
  // Fill with terminal background
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0x1a; pixels[i + 1] = 0x1a; pixels[i + 2] = 0x2e; pixels[i + 3] = 255;
  }

  const ctx = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '14px monospace',
    textBaseline: 'top',
    fillRect(x: number, y: number, rw: number, rh: number) {
      // Parse fillStyle color and write to buffer
      const [r, g, b] = parseColor(this.fillStyle as string);
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(w, Math.ceil(x + rw));
      const y1 = Math.min(h, Math.ceil(y + rh));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const idx = (py * w + px) * 4;
          pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
        }
      }
    },
    fillText() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    getImageData(sx: number, sy: number, sw: number, sh: number) {
      // Return the full pixel buffer (simple — assumes full canvas request)
      return { width: sw, height: sh, data: new Uint8ClampedArray(pixels) };
    },
  };

  return {
    width: w,
    height: h,
    getContext: (type: string) => type === '2d' ? ctx : null,
    // For compatibility with HTMLCanvasElement interface
    setAttribute: () => {},
    getAttribute: () => null,
  };
}

function parseColor(color: string): [number, number, number] {
  if (color.startsWith('#') && color.length === 7) {
    return [
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
    ];
  }
  if (color.startsWith('rgba(') || color.startsWith('rgb(')) {
    const m = color.match(/[\d.]+/g);
    if (m) return [parseInt(m[0]), parseInt(m[1]), parseInt(m[2])];
  }
  return [0, 0, 0];
}

// ─── Download Capture ────────────────────────────────────────

let lastDownloadBlob: Blob | null = null;
let lastDownloadFilename: string | null = null;
let origCreateElement: typeof document.createElement;

function installDownloadCapture() {
  lastDownloadBlob = null;
  lastDownloadFilename = null;

  (globalThis as any).URL.createObjectURL = (blob: Blob) => {
    lastDownloadBlob = blob;
    return 'blob:test';
  };
  (globalThis as any).URL.revokeObjectURL = () => {};

  origCreateElement = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    if (tag === 'canvas') {
      return createMockCanvas() as any;
    }
    const el = origCreateElement(tag);
    if (tag === 'a') {
      (el as any).click = () => {
        lastDownloadFilename = (el as HTMLAnchorElement).download || null;
      };
    }
    return el;
  }) as typeof document.createElement;
}

function teardownDownloadCapture() {
  if (origCreateElement) {
    document.createElement = origCreateElement;
  }
}

// ─── Clipboard Mock ──────────────────────────────────────────

let lastClipboardText: string | null = null;

function installClipboardMock() {
  lastClipboardText = null;
  // navigator is read-only in Node.js — use defineProperty
  const existingNav = (globalThis as any).navigator || {};
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      ...existingNav,
      clipboard: {
        writeText: async (text: string) => { lastClipboardText = text; },
        readText: async () => lastClipboardText || '',
      },
    },
    writable: true,
    configurable: true,
  });
}

// ─── __shiro Mock (for seed gif terminal access) ─────────────

function installShiroMock() {
  const mockBuffer = {
    viewportY: 0, baseY: 0, cursorY: 0,
    getLine: () => ({
      getCell: () => ({
        getChars: () => ' ',
        getFgColorMode: () => 0,
        getFgColor: () => 0,
      }),
    }),
  };
  (window as any).__shiro = {
    terminal: {
      term: {
        cols: 40, rows: 10,
        buffer: { active: mockBuffer },
        options: { theme: { background: '#1a1a2e', foreground: '#e0e0e0' } },
      },
    },
  };
}

// ─── Test Helpers ────────────────────────────────────────────

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}

async function blobToText(blob: Blob): Promise<string> {
  const ab = await blob.arrayBuffer();
  return new TextDecoder().decode(ab);
}

async function createSeedTestEnv() {
  const { fs, shell } = await createTestShell();
  shell.commands.register(seedCmd);

  await fs.mkdir('/home/user/project', { recursive: true });
  await fs.writeFile('/home/user/project/hello.txt', 'Hello, Shiro!');
  await fs.writeFile('/home/user/project/data.json', '{"key":"value","num":42}');
  await fs.writeFile('/home/user/README.md', '# Test Readme\nThis is a test.');

  return { fs, shell };
}

/** Import seed NDJSON + storage into a fresh FileSystem */
async function importSeedIntoFreshFS(ndjson: string, storageJson: string): Promise<FileSystem> {
  const fs2 = new FileSystem();
  await fs2.init();

  const lines = ndjson.split('\n');
  const nodes: any[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const node = JSON.parse(trimmed);
    nodes.push({
      ...node,
      content: node.content
        ? Uint8Array.from(atob(node.content), (c: string) => c.charCodeAt(0))
        : null,
    });
  }
  await fs2.importAll(nodes);

  if (storageJson) {
    const obj = typeof storageJson === 'string' ? JSON.parse(storageJson) : storageJson;
    for (const [k, v] of Object.entries(obj)) {
      localStorage.setItem(k, v as string);
    }
  }

  return fs2;
}

/** Decompress gzipped base64 string */
async function decompressB64(b64: string): Promise<string> {
  const compressed = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(result);
}

// ═════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════

describe('seed gif — GIF export + import roundtrip', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createSeedTestEnv();
    shell = env.shell;
    fs = env.fs;
    installDownloadCapture();
    installShiroMock();
  });

  afterEach(() => {
    teardownDownloadCapture();
    localStorage.clear();
    delete (window as any).__shiro;
  });

  it('should download a GIF with embedded seed data', async () => {
    const { output, exitCode } = await run(shell, 'seed gif');
    expect(exitCode).toBe(0);
    expect(output).toContain('Shiro GIF Seed');
    expect(output).toContain('Downloaded:');
    expect(lastDownloadBlob).not.toBeNull();
    expect(lastDownloadFilename).toMatch(/\.gif$/);
  });

  it('should embed a valid SHIRO1.0 extension that extracts correctly', async () => {
    await run(shell, 'seed gif');
    expect(lastDownloadBlob).not.toBeNull();

    const gifBytes = await blobToUint8Array(lastDownloadBlob!);
    const header = String.fromCharCode(...gifBytes.slice(0, 6));
    expect(header).toBe('GIF89a');

    const seed = await extractShiroSeed(gifBytes);
    expect(seed).not.toBeNull();
    expect(seed!.version).toBe('0.1.0');
    expect(seed!.files).toBeGreaterThanOrEqual(3);
    expect(seed!.ndjson).toBeTruthy();
    expect(seed!.storage).toBeTruthy();
  });

  it('should roundtrip files through GIF export→import', async () => {
    await run(shell, 'seed gif');
    const gifBytes = await blobToUint8Array(lastDownloadBlob!);
    const seed = await extractShiroSeed(gifBytes);
    expect(seed).not.toBeNull();

    const fs2 = await importSeedIntoFreshFS(seed!.ndjson, seed!.storage);

    const hello = await fs2.readFile('/home/user/project/hello.txt', 'utf8');
    expect(hello).toBe('Hello, Shiro!');

    const data = await fs2.readFile('/home/user/project/data.json', 'utf8');
    expect(data).toBe('{"key":"value","num":42}');

    const readme = await fs2.readFile('/home/user/README.md', 'utf8');
    expect(readme).toContain('# Test Readme');
  });

  it('should preserve directory structure in roundtrip', async () => {
    await fs.mkdir('/home/user/project/src/components', { recursive: true });
    await fs.writeFile('/home/user/project/src/components/App.tsx', 'export default function App() {}');

    await run(shell, 'seed gif');
    const gifBytes = await blobToUint8Array(lastDownloadBlob!);
    const seed = await extractShiroSeed(gifBytes);
    const fs2 = await importSeedIntoFreshFS(seed!.ndjson, seed!.storage);

    const stat = await fs2.stat('/home/user/project/src/components');
    expect(stat.isDirectory()).toBe(true);

    const app = await fs2.readFile('/home/user/project/src/components/App.tsx', 'utf8');
    expect(app).toBe('export default function App() {}');
  });

  it('should handle binary file content in roundtrip', async () => {
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    await fs.writeFile('/home/user/binary.bin', binaryData);

    await run(shell, 'seed gif');
    const gifBytes = await blobToUint8Array(lastDownloadBlob!);
    const seed = await extractShiroSeed(gifBytes);
    expect(seed).not.toBeNull();

    const fs2 = await importSeedIntoFreshFS(seed!.ndjson, seed!.storage);
    const restored = await fs2.readFile('/home/user/binary.bin');
    const restoredBytes = restored instanceof Uint8Array ? restored : new TextEncoder().encode(restored as string);
    expect(Array.from(restoredBytes)).toEqual(Array.from(binaryData));
  });

  it('should show stats in output', async () => {
    const { output } = await run(shell, 'seed gif');
    expect(output).toContain('Files:');
    expect(output).toContain('Directories:');
    expect(output).toContain('Data size:');
    expect(output).toContain('GIF size:');
  });
});

describe('extractShiroSeed — non-seed inputs', () => {
  it('should return null for a non-seed GIF', async () => {
    const minGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, 0x02, 0x44, 0x01, 0x00,
      0x3B,
    ]);
    const result = await extractShiroSeed(minGif);
    expect(result).toBeNull();
  });

  it('should return null for non-GIF data', async () => {
    const result = await extractShiroSeed(new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    expect(result).toBeNull();
  });

  it('should return null for empty data', async () => {
    const result = await extractShiroSeed(new Uint8Array(0));
    expect(result).toBeNull();
  });
});

describe('seed html — HTML export + verify seed injection', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createSeedTestEnv();
    shell = env.shell;
    fs = env.fs;
    installDownloadCapture();

    // seed html calls inlineDocument() which uses fetch for external resources
    (globalThis as any).fetch = async () => ({
      text: async () => '/* mock content */',
      ok: true,
    });
  });

  afterEach(() => {
    teardownDownloadCapture();
    localStorage.clear();
    delete (globalThis as any).fetch;
  });

  it('should download an HTML file', async () => {
    const { output, exitCode } = await run(shell, 'seed html');
    expect(exitCode).toBe(0);
    expect(output).toContain('Shiro HTML Seed');
    expect(output).toContain('Downloaded:');
    expect(lastDownloadBlob).not.toBeNull();
    expect(lastDownloadFilename).toMatch(/\.html$/);
  });

  it('should contain a seed injection script with shiro-seed-v2', async () => {
    await run(shell, 'seed html');
    const html = await blobToText(lastDownloadBlob!);
    expect(html).toContain('shiro-seed-v2');
    expect(html).toContain('DecompressionStream');
    expect(html).toContain('</body>');
  });

  it('should contain compressed FS data that decompresses to valid NDJSON', async () => {
    await run(shell, 'seed html');
    const html = await blobToText(lastDownloadBlob!);

    const dcCalls = html.match(/_dc\('([^']+)'\)/g);
    expect(dcCalls).not.toBeNull();
    expect(dcCalls!.length).toBeGreaterThanOrEqual(2);

    // First _dc call is filesystem NDJSON
    const fsB64 = dcCalls![0].match(/_dc\('([^']+)'\)/)![1];
    const ndjson = await decompressB64(fsB64);

    expect(ndjson).toContain('hello.txt');
    expect(ndjson).toContain('data.json');
    expect(ndjson).toContain('README.md');

    // Verify specific file content roundtrips
    const lines = ndjson.split('\n').filter(l => l.trim());
    const helloLine = lines.find(l => l.includes('hello.txt'));
    expect(helloLine).toBeTruthy();
    const helloNode = JSON.parse(helloLine!);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(helloNode.content), c => c.charCodeAt(0))
    );
    expect(decoded).toBe('Hello, Shiro!');
  });

  it('should roundtrip: import decompressed data into fresh FS', async () => {
    await run(shell, 'seed html');
    const html = await blobToText(lastDownloadBlob!);

    const dcCalls = [...html.matchAll(/_dc\('([^']+)'\)/g)];
    const ndjson = await decompressB64(dcCalls[0][1]);
    const storageJson = await decompressB64(dcCalls[1][1]);

    const fs2 = await importSeedIntoFreshFS(ndjson, storageJson);

    const hello = await fs2.readFile('/home/user/project/hello.txt', 'utf8');
    expect(hello).toBe('Hello, Shiro!');

    const data = await fs2.readFile('/home/user/project/data.json', 'utf8');
    expect(data).toBe('{"key":"value","num":42}');
  });

  it('should show stats in output', async () => {
    const { output } = await run(shell, 'seed html');
    expect(output).toContain('Files:');
    expect(output).toContain('Directories:');
    expect(output).toContain('HTML size:');
  });
});

describe('seed — clipboard snippet export', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createSeedTestEnv();
    shell = env.shell;
    fs = env.fs;
    installClipboardMock();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should copy a snippet to clipboard', async () => {
    const { output, exitCode } = await run(shell, 'seed');
    expect(exitCode).toBe(0);
    expect(output).toContain('Copied.');
    expect(lastClipboardText).not.toBeNull();
    expect(lastClipboardText!.length).toBeGreaterThan(100);
  });

  it('should contain shiro seed header', async () => {
    await run(shell, 'seed');
    expect(lastClipboardText).toContain('// shiro seed v0.1.0');
  });

  it('should contain NDJSON filesystem data', async () => {
    await run(shell, 'seed');
    expect(lastClipboardText).toContain('hello.txt');
    expect(lastClipboardText).toContain('data.json');
    expect(lastClipboardText).toContain('README.md');
  });

  it('should contain shiro-seed-v2 message posting', async () => {
    await run(shell, 'seed');
    expect(lastClipboardText).toContain('shiro-seed-v2');
  });

  it('should show file and directory stats', async () => {
    const { output } = await run(shell, 'seed');
    expect(output).toContain('Files:');
    expect(output).toContain('Directories:');
    expect(output).toContain('Seed size:');
  });

  it('should roundtrip: extract NDJSON from snippet and import into fresh FS', async () => {
    await run(shell, 'seed');
    const snippet = lastClipboardText!;

    // Extract NDJSON from template literal: var SEED_FS=`...`;
    const fsMatch = snippet.match(/var SEED_FS=`([\s\S]*?)`;/);
    expect(fsMatch).not.toBeNull();
    const ndjson = fsMatch![1]
      .replace(/\\\\/g, '\\')
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$');

    const storageMatch = snippet.match(/var SEED_STORAGE=`([\s\S]*?)`;/);
    expect(storageMatch).not.toBeNull();
    const storageJson = storageMatch![1]
      .replace(/\\\\/g, '\\')
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$');

    const fs2 = await importSeedIntoFreshFS(ndjson, storageJson);

    const hello = await fs2.readFile('/home/user/project/hello.txt', 'utf8');
    expect(hello).toBe('Hello, Shiro!');

    const data = await fs2.readFile('/home/user/project/data.json', 'utf8');
    expect(data).toBe('{"key":"value","num":42}');
  });

  it('should handle files with special characters in content', async () => {
    await fs.writeFile('/home/user/special.txt', 'backticks: ` dollars: $ backslash: \\');

    const { exitCode } = await run(shell, 'seed');
    expect(exitCode).toBe(0);

    const snippet = lastClipboardText!;
    const fsMatch = snippet.match(/var SEED_FS=`([\s\S]*?)`;/);
    expect(fsMatch).not.toBeNull();
    const ndjson = fsMatch![1]
      .replace(/\\\\/g, '\\')
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$');

    const fs2 = await importSeedIntoFreshFS(ndjson, '{}');
    const content = await fs2.readFile('/home/user/special.txt', 'utf8');
    expect(content).toBe('backticks: ` dollars: $ backslash: \\');
  });
});

describe('seed blob — self-contained clipboard snippet', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createSeedTestEnv();
    shell = env.shell;
    fs = env.fs;
    installClipboardMock();

    (globalThis as any).fetch = async () => ({
      text: async () => '/* mock content */',
      ok: true,
    });
  });

  afterEach(() => {
    localStorage.clear();
    delete (globalThis as any).fetch;
  });

  it('should copy a blob snippet to clipboard', async () => {
    const { output, exitCode } = await run(shell, 'seed blob');
    expect(exitCode).toBe(0);
    expect(output).toContain('Copied.');
    expect(lastClipboardText).not.toBeNull();
  });

  it('should contain blob seed header', async () => {
    await run(shell, 'seed blob');
    expect(lastClipboardText).toContain('// shiro blob seed v0.1.0');
  });

  it('should be self-contained with DecompressionStream', async () => {
    await run(shell, 'seed blob');
    expect(lastClipboardText).toContain('DecompressionStream');
    expect(lastClipboardText).toContain('shiro-seed-v2');
  });

  it('should contain 3 compressed base64 _dc calls', async () => {
    await run(shell, 'seed blob');
    const dcCalls = lastClipboardText!.match(/_dc\('([^']+)'\)/g);
    expect(dcCalls).not.toBeNull();
    expect(dcCalls!.length).toBe(3);
  });

  it('should roundtrip: decompress FS data and verify files', async () => {
    await run(shell, 'seed blob');
    const snippet = lastClipboardText!;

    const dcMatches = [...snippet.matchAll(/_dc\('([^']+)'\)/g)];
    expect(dcMatches.length).toBe(3);

    // [0]=html, [1]=fs, [2]=storage
    const ndjson = await decompressB64(dcMatches[1][1]);
    const storageJson = await decompressB64(dcMatches[2][1]);

    const fs2 = await importSeedIntoFreshFS(ndjson, storageJson);

    const hello = await fs2.readFile('/home/user/project/hello.txt', 'utf8');
    expect(hello).toBe('Hello, Shiro!');

    const data = await fs2.readFile('/home/user/project/data.json', 'utf8');
    expect(data).toBe('{"key":"value","num":42}');

    const readme = await fs2.readFile('/home/user/README.md', 'utf8');
    expect(readme).toContain('# Test Readme');
  });
});

describe('seed — API key detection', () => {
  let shell: Shell;

  beforeEach(async () => {
    const env = await createSeedTestEnv();
    shell = env.shell;
    installClipboardMock();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should warn when API keys are detected in localStorage', async () => {
    localStorage.setItem('shiro_api_key', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const { output } = await run(shell, 'seed');
    expect(output).toContain('API keys detected');
  });

  it('should not warn when no API keys are present', async () => {
    const { output } = await run(shell, 'seed');
    expect(output).not.toContain('API keys detected');
  });
});
