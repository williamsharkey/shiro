/** Claude Code's cli.js kept as node-compat runs it (src/claude-transform-cache.ts) */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import { CLAUDE_CODE_CLI_JS, CLAUDE_CODE_DIR } from '@shiro/claude-code-version';
import { TEST_BUILD_SHA } from './node-worker-setup';
import { claudeTransformPath, ensureClaudeTransform, readClaudeTransform, transformClaudeSource } from '@shiro/claude-transform-cache';

const g = globalThis as any;
afterEach(() => { delete g.__BUILD_SHA__; });

const CLI = `#!/usr/bin/env node
import { AsyncLocalStorage } from 'node:async_hooks';
const VERSION = { VERSION:"2.1.112" };
const als = new AsyncLocalStorage();
await als.run(1, async () => { await null; console.log('cli', als.getStore(), VERSION.VERSION); });
`;

describe('the cached transform of cli.js', () => {
  it('is the text node-compat would run; written once per build and cli.js, older ones removed; node runs it', async () => {
    // (the commit a node guest in `npm run test:worker` was built with, so it finds the same file)
    g.__BUILD_SHA__ = TEST_BUILD_SHA;
    const { fs, shell } = await createTestShell();
    await fs.mkdir(CLAUDE_CODE_DIR, { recursive: true });
    await fs.writeFile(CLAUDE_CODE_CLI_JS, CLI);
    await ensureClaudeTransform(fs as any);
    const path = claudeTransformPath(CLI.length)!;
    expect(await fs.readFile(path, 'utf8')).toBe(await transformClaudeSource(CLI));
    expect(await readClaudeTransform(fs as any)).toBe(await transformClaudeSource(CLI));
    // not written again
    await fs.writeFile(path, (await fs.readFile(path, 'utf8')) + '\nconsole.log("from the cache");\n');
    await ensureClaudeTransform(fs as any);
    expect(await fs.readFile(path, 'utf8')).toContain('from the cache');
    // node runs the cached text
    let out = '';
    await shell.execute(`node ${CLAUDE_CODE_CLI_JS} < /dev/null`, (s) => { out += s; }, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toMatch(/from the cache\n[\s\S]*cli 1 \d+\.\d+\.\d+\n|cli 1 \d+\.\d+\.\d+\n[\s\S]*from the cache\n/);
    // another build: a new file, the old one gone
    g.__BUILD_SHA__ = 'another-build';
    await ensureClaudeTransform(fs as any);
    const names = (await fs.readdir(CLAUDE_CODE_DIR)).filter((n: string) => n.startsWith('.tabcomputer-cli-'));
    expect(names).toEqual([claudeTransformPath(CLI.length)!.split('/').pop()]);
  }, 60_000);

  it('a build without a commit keeps none', async () => {
    const { fs } = await createTestShell();
    await fs.mkdir(CLAUDE_CODE_DIR, { recursive: true });
    await fs.writeFile(CLAUDE_CODE_CLI_JS, CLI);
    for (const n of await fs.readdir(CLAUDE_CODE_DIR)) if (n.startsWith('.tabcomputer-cli-')) await fs.unlink(`${CLAUDE_CODE_DIR}/${n}`);
    await ensureClaudeTransform(fs as any);
    expect((await fs.readdir(CLAUDE_CODE_DIR)).filter((n: string) => n.startsWith('.tabcomputer-cli-'))).toEqual([]);
    expect(await readClaudeTransform(fs as any)).toBeNull();
  });
});
