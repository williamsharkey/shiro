/**
 * env: -i, -u, -C, -0, -S, --, NAME=value; it runs programs (not shell
 * functions) with exactly the environment asked for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

async function sh(cmd: string) {
  const { shell } = await createTestShell();
  let out = '';
  const code = await shell.execute(`export FOO=1 BAR=2; ${cmd}`, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('env', () => {
  it('-i: an empty environment, plus NAME=value', async () => {
    expect((await sh('env -i | wc -l')).out.trim()).toBe('0');
    expect((await sh('env -i X=1 env')).out).toBe('X=1\n');
    expect((await sh(`env -i sh -c 'echo "[$FOO][$HOME][$PATH]"'`)).out).toBe('[][][]\n');
    // programs are still found (a default search path, not exported)
    expect((await sh(`env -i sh -c 'ls / >/dev/null && echo found'`)).out).toBe('found\n');
  });

  it('-i reaches a kernel program: node sees only what env gave it', async () => {
    const r = await sh(`env -i TABCOMPUTER_NODE_WORKER=1 X=1 node -e 'console.log(["X","FOO","HOME","PATH"].map((k) => k + "=" + (process.env[k] ?? "-")).join(" "))' < /dev/null`);
    expect(r.out).toBe('X=1 FOO=- HOME=- PATH=-\n');
  }, 60_000);

  it('-u removes a variable; NAME=value adds one; -- ends options', async () => {
    expect((await sh(`env -u FOO sh -c 'echo "[$FOO][$BAR]"'`)).out).toBe('[][2]\n');
    expect((await sh(`env --unset=FOO env | grep -c '^FOO='`)).out.trim()).toBe('0');
    expect((await sh(`env -- BAZ=3 sh -c 'echo $BAZ $FOO'`)).out).toBe('3 1\n');
  });

  it('-C runs the command in another directory; a missing one is 125', async () => {
    expect((await sh('mkdir -p /tmp/envc; env -C /tmp/envc pwd')).out).toBe('/tmp/envc\n');
    const r = await sh('env -C /nonexistent pwd; echo st=$?');
    expect(r.out).toBe("env: cannot change directory to '/nonexistent': No such file or directory\nst=125\n");
  });

  it('-0 ends entries with NUL; -S splits a string into words', async () => {
    expect((await sh('env -0 -i X=1 Y=2 | od -An -c | tr -s " "')).out.trim()).toBe('X = 1 \\0 Y = 2 \\0');
    expect((await sh(`env -S "echo a  'b c'" d`)).out).toBe('a b c d\n');
  });

  it('runs programs, not shell functions; a missing one is 127', async () => {
    expect((await sh('f() { echo func; }; env f 2>/dev/null; echo st=$?')).out).toBe('st=127\n');
    expect((await sh('env nosuchprog 2>/dev/null; echo st=$?')).out).toBe('st=127\n');
  });

  it('/usr/bin/env takes the same options', async () => {
    expect((await sh(`/usr/bin/env -i A=b sh -c 'echo $A $FOO'`)).out).toBe('b\n');
  });
});
