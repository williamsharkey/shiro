/** sudo (src/commands/sudo.ts) runs its command with uid 0; Shiro's own id reports it. */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('sudo', () => {
  it("runs Shiro's builtins as root", async () => {
    const { shell } = await createTestShell();
    expect((await run(shell, 'id -u')).output.trim()).toBe('1000');
    expect((await run(shell, 'sudo id -u')).output.trim()).toBe('0');
    expect((await run(shell, 'sudo id -un')).output.trim()).toBe('root');
    expect((await run(shell, 'sudo id')).output).toContain('uid=0(root) gid=0(root)');
  });
});
