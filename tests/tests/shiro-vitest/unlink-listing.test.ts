import { it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { nodeCmd } from '@shiro/commands/jseval';

it('readdirSync and existsSync reflect unlinkSync immediately', async () => {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/c', { recursive: true });
  for (let i = 0; i < 5; i++) await fs.writeFile(`/tmp/c/f${i}.bin`, 'x');
  const ctx: any = {
    args: ['-e', `const fs=require('fs'); const d='/tmp/c/'; fs.existsSync(d+'missing'); for (const f of fs.readdirSync(d)) fs.unlinkSync(d+f); console.log(fs.readdirSync(d).length, fs.existsSync(d+'f0.bin'));`],
    fs, cwd: '/', env: { ...shell.env }, stdin: '', stdout: '', stderr: '', shell,
  };
  await nodeCmd.exec(ctx);
  expect(ctx.stdout.trim()).toBe('0 false');
  expect(await fs.readdir('/tmp/c')).toEqual([]);
});
