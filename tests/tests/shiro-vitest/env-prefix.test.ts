import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell, splitEnvPrefix } from '@shiro/shell';

describe('NAME=value command prefixes', () => {
  let shell: Shell;

  beforeEach(async () => {
    shell = (await createTestShell()).shell;
  });

  it('splits leading assignments off a command', () => {
    expect(splitEnvPrefix('A=1 B="x y" claude --flag')).toEqual({
      assignments: [['A', '1'], ['B', 'x y']],
      rest: 'claude --flag',
    });
    expect(splitEnvPrefix('A=1')).toBeNull();
    expect(splitEnvPrefix('echo A=1')).toBeNull();
    expect(splitEnvPrefix('arr=(a b)')).toBeNull();
  });

  it('runs the command with the variable set', async () => {
    const { output } = await run(shell, 'FOO=bar printenv FOO');
    expect(output).toContain('bar');
  });

  it('does not leak the variable into the shell', async () => {
    await run(shell, 'FOO=bar echo hi');
    expect(shell.env['FOO']).toBeUndefined();
    shell.env['KEEP'] = 'old';
    const { output } = await run(shell, 'KEEP=new printenv KEEP');
    expect(output).toContain('new');
    expect(shell.env['KEEP']).toBe('old');
  });

  it('keeps plain assignments working', async () => {
    await run(shell, 'FOO=bar');
    expect(shell.env['FOO']).toBe('bar');
  });
});
