/** Claude Code's cli.js kept as node-compat runs it (src/claude-transform-cache.ts) */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import { TEST_BUILD_SHA } from './node-worker-setup';
import { CLAUDE_CODE_CLI_JS, CLAUDE_CODE_DIR } from '@shiro/claude-code-version';
import { claudeTransformPath, readClaudeTransform, transformClaudeSource } from '@shiro/claude-transform-cache';
import { nodeWorkerMode } from '@shiro/node-worker/boot';

const g = globalThis as any;
afterEach(() => { delete g.__BUILD_SHA__; });

const CLI = `#!/usr/bin/env node
import { AsyncLocalStorage } from 'node:async_hooks';
const VERSION = { VERSION:"2.1.112" };
const als = new AsyncLocalStorage();
await als.run(1, async () => { await null; console.log('cli', als.getStore(), VERSION.VERSION); });
`;
const cached = async (fs: any) => (await fs.readdir(CLAUDE_CODE_DIR)).filter((n: string) => n.startsWith('.tabcomputer-cli-'));

describe('the cached transform of cli.js', () => {
  it('a run without it saves the text it ran; the next run reads it; another build replaces it', async () => {
    // (the commit a node guest in `npm run test:worker` was built with, so it keys the same file)
    g.__BUILD_SHA__ = TEST_BUILD_SHA;
    const { fs, shell } = await createTestShell();
    await fs.mkdir(CLAUDE_CODE_DIR, { recursive: true });
    await fs.writeFile(CLAUDE_CODE_CLI_JS, CLI);
    for (const n of await cached(fs)) await fs.unlink(`${CLAUDE_CODE_DIR}/${n}`);
    const run = async () => { let out = ''; await shell.execute(`node ${CLAUDE_CODE_CLI_JS} < /dev/null`, (s) => { out += s; }, (s) => { out += s; }); return out.replace(/\r\n/g, '\n'); };
    expect(await run()).toMatch(/^cli 1 \d+\.\d+\.\d+\n$/);
    const path = claudeTransformPath(CLI.length)!;
    expect(await fs.readFile(path, 'utf8')).toBe(await transformClaudeSource(CLI));
    expect(await readClaudeTransform(fs as any)).toBe(await transformClaudeSource(CLI));
    // the next run runs the saved text
    await fs.writeFile(path, (await fs.readFile(path, 'utf8')) + '\nconsole.log("from the cache");\n');
    expect(await run()).toContain('from the cache');
    // another build: its own file, the old one removed (a guest's commit is fixed under test:worker)
    if (!nodeWorkerMode(shell.env)) {
      g.__BUILD_SHA__ = 'another-build';
      expect(await run()).not.toContain('from the cache');
      expect(await cached(fs)).toEqual([claudeTransformPath(CLI.length)!.split('/').pop()]);
    }
  }, 60_000);

  it('a build without a commit keeps none', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir(CLAUDE_CODE_DIR, { recursive: true });
    await fs.writeFile(CLAUDE_CODE_CLI_JS, CLI);
    for (const n of await cached(fs)) await fs.unlink(`${CLAUDE_CODE_DIR}/${n}`);
    if (nodeWorkerMode(shell.env)) return; // (a guest under test:worker has TEST_BUILD_SHA)
    await shell.execute(`node ${CLAUDE_CODE_CLI_JS} < /dev/null`, () => {}, () => {});
    expect(await cached(fs)).toEqual([]);
    expect(await readClaudeTransform(fs as any)).toBeNull();
  }, 60_000);
});
