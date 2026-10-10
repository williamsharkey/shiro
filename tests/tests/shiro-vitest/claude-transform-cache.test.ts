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
    const path = claudeTransformPath(await fs.stat(CLAUDE_CODE_CLI_JS))!;
    expect(await fs.readFile(path, 'utf8')).toBe(await transformClaudeSource(CLI));
    expect(await readClaudeTransform(fs as any)).toEqual({ path, text: await transformClaudeSource(CLI) });
    // the next run runs the saved text (an AsyncLocalStorage store still carried across an await)
    await fs.writeFile(path, (await fs.readFile(path, 'utf8')) + '\nconsole.log("from the cache");\n');
    expect(await run()).toMatch(/^cli 1 \d+\.\d+\.\d+\nfrom the cache\n$/);
    // cli.js edited, its size the same: transformed again, the old text removed
    await new Promise((r) => setTimeout(r, 5));
    const edited = CLI.replace("console.log('cli'", "console.log('CLI'");
    await fs.writeFile(CLAUDE_CODE_CLI_JS, edited);
    expect(await run()).toMatch(/^CLI 1 \d+\.\d+\.\d+\n$/);
    const path2 = claudeTransformPath(await fs.stat(CLAUDE_CODE_CLI_JS))!;
    expect(path2).not.toBe(path);
    expect(await cached(fs)).toEqual([path2.split('/').pop()]);
    expect(await fs.readFile(path2, 'utf8')).toBe(await transformClaudeSource(edited));
    // another build: its own file, the old one removed (a guest's commit is fixed under test:worker)
    if (!nodeWorkerMode(shell.env)) {
      await fs.writeFile(path2, (await fs.readFile(path2, 'utf8')) + '\nconsole.log("from the cache");\n');
      g.__BUILD_SHA__ = 'another-build';
      expect(await run()).not.toContain('from the cache');
      expect(await cached(fs)).toEqual([claudeTransformPath(await fs.stat(CLAUDE_CODE_CLI_JS))!.split('/').pop()]);
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
    expect(await readClaudeTransform(fs as any)).toEqual({ path: null, text: null });
  }, 60_000);
});
