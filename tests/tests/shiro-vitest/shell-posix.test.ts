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

describe('exported and unexported variables', () => {
  it('a new shell gets only exported variables; NAME=v cmd exports for that command', async () => {
    const r = await script([
      'echo \'echo ${var-unset}\' > /tmp/scr',
      'var=hi; sh /tmp/scr',
      'var=here sh /tmp/scr',
      'sh /tmp/scr',
      'export var; sh /tmp/scr',
      'export -n var; sh /tmp/scr',
      'unset var; var=again; sh /tmp/scr',
    ].join('\n'));
    expect(r.out).toBe('unset\nhere\nunset\nhi\nunset\nunset\n');
  });

  it('export NAME without a value is listed by export -p; sh prints POSIX form', async () => {
    const r = await script('unset x; export x; export -p | grep "x$"; y=1; export -p | grep -c "^export y" ; true\n');
    expect(r.out).toBe('export x\n0\n');
  });

  it('as sh, assigning to a readonly variable ends the script (for loops too)', async () => {
    let r = await script('readonly a=b\nexport a=c\necho unreached\n');
    expect(r.out).toBe('');
    expect(r.status).toBe(1);
    r = await script('(for x in a b c; do echo $x; readonly x; done); echo "status $?"\n');
    expect(r.out).toBe('a\nstatus 1\n');
  });

  it('bash keeps going after a readonly assignment error', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/b.sh', 'readonly a=b\na=c\necho "still $a"\n');
    let out = '';
    await shell.execute('bash /tmp/b.sh', (s) => { out += s; }, () => {});
    expect(out.replace(/\r\n/g, '\n')).toBe('still b\n');
  });
});

describe('patterns, quoting and expansions', () => {
  it('bracket expressions: ] first, [!]…], classes, [.c.] and [=c=] in globs and case', async () => {
    const r = await script([
      'mkdir /tmp/g && cd /tmp/g && touch file- filea file]',
      'echo file[]x] file[!]x-] file[[:alpha:]] file[[.-.]] file[[=-=]] file[-123]',
      't=\'ab]cd\'',
      'case c in ( *["${t}"]* ) case e in ( *[!"${t}"]* ) echo inner;; esac ;; ( * ) echo outer ;; esac',
      'case \'"\' in ( *["${t}"]* ) echo QUOTED ;; ( * ) echo UNQUOTED ;; esac',
    ].join('\n'));
    expect(r.err).toBe('');
    expect(r.out).toBe('file] filea filea file- file- file-\ninner\nUNQUOTED\n');
  });

  it('a backslash in double quotes stays before * ? [', async () => {
    const r = await script('echo "\\[]" "\\*" "\\?" "\\$" "\\a"\n');
    expect(r.out).toBe('\\[] \\* \\? $ \\a\n');
  });

  it('~ expands to one field that is not globbed', async () => {
    const r = await script('mkdir /tmp/h && cd /tmp/h && touch a1 a2\nHOME="weird    times"; printf "%s\\n" ~\nHOME=\'a*\'; printf "%s\\n" ~\n');
    expect(r.out).toBe('weird    times\na*\n');
  });

  it('"${v=$*}" joins with the first IFS character and keeps the words intact', async () => {
    const r = await script('set -- a "s p  aces" b\nIFS=":"\nprintf "<%s>\\n" "${v=$*}"\nunset v IFS\nprintf "<%s>\\n" "${v=$*}"\n');
    expect(r.out).toBe('<a:s p  aces:b>\n<a s p  aces b>\n');
  });

  it('a new shell starts with the default IFS', async () => {
    const r = await script('export IFS=123\nsh -c \'printf "[%s]" "$IFS"\'\n');
    expect(r.out).toBe('[ \t\n]');
  });
});

describe('traps, set -u, exec and loops', () => {
  it('a subshell runs its own EXIT trap; plain trap in a subshell lists the parent\'s', async () => {
    const r = await script([
      "trap 'echo bye' EXIT",
      '(trap)',
      "(trap 'echo so long' EXIT; trap)",
      "x=$(trap 'echo in-sub' EXIT; echo body); echo \"[$x]\"",
      "f() { (trap \"echo $var\" EXIT); }; var=ok f",
    ].join('\n'));
    expect(r.out).toBe("trap -- 'echo bye' EXIT\ntrap -- 'echo so long' EXIT\nso long\n[body\nin-sub]\nok\nbye\n");
  });

  it('set -u: an unset parameter ends the script or the subshell (1, as bash for a script file); ${x-…} forms are fine', async () => {
    const r = await script('set -u\necho "${nonesuch-d}${nonesuch:+x} $#"\n(echo $zz); echo "sub=$?"\necho $((zz + 1))\necho unreached\n');
    expect(r.out).toBe('d 0\nsub=1\n');
    expect(r.status).toBe(1);
    expect(r.err).toContain('zz: unbound variable');
  });

  it('exec CMD ends a script with its status; a function definition sets $? to 0', async () => {
    let r = await script('(exec echo hi; echo no); echo after\nfalse\nf() { :; }\necho $?\nexec false\necho unreached\n');
    expect(r.out).toBe('hi\nafter\n0\n');
    expect(r.status).toBe(1);
    r = await script('. /nonexistent\necho unreached\n');
    expect(r.out).toBe('');
    expect(r.status).toBe(1);
  });

  it('$? in $(…) is the caller\'s; $?>file is a word and a redirect', async () => {
    const r = await script('(exit 5)\nx=$(echo $?>/tmp/ec); cat /tmp/ec\n(exit 6)\ncase a$(echo $?>/tmp/ec2) in b) ;; esac; cat /tmp/ec2\n');
    expect(r.out).toBe('5\n6\n');
  });

  it('break N inside a subshell leaves only the subshell\'s loops; nested loops parse', async () => {
    const r = await script('for x in a b; do ( for y in c d; do break 2; done; echo $x ); done\nfor x in 1 2; do for y in 3 4; do continue 2; done; echo no; done; echo end\n');
    expect(r.out).toBe('a\nb\nend\n');
  });

  it('here-docs: $(…) inside keeps its own quoting; ${x=word} assigns without quotes', async () => {
    const r = await script('cat <<END\n[$(echo "")] $(echo "q" \'r\') "lit"\nEND\n: ${x:="a b"}; echo "[$x]"\n');
    expect(r.out).toBe('[] q r "lit"\n[a b]\n');
  });
});

describe('more POSIX details', () => {
  it('times prints the shell and children times', async () => {
    const r = await script('times\n');
    expect(r.out).toMatch(/^\d+m\d+\.\d{3}s \d+m\d+\.\d{3}s\n\d+m\d+\.\d{3}s \d+m\d+\.\d{3}s\n$/);
  });

  it('an escaped or quoted & at the end is a word, not a background job', async () => {
    const r = await script("printf '%s\\n' \\&\nx=`printf '%s' \\&`; echo \"[$x]\"\necho 'a &'\n");
    expect(r.out).toBe('&\n[&]\na &\n');
  });

  it('command exec 8<file opens the fd; a redirection error of a special builtin ends an sh script', async () => {
    let r = await script('echo hi >/tmp/f\ncommand exec 8</tmp/f\nread msg <&8\necho "[$msg]"\n');
    expect(r.out).toBe('[hi]\n');
    r = await script(': 2>&9\necho "oh no"\n');
    expect(r.out).toBe('');
    expect(r.status).toBe(1);
  });

  it('subshells keep readonly and shopt; a new shell starts without them', async () => {
    const r = await script('readonly foo=bar\n(foo=baz) 2>/dev/null; echo "sub $?"\nshopt -s extglob\n(case ab in @(ab)) echo ext;; esac)\nset -e; sh -c \'false; echo no-errexit\'\nset -o bad@opt 2>/dev/null\necho unreached\n');
    expect(r.out).toBe('sub 1\next\nno-errexit\n');
    expect(r.status).toBe(2);
  });
});

describe('assignment order, fds of compounds, eval, hash', () => {
  it('a=1 b=$a: values expand in order; as sh, prefixes of special builtins stay', async () => {
    const r = await script('x=5 y=$((x+2)) :\necho "[$x] [$y]"\nunset x y\na=1 b=$a sh -c \'echo "in: $a $b"\'\nc=1 d=$c; echo "[$c $d]"\nx=old; x=new echo $x\n');
    expect(r.out).toBe('[5] [7]\nin: 1 1\n[1 1]\nold\n');
  });

  it('fds 3-9 redirected on a compound are put back after it', async () => {
    const r = await script('echo hi >/tmp/f7\n{ read l <&7; echo "got $l"; } 7</tmp/f7\nread m <&7 2>/dev/null; echo "after $?"\n{ exec 8</dev/null; } 8<&-; : <&8 2>/dev/null; echo "closed $?"\n{ echo to7 >&7; } 7>/tmp/g7; cat /tmp/g7\n');
    expect(r.out).toBe('got hi\nafter 1\nclosed 1\nto7\n');
  });

  it('"${x-w}" keeps the value\'s backslashes; ${#} is $#', async () => {
    const r = await script("y='a\\\\b'\necho \"${y-u}\" ${y-u}\nset -- 1 2\necho ${#}\n");
    expect(r.out).toBe('a\\\\b a\\\\b\n2\n');
  });

  it('eval with an unfinished compound is a syntax error (fatal as sh)', async () => {
    const r = await script('eval "if"\necho lived\n');
    expect(r.out).toBe('');
    expect(r.status).toBe(2);
  });

  it('hash lists commands run by name; -r forgets them', async () => {
    const r = await script('ls >/dev/null\nhash | grep -c ls\nhash -r\nhash | grep -c ls; true\n');
    expect(r.out).toBe('1\n0\n');
  });
});

describe('fd copies made by exec', () => {
  it('exec 3>&1 >/dev/null: fd 3 is still the old stdout, in this shell and in children', async () => {
    const r = await script([
      'exec 3>&1 1>/dev/null 2>/dev/null',
      'echo hidden',
      "sh -c 'echo via3 >&3'",
      '( echo sub3 >&3 )',
      'x=$(echo cap >&3); echo "[$x]" >&3',
      'echo p >&3 | cat',
    ].join('\n'));
    expect(r.out).toBe('via3\nsub3\ncap\n[]\np\n');
  });

  it('exec 2>&1 >/dev/null: fd 2 is the old stdout; a plain >&1 follows the pipe', async () => {
    const r = await script('echo a >&1 | tr a b\nexec 2>&1 1>/dev/null; echo viaerr >&2; echo gone\n');
    expect(r.out).toBe('b\nviaerr\n');
  });
});

describe('named pipes opened with exec', () => {
  it('a subshell closes the fifo ends it opened; children write through the same end', async () => {
    const r = await script("mkdir /tmp/ff && cd /tmp/ff && mkfifo p\n(exec 4>p; exec 3>&4; sh -c 'echo via3 >&3'; (echo sub >&3); echo own >&4) &\ncat < p\n");
    expect(r.out).toBe('via3\nsub\nown\n');
  });
});

describe('read in a pipeline inside a script', () => {
  it('`cmd | read` reads the pipe, not the stdin the script was given', async () => {
    const r = await script('echo | read\necho status=$?\nshopt -s lastpipe\necho hi | read line\necho "line=$line"\n');
    expect(r.out).toBe('status=0\nline=hi\n');
  });
});

describe('/dev/full', () => {
  it('writes fail (exit 1), reads give zeros', async () => {
    const r = await script('echo hi >/dev/full 2>/dev/null || echo failed\nhead -c 3 /dev/full | od -An -tx1\n');
    expect(r.out).toBe('failed\n 00 00 00\n');
  });
});
