import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('node: a script is idle by its own activity, not the page', () => {
  it('a child exits promptly while its parent keeps fs.promises busy (#76)', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/idle', { recursive: true });
    await fs.writeFile('/tmp/idle/data.txt', 'x');
    // Like Claude Code: a long-running parent with its own async work in flight
    // (here fs.promises churn) while its Bash tool runs a short node script
    await fs.writeFile('/tmp/idle/parent.mjs', `
      import { spawn } from 'child_process';
      import { promises as fsp } from 'fs';
      let busy = true;
      const churn = (async () => {
        while (busy) {
          await fsp.readFile('/tmp/idle/data.txt', 'utf8');
          await new Promise((r) => setImmediate(r));
        }
      })();
      const t0 = Date.now();
      const child = spawn('/bin/sh', ['-c', 'node -e "console.log(42)"'], { stdio: 'pipe' });
      const code = await new Promise((r) => child.on('close', r));
      const ms = Date.now() - t0;
      busy = false;
      await churn;
      console.log('CHILD code=' + code + ' fast=' + (ms < 6000));
    `);
    const { output } = await run(shell, 'node /tmp/idle/parent.mjs');
    expect(output).toContain('CHILD code=0 fast=true');
  }, 40000);
});

describe('node: the script timeout only ends an idle script', () => {
  it('a top-level await still working past 15 s finishes with its output (#77)', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/slow', { recursive: true });
    await fs.writeFile('/tmp/slow/slow.mjs', `
      for (let i = 0; i < 17; i++) await new Promise((r) => setTimeout(r, 1000));
      console.log('DONE');
    `);
    const { output, exitCode } = await run(shell, 'node /tmp/slow/slow.mjs');
    expect(output).toContain('DONE');
    expect(exitCode).toBe(0);
  }, 40000);
});

describe('node fs: stat of a file another process wrote', () => {
  it('keeps one mtime across calls, so Claude Edit does not see a phantom change', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/mt', { recursive: true });
    await fs.writeFile('/tmp/mt/stat.mjs', `
      import fs from 'fs';
      fs.writeFileSync('/tmp/mt/ready', '1');
      let a;
      for (let i = 0; i < 250 && a === undefined; i++) {
        await new Promise((r) => setTimeout(r, 20));
        a = fs.statSync('/tmp/mt/late.txt', { throwIfNoEntry: false })?.mtimeMs;
      }
      await new Promise((r) => setTimeout(r, 60));
      const b = fs.statSync('/tmp/mt/late.txt').mtimeMs;
      console.log(a !== undefined && a === b ? 'STABLE' : 'CHANGED ' + a + ' ' + b);
    `);
    const done = run(shell, 'node /tmp/mt/stat.mjs');
    // Written after the script started (so not preloaded), as the shell or git would
    for (let i = 0; i < 500 && !(await fs.exists('/tmp/mt/ready')); i++) await sleep(10);
    await fs.writeFile('/tmp/mt/late.txt', 'written outside the script');
    const { output } = await done;
    expect(output).toContain('STABLE');
  }, 30000);
});
