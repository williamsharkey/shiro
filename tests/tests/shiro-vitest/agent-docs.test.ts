/**
 * ~/AGENTS.md and ~/CLAUDE.md seeding (src/agent-docs.ts): one accurate file
 * for agents, kept current on existing installs, never over the user's edits.
 * fixtures/agent-docs/ holds what the pre-rename build seeded.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hcCmd } from '@shiro/commands/hc';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { AGENTS_PATH, CLAUDE_PATH, CLAUDE_MD, MANIFEST_PATH, buildAgentsMd, seedAgentDocs } from '@shiro/agent-docs';
import { defaultRuntimeContext, parseRuntimeContext, type ShiroRuntimeContext } from '@shiro/seed-runtime-context';
import { createTestShell, run } from './helpers';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/agent-docs/${name}`, import.meta.url), 'utf8');

const injected: ShiroRuntimeContext = {
  mode: 'seed-blob', injected: true, hcOuterAvailable: true, sameOriginParentAccess: true,
  hostUrl: 'https://parascene.com/feed', hostOrigin: 'https://parascene.com', hostTitle: 'Parascene',
  createdAt: '2026-03-19T10:00:00.000Z',
};

describe('agent docs', () => {
  let shell: Shell;
  let fs: FileSystem;
  const read = (p: string) => fs.readFile(p, 'utf8').then((t) => t as string, () => null);

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    shell.commands.register(hcCmd);
    delete (window as any).__tabcomputer;
    for (const p of [AGENTS_PATH, CLAUDE_PATH, MANIFEST_PATH, '/home/user/NEO.md', '/home/user/.shiro-context.json']) await fs.unlink(p).catch(() => {});
  });

  it('AGENTS.md describes the machine, doctor and the source, and CLAUDE.md imports it', () => {
    const md = buildAgentsMd(defaultRuntimeContext());
    expect(md).toContain('You are on tabcomputer (tabcomputer.com)');
    expect(md).toContain('`doctor`');
    expect(md).toContain('https://github.com/williamsharkey/tabcomputer');
    expect(md).toContain('not checked out');
    expect(md).toContain("runs on its own page");
    expect(md).not.toMatch(/NEO\.md|shiro-context|src\/main\.ts/);
    expect(CLAUDE_MD).toBe('@AGENTS.md\n');
  });

  it('an injected boot tells the agent to start with hc outer', () => {
    const md = buildAgentsMd(injected);
    expect(md).toContain('injected into a host page by `seed blob`');
    expect(md).toContain('https://parascene.com/feed');
    expect(md).toContain('Same-origin access to the host\'s DOM: yes');
    expect(md).toContain('Start with `hc outer`');
  });

  it('a new install gets both files and a manifest', async () => {
    const log = await seedAgentDocs(fs, defaultRuntimeContext());
    expect(log).toEqual([`wrote ${AGENTS_PATH}`, `wrote ${CLAUDE_PATH}`]);
    expect(await read(AGENTS_PATH)).toBe(buildAgentsMd(defaultRuntimeContext()));
    expect(await read(CLAUDE_PATH)).toBe('@AGENTS.md\n');
    expect(Object.keys(JSON.parse((await read(MANIFEST_PATH))!))).toEqual([AGENTS_PATH, CLAUDE_PATH]);
    expect(await seedAgentDocs(fs, defaultRuntimeContext())).toEqual([]);
  });

  it('replaces what the old build seeded and removes NEO.md and .shiro-context.json', async () => {
    await fs.writeFile(AGENTS_PATH, fixture('AGENTS.md'));
    await fs.writeFile(CLAUDE_PATH, fixture('CLAUDE.md'));
    await fs.writeFile('/home/user/NEO.md', fixture('NEO-standalone.md'));
    await fs.writeFile('/home/user/.shiro-context.json', JSON.stringify(defaultRuntimeContext(), null, 2));
    await seedAgentDocs(fs, defaultRuntimeContext());
    expect(await read(AGENTS_PATH)).toBe(buildAgentsMd(defaultRuntimeContext()));
    expect(await read(CLAUDE_PATH)).toBe('@AGENTS.md\n');
    expect(await read('/home/user/NEO.md')).toBe(null);
    expect(await read('/home/user/.shiro-context.json')).toBe(null);
  });

  it('recognizes an injected boot\'s old NEO.md from its context file', async () => {
    const json = fixture('shiro-context.json');
    await fs.writeFile('/home/user/NEO.md', fixture('NEO-injected.md'));
    await fs.writeFile('/home/user/.shiro-context.json', json);
    const log = await seedAgentDocs(fs, parseRuntimeContext(json));
    expect(log).toContain('removed /home/user/NEO.md (now part of AGENTS.md)');
    expect(await read('/home/user/.shiro-context.json')).toBe(null);
  });

  it('never overwrites or removes files the user edited', async () => {
    const mine = fixture('AGENTS.md') + '\n## My notes\n- keep this\n';
    await fs.writeFile(AGENTS_PATH, mine);
    await fs.writeFile('/home/user/NEO.md', fixture('NEO-standalone.md') + 'edited\n');
    await fs.writeFile('/home/user/.shiro-context.json', '{"mine": true}');
    const log = await seedAgentDocs(fs, defaultRuntimeContext());
    expect(log).toContain(`kept ${AGENTS_PATH} (edited)`);
    expect(await read(AGENTS_PATH)).toBe(mine);
    expect(await read('/home/user/NEO.md')).toContain('edited');
    expect(await read('/home/user/.shiro-context.json')).toBe('{"mine": true}');
    expect(await read(CLAUDE_PATH)).toBe('@AGENTS.md\n'); // missing: written
  });

  it('updates its own file on a later boot, but not once the user edits it', async () => {
    await seedAgentDocs(fs, defaultRuntimeContext());
    expect(await seedAgentDocs(fs, injected)).toEqual([`updated ${AGENTS_PATH}`]); // the boot context changed
    expect(await read(AGENTS_PATH)).toContain('hc outer');
    await fs.writeFile(AGENTS_PATH, 'my own instructions\n');
    expect(await seedAgentDocs(fs, defaultRuntimeContext())).toEqual([`kept ${AGENTS_PATH} (edited)`]);
    expect(await read(AGENTS_PATH)).toBe('my own instructions\n');
  });

  it('hc suggests hc outer when runtime context says a host bridge is available', async () => {
    (window as any).__tabcomputer = { runtimeContext: { hcOuterAvailable: true } };
    const { output, exitCode } = await run(shell, 'hc t');
    expect(exitCode).toBe(1);
    expect(output).toContain('hc outer');
    expect(output).toContain('injected into a host page');
  });
});
