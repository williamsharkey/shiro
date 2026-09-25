import { it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
it('env runs commands with settings', async () => {
  const { shell } = await createTestShell();
  expect((await run(shell, 'env FOO=bar printenv FOO')).output.trim()).toBe('bar');
  expect((await run(shell, 'env | grep -c HOME=')).output.trim()).toBe('1');
  expect((await run(shell, 'env X=1 | grep "^X="')).output.trim()).toBe('X=1');
});
