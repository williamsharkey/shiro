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

describe('a finishing script restoring page globals', () => {
  it('leaves globals that a later, still-running script installed', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/overlap', { recursive: true });
    // Like ~/strudel/autostart.js: a short script that launches a long-lived one from a timer
    // and is still running (a pending timer) while the long-lived one starts up
    await fs.writeFile('/tmp/overlap/a.js', `setTimeout(() => { globalThis.__startB(); setTimeout(() => {}, 3000); }, 50);`);
    // Like Claude Code: installs a Node-style setTimeout and keeps using it after A has exited
    await fs.writeFile('/tmp/overlap/b.mjs', `
      const native = globalThis.setTimeout;
      const mine = (fn, ms) => ({ id: native(fn, ms), unref() { return this; } });
      globalThis.setTimeout = mine;
      await new Promise((r) => native(r, 5000)); // until after A has exited
      // (Node's own setTimeout also has unref, so check identity, not behavior)
      console.log(globalThis.setTimeout === mine ? 'B-OK' : 'B-CLOBBERED');
    `);
    let bOutput = '';
    let bDone!: Promise<number>;
    (globalThis as any).__startB = () => {
      bDone = shell.fork().execute('node /tmp/overlap/b.mjs', (s: string) => { bOutput += s; }, (s: string) => { bOutput += s; });
    };
    await run(shell, 'node /tmp/overlap/a.js');
    await bDone;
    delete (globalThis as any).__startB;
    expect(bOutput).toContain('B-OK');
  }, 30000);
});
