import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
import { extraShadows } from '@shiro/pkg-manager';

// Debian mode: a builtin named like a file in /usr/bin runs the file (debian/overlay.ts).
// bash's own builtins are the exception: bash runs its echo and true even with
// /usr/bin/echo there (and each would be an x86 process, ~150 ms).
describe('Debian-mode shadows and bash builtins', () => {
  it('echo, true and printf stay builtins; a shadowed non-builtin and an explicit path run the file', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/usr/bin', { recursive: true });
    for (const n of ['echo', 'true', 'printf', 'rev']) {
      await fs.writeFile(`/usr/bin/${n}`, `#!/bin/sh\necho FILE-${n}\n`);
      await fs.chmod(`/usr/bin/${n}`, 0o755);
    }
    extraShadows.set(fs, new Set(['echo', 'true', 'printf', 'rev']));
    try {
      expect((await run(shell, 'echo hi; true && printf "%s\\n" ok')).output.replace(/\r/g, '')).toBe('hi\nok\n');
      expect((await run(shell, 'command echo hi')).output.trim()).toBe('hi');
      expect((await run(shell, 'rev')).output).toContain('FILE-rev');
      expect((await run(shell, '/usr/bin/true')).output).toContain('FILE-true');
    } finally {
      extraShadows.delete(fs);
    }
  });
});
