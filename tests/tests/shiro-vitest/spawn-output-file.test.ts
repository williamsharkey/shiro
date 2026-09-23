import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('spawn with an fs/promises output fd (Claude Bash tool)', () => {
  it('writes the command output into the opened file', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/spawnfd', { recursive: true });
    await fs.writeFile('/tmp/spawnfd/run.mjs', `
      import { open } from 'fs/promises';
      import { spawn } from 'child_process';
      import { readFileSync, constants as C } from 'fs';
      const out = '/tmp/spawnfd/task.output';
      const h = await open(out, C.O_WRONLY | C.O_CREAT | C.O_APPEND);
      if (!h.fd) throw new Error('fs/promises open returned fd ' + h.fd);
      const child = spawn('/bin/sh', ['-c', 'echo captured-output'], { stdio: ['pipe', h.fd, h.fd] });
      await new Promise((r) => child.on('close', r));
      await h.close();
      console.log('FILE:' + readFileSync(out, 'utf8').trim());
      // Read it back the way Claude's TaskOutput does: open 'r', stat, read, dispose
      const r = await open(out, 'r');
      const asyncDispose = Symbol.asyncDispose || Symbol.for('Symbol.asyncDispose');
      if (typeof r[asyncDispose] !== 'function') throw new Error('handle not async-disposable');
      const size = (await r.stat()).size;
      const buf = Buffer.alloc(size);
      const { bytesRead } = await r.read(buf, 0, size, 0);
      await r[asyncDispose]();
      console.log('HANDLE:' + buf.toString('utf8', 0, bytesRead).trim());
    `);
    const { output } = await run(shell, 'node /tmp/spawnfd/run.mjs');
    expect(output).toContain('FILE:captured-output');
    expect(output).toContain('HANDLE:captured-output');
  });
});
