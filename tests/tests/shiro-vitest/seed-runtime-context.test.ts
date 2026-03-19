import { beforeEach, describe, expect, it } from 'vitest';
import { hcCmd } from '@shiro/commands/hc';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import {
  buildNeoMd,
  type ShiroRuntimeContext,
  writeRuntimeContextFiles,
} from '@shiro/seed-runtime-context';
import { createTestShell, run } from './helpers';

describe('seed runtime context', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    shell.commands.register(hcCmd);
    delete (window as any).__shiro;
  });

  it('buildNeoMd tells seeded Claude instances to start with hc outer', () => {
    const md = buildNeoMd({
      mode: 'seed-blob',
      injected: true,
      hcOuterAvailable: true,
      sameOriginParentAccess: true,
      hostUrl: 'https://parascene.com/feed',
      hostOrigin: 'https://parascene.com',
      hostTitle: 'Parascene',
      createdAt: '2026-03-19T10:00:00.000Z',
    });

    expect(md).toContain('seed blob injection');
    expect(md).toContain('hc outer');
    expect(md).toContain('https://parascene.com/feed');
    expect(md).toContain('Same-origin parent DOM access: yes');
  });

  it('writeRuntimeContextFiles writes both NEO.md and machine-readable JSON', async () => {
    const context: ShiroRuntimeContext = {
      mode: 'seed',
      injected: true,
      hcOuterAvailable: true,
      sameOriginParentAccess: false,
      hostUrl: 'https://example.com',
      hostOrigin: 'https://example.com',
      hostTitle: 'Example',
      createdAt: '2026-03-19T10:00:00.000Z',
    };

    await writeRuntimeContextFiles(fs, context);

    const neo = await fs.readFile('/home/user/NEO.md', 'utf8') as string;
    const json = JSON.parse(await fs.readFile('/home/user/.shiro-context.json', 'utf8') as string);

    expect(neo).toContain('hc outer');
    expect(neo).toContain('https://example.com');
    expect(json).toEqual(context);
  });

  it('hc suggests hc outer when runtime context says a host bridge is available', async () => {
    (window as any).__shiro = {
      runtimeContext: {
        hcOuterAvailable: true,
      },
    };

    const { output, exitCode } = await run(shell, 'hc t');
    expect(exitCode).toBe(1);
    expect(output).toContain('hc outer');
    expect(output).toContain('injected into a host page');
  });
});
