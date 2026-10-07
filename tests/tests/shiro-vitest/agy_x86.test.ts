import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
import * as fs from 'fs';

describe('AGY x86 Test', () => {
  it('should get elf info of agy', async () => {
    const { shell, fs: shiroFs } = await createTestShell();
    const { x86Cmd } = await import('@shiro/commands/x86');
    shell.commands.register(x86Cmd);
    
    // Read agy binary
    const agyBin = fs.readFileSync('/home/wm/.local/bin/agy');
    await shiroFs.writeFile('/bin/agy', agyBin);
    
    const { output, exitCode } = await run(shell, 'x86 info /bin/agy');
    console.log(output);
    expect(exitCode).toBe(0);
  });
});
