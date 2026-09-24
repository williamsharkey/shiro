import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell, splitTopLevelPipes } from '@shiro/shell';

describe('loops, ifs, and subshells piped onward', () => {
  let shell: Shell;

  beforeEach(async () => {
    shell = (await createTestShell()).shell;
  });

  it('splits only on pipes outside compound commands', () => {
    expect(splitTopLevelPipes('for i in 1 2; do echo $i | cat; done | tail -1'))
      .toEqual(['for i in 1 2; do echo $i | cat; done', 'tail -1']);
    expect(splitTopLevelPipes('if true; then echo a; fi | wc -l')).toEqual(['if true; then echo a; fi', 'wc -l']);
    expect(splitTopLevelPipes('(echo a; echo b) | sort')).toEqual(['(echo a; echo b)', 'sort']);
    expect(splitTopLevelPipes('case $x in a|b) echo y;; esac | cat')).toEqual(['case $x in a|b) echo y;; esac', 'cat']);
    expect(splitTopLevelPipes('echo "a|b" done | cat')).toEqual(['echo "a|b" done', 'cat']);
    expect(splitTopLevelPipes('for i in 1; do echo $i; done')).toEqual(['for i in 1; do echo $i; done']);
    expect(splitTopLevelPipes('while true; do x || y; done')).toEqual(['while true; do x || y; done']);
  });

  it('pipes a for loop into tail', async () => {
    const { output } = await run(shell, 'for i in 1 2 3; do echo $i; done | tail -1');
    expect(output.trim()).toBe('3');
  });

  it('pipes an if block into wc', async () => {
    const { output } = await run(shell, 'if true; then echo a; echo b; fi | wc -l');
    expect(output.trim()).toBe('2');
  });

  it('pipes a subshell into sort', async () => {
    const { output } = await run(shell, '(echo b; echo a) | sort | head -1');
    expect(output.trim()).toBe('a');
  });

  it('chains a loop into another loop', async () => {
    const { output } = await run(shell, 'for i in 1 2 3; do echo $i; done | while read n; do echo x$n; done | tail -1');
    expect(output.trim()).toBe('x3');
  });

  it('keeps pipes inside the loop body', async () => {
    const { output } = await run(shell, 'for w in foo bar; do echo $w | tr a-z A-Z; done');
    expect(output).toContain('FOO');
    expect(output).toContain('BAR');
  });

  it('applies redirections written after done', async () => {
    await run(shell, 'printf "%s\\n" a b c > /tmp/lines');
    const { output } = await run(shell, 'while read l; do echo L$l; done < /tmp/lines | tail -1');
    expect(output.trim()).toBe('Lc');
    await run(shell, 'for i in 1 2; do echo n$i; done > /tmp/loop-out');
    expect((await run(shell, 'cat /tmp/loop-out')).output.replace(/\r/g, '')).toBe('n1\nn2\n');
  });
});

describe('printf', () => {
  let shell: Shell;
  beforeEach(async () => { shell = (await createTestShell()).shell; });

  it('honors redirects and pipes', async () => {
    await run(shell, 'printf hello > /tmp/p1');
    expect((await run(shell, 'cat /tmp/p1')).output).toBe('hello');
    expect((await run(shell, 'printf "x y" | wc -w')).output.trim()).toBe('2');
  });

  it('reuses the format for extra arguments', async () => {
    expect((await run(shell, 'printf "%s-" a b c')).output).toBe('a-b-c-');
  });

  it('still supports -v', async () => {
    await run(shell, 'printf -v OUT "%03d" 7');
    expect(shell.env['OUT']).toBe('007');
  });
});

describe('ls into a pipe', () => {
  it('prints one plain name per line', async () => {
    const { shell } = await createTestShell();
    await run(shell, 'mkdir -p /tmp/lsd/sub && touch /tmp/lsd/a /tmp/lsd/b');
    expect((await run(shell, 'ls /tmp/lsd | wc -l')).output.trim()).toBe('3');
    expect((await run(shell, 'ls /tmp/lsd | tail -1')).output.trim()).toBe('sub');
  });
});
