import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { ghCmd } from '@shiro/commands/gh';

describe('expansion results are data, not syntax', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    await fs.writeFile('/tmp/j.json', '[{"path":"a.js","mode":"100644"}]');
  });

  const out = async (cmd: string) => (await run(shell, cmd)).output.replace(/\r/g, '');

  it('keeps quotes inside variables', async () => {
    expect(await out(`x='{"a":1}'; echo "$x"`)).toBe('{"a":1}\n');
    expect(await out(`x='it'"'"'s'; echo "$x"`)).toBe("it's\n");
  });

  it('keeps quotes in command substitution output', async () => {
    expect(await out('echo "$(cat /tmp/j.json)"')).toBe('[{"path":"a.js","mode":"100644"}]\n');
    expect(await out('x="$(cat /tmp/j.json)"; echo "$x"')).toBe('[{"path":"a.js","mode":"100644"}]\n');
  });

  it('does not expand $ or backslashes that came from output', async () => {
    expect(await out(`echo "$(echo '$HOME')"`)).toBe('$HOME\n');
    expect(await out(`v='a\\nb'; echo "$v"`)).toBe('a\\nb\n');
  });

  it('still word-splits unquoted expansions', async () => {
    expect(await out('x="a b c"; for w in $x; do echo "[$w]"; done')).toBe('[a]\n[b]\n[c]\n');
  });

  it('gh api -F key=@file sends the file contents', async () => {
    (shell as any).commands.register(ghCmd);
    await fs.writeFile('/tmp/body.txt', 'hello file');
    const r = await out('gh api --dry-run -X POST repos/o/r/git/blobs -F content=@/tmp/body.txt -F tree="$(cat /tmp/j.json)"');
    expect(r).toContain('content: "hello file"');
    expect(r).toContain('tree: [{"path":"a.js","mode":"100644"}]');
  });

  it('leaves single-quoted and escaped substitutions alone', async () => {
    expect(await out(`echo '$(echo no)' "$(echo yes)"`)).toBe('$(echo no) yes\n');
    expect(await out("echo '`echo no`'")).toBe('`echo no`\n');
    expect(await out('echo \\$(echo no)')).toBe('$(echo no)\n');
    expect(await out('echo "a \\`x\\` b"')).toBe('a `x` b\n');
  });

  it('time/env/exec re-run the parsed command without re-splitting it', async () => {
    const t = await out(`time echo "a;b"`);
    expect(t.startsWith('a;b\n')).toBe(true);
    expect(await out(`env echo "it's; fine"`)).toBe("it's; fine\n");
  });

  it('handles nested quotes inside $(...) inside double quotes', async () => {
    expect(await out('R=r/x; echo "1 $(echo -f content="$(cat /tmp/j.json)" -X $R)"'))
      .toBe('1 -f content=[{"path":"a.js","mode":"100644"}] -X r/x\n');
  });
});
