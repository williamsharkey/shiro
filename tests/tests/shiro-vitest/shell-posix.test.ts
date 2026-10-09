/**
 * POSIX shell behaviour found through the smoosh conformance suite
 * (tests/conformance/smoosh-posix.conf.ts): signals to the shell itself,
 * $$/$PPID/$!, background jobs and kill.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function script(text: string) {
  const { fs, shell } = await createTestShell();
  await fs.writeFile('/tmp/t.sh', text);
  let out = '';
  let err = '';
  const status = await shell.execute('sh /tmp/t.sh', (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err, status };
}

describe('signals to the shell (kill $$)', () => {
  it('runs the trap before the next command, keeping $?', async () => {
    const r = await script('trap \'echo trapped\' TERM\nfalse; kill $$; echo "after $?"\nkill -s USR1 $$\necho unreached\n');
    expect(r.out).toBe('trapped\nafter 0\n');
    expect(r.status).toBe(128 + 10);
  });

  it('an untrapped terminating signal ends the script with 128+N; trap \'\' ignores it', async () => {
    let r = await script('kill -TERM $$\necho unreached\n');
    expect(r.out).toBe('');
    expect(r.status).toBe(143);
    r = await script('trap \'\' INT\nkill -INT $$\necho survived\n');
    expect(r.out).toBe('survived\n');
  });

  it('kill -s 0 $$ succeeds; a subshell signals the parent shell', async () => {
    const r = await script('kill -s 0 $$ && echo alive\ntrap \'echo got HUP\' HUP\n(kill -HUP $$)\necho next\n');
    expect(r.out).toBe('alive\ngot HUP\nnext\n');
  });
});

describe('$$, $PPID and $!', () => {
  it('sh -c has its own $$ and the caller as $PPID; $(sh -c …) too; a subshell keeps $$', async () => {
    const r = await script([
      'a=$(sh -c \'echo $PPID\')',
      'sh -c \'echo $PPID\' > /tmp/p2',
      '[ "$a" = "$(cat /tmp/p2)" ] && echo same-ppid',
      '[ "$a" = $$ ] && echo is-me',
      '[ "$(sh -c \'echo $$\')" != $$ ] && echo own-pid',
      '(echo $$) > /tmp/p3; [ "$(cat /tmp/p3)" = $$ ] && echo subshell-keeps',
    ].join('\n'));
    expect(r.out).toBe('same-ppid\nis-me\nown-pid\nsubshell-keeps\n');
  });

  it('`sh script &`: $! is that shell\'s $$', async () => {
    const r = await script('echo \'echo $$ > /tmp/pid.out\' > /tmp/s.sh\nsh /tmp/s.sh &\nwait\n[ "$!" -eq "$(cat /tmp/pid.out)" ] && echo ok\n');
    expect(r.out).toBe('ok\n');
  });
});

describe('background jobs', () => {
  it('kill $! ends the job; wait reports 128+N', async () => {
    const t0 = Date.now();
    const r = await script('sleep 10 &\npid=$!\nkill $pid; echo "kill $?"\nwait $pid; echo "wait $?"\n');
    expect(r.out).toBe('kill 0\nwait 143\n');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('jobs -l shows the pid in $!', async () => {
    const r = await script('sleep 2 & pid=$!\njobs -l | grep -q "$pid" && echo listed\nkill $pid\n');
    expect(r.out).toBe('listed\n');
  });

  it('an async list in a script ignores SIGINT and SIGQUIT (POSIX 2.11)', async () => {
    const r = await script('(kill -s QUIT $(sh -c \'echo $PPID\') || exit 1; echo done) &\nwait $!; echo "status $?"\n');
    expect(r.out).toBe('done\nstatus 0\n');
  });
});
