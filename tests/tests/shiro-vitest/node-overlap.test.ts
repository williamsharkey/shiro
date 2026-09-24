import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('overlapping node processes', () => {
  it('a failing child does not remove setImmediate from a running parent', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/overlap', { recursive: true });
    await fs.writeFile('/tmp/overlap/child.js', `throw new Error('child failed on purpose');`);
    await fs.writeFile('/tmp/overlap/parent.mjs', `
      import { spawn } from 'child_process';
      const child = spawn('/bin/sh', ['-c', 'node /tmp/overlap/child.js'], { stdio: 'pipe' });
      await new Promise((r) => child.on('close', r));
      await new Promise((r) => setImmediate(r));
      console.log('PARENT-OK');
    `);
    const { output } = await run(shell, 'node /tmp/overlap/parent.mjs');
    expect(output).toContain('PARENT-OK');
  }, 30000); // two node startups; slower than the 5s default
});
