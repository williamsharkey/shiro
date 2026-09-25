import { it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

it('du sums file sizes through subdirectories', async () => {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/d/sub', { recursive: true });
  await fs.writeFile('/tmp/d/a.txt', 'x'.repeat(5000));
  await fs.writeFile('/tmp/d/sub/b.txt', 'y'.repeat(3000));
  expect((await run(shell, 'du -s /tmp/d')).output.trim()).toBe('8\t/tmp/d');
  expect((await run(shell, 'du -sh /tmp/d')).output.trim()).toBe('8K\t/tmp/d');
  expect((await run(shell, 'du -a /tmp/d')).output).toContain('/tmp/d/sub/b.txt');
});
