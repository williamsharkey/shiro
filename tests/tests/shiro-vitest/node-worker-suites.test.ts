/**
 * The node suites again, with node as a kernel guest in a Worker
 * (TABCOMPUTER_NODE_WORKER=1): node-compat.test.ts and the issue-6 tests
 * (node-runtime-compat.test.ts), each test's shell starting in worker mode.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestShell, testShellEnv } from './helpers';
import { installNodeWorker } from './node-worker-setup';

const cleanup = await installNodeWorker();
testShellEnv.TABCOMPUTER_NODE_WORKER = '1';
afterAll(() => { delete testShellEnv.TABCOMPUTER_NODE_WORKER; cleanup(); });

await import('./node-compat.test');
await import('./node-runtime-compat.test');

describe('these suites ran with node as a kernel guest', () => {
  it('an execSync in a plain function has its output (only a guest can block)', async () => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute(`node -e 'function f() { return String(require("child_process").execSync("echo guest")); } console.log(f())' < /dev/null`, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('guest\n\n'); // (the command's newline, then log's)
  }, 60_000);
});
