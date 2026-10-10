/**
 * Regressions found by the oils spec conformance run (tests/conformance):
 * comments, multi-line statements in scripts, exit, set -e, script and
 * command-substitution isolation.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { processTable } from '@shiro/process-table';

async function script(text: string, setup?: (fs: any) => Promise<void>) {
  const { fs, shell } = await createTestShell();
  if (setup) await setup(fs);
  await fs.writeFile('/tmp/t.sh', text);
  let out = '';
  let err = '';
  const status = await shell.execute('sh /tmp/t.sh', (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err, status, fs, shell };
}

describe('shell conformance regressions', () => {
  it('sh FILE > out writes LF, not CRLF', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/a.sh', 'echo hi\n');
    await shell.execute('sh /tmp/a.sh > /tmp/out', () => {});
    expect(await fs.readFile('/tmp/out', 'utf8')).toBe('hi\n');
  });

  it("exec 3>&1 1>&2 keeps fd 3 on the old stdout (debconf's confmodule protocol)", async () => {
    const r = await script('exec 3>&1 1>&2\necho to-fd3 >&3\necho to-stderr\n');
    expect(r.out).toBe('to-fd3\n');
    expect(r.err.replace(/\r\n/g, '\n')).toBe('to-stderr\n');
  });

  it('time times a whole pipeline, subshell or group and reports after it', async () => {
    const r = await script('time (echo a; echo b)\ntime { echo c; }\ntime echo d | tr d D\ntime -p false; echo rc=$?\n');
    expect(r.out).toBe('a\nb\nc\nD\nrc=1\n');
    const err = r.err.replace(/\r\n/g, '\n');
    expect(err.match(/^real\t\dm\d+\.\d{3}s$/gm)).toHaveLength(3);
    expect(err).toMatch(/^real \d+\.\d\d\nuser 0\.00\nsys 0\.00$/m);
    expect(err).not.toMatch(/not found/);
  });

  it("piped stdin reaches every statement of a script, read by read (not just the first)", async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/r.sh', 'exec 3>&1\nread a\nread b\necho "a=$a b=$b"\n');
    let out = '';
    await shell.execute("printf '1\\n2\\n' | sh /tmp/r.sh", (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('a=1 b=2\n');
    out = '';
    await shell.execute("printf '1\\n2\\n' | sh -c 'read a; read b; echo \"a=$a b=$b\"'", (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('a=1 b=2\n');
    out = '';
    await shell.execute("echo x | sh -c 'env | grep -c PIPE_STDIN'", (s) => { out += s; });
    expect(out.trim()).toBe('0'); // the shell's own variable stays internal
  });

  it('strips comments but keeps # inside words, quotes, $#, ${#x} and here-docs', async () => {
    const r = await script([
      'echo hi # comment',
      'for i in 1 2; do # loop',
      '  echo $i # x',
      'done',
      'x=1 # y',
      'echo "a # b" $x $# ${#x} a#b "$(echo "q # r")" $((1 << 2))',
      'cat <<EOF',
      '# not a comment',
      'EOF',
    ].join('\n'));
    expect(r.out).toBe('hi\n1\n2\na # b 1 0 1 a#b q # r 4\n# not a comment\n');
  });

  it('a bare #selector typed at the prompt is still an argument', async () => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute('echo #btn; echo a # comment', (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('#btn\na\n');
  });

  it('runs multi-line functions, case, if/then and loops in scripts', async () => {
    const r = await script([
      'f() {',
      '  echo in f',
      '}',
      'f',
      'case x in',
      '  x) echo X;;',
      '  *) echo other;;',
      'esac',
      'if true',
      'then',
      '  echo then',
      'fi',
      'for x in a b',
      'do',
      '  echo $x done',
      'done',
      'echo "multi',
      'line"',
    ].join('\n'));
    expect(r.err).toBe('');
    expect(r.out).toBe('in f\nX\nthen\na done\nb done\nmulti\nline\n');
  });

  it('exit ends the script with its status and runs the EXIT trap', async () => {
    const r = await script("trap 'echo bye' EXIT\necho a\nexit 3\necho b\n");
    expect(r.out).toBe('a\nbye\n');
    expect(r.status).toBe(3);
  });

  it('exit inside $(...) and ( ) only leaves the subshell', async () => {
    const r = await script('x=$(echo in; exit 4); echo "$x $?"\n(exit 5); echo $?\necho end\n');
    expect(r.out).toBe('in 4\n5\nend\n');
  });

  it('set -e exits on failure, but not in conditions, && lists or after !', async () => {
    const r = await script([
      'set -e',
      'if false; then echo no; fi',
      'false && echo no',
      '! true',
      'while false; do :; done',
      'i=0',
      'echo before',
      '(( i++ ))',
      'echo not reached',
    ].join('\n'));
    expect(r.out).toBe('before\n');
    expect(r.status).toBe(1);
  });

  it('until loop with a comment containing "do" and break terminates', async () => {
    const r = await script('set -o errexit\nuntil false; do\n  echo ok  # do this once then exit loop\n  break\ndone\necho after\n');
    expect(r.out).toBe('ok\nafter\n');
  });

  it("a script's variables, functions and cd don't leak into the caller", async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/s.sh', 'LEAK=1\nf() { :; }\ncd /tmp\n');
    await shell.execute('cd /home/user; sh /tmp/s.sh', () => {});
    let out = '';
    await shell.execute('echo "[$LEAK]" $(pwd); type f >/dev/null 2>&1 || echo nof', (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('[] /home/user\nnof\n');
  });

  it('$(...) runs in a subshell and captures loop output with LF', async () => {
    const r = await script('y=1\nx=$(for i in 1 2; do echo $i; done; y=2)\necho $x $y\necho "$x"\n');
    expect(r.out).toBe('1 2 1\n1\n2\n');
  });

  it('sh -c takes $0 and positional args; sh -ec sets errexit', async () => {
    const { shell } = await createTestShell();
    let out = '';
    const st = await shell.execute(`sh -c 'echo $0 $1 $#' name a b; sh -ec 'false; echo no'; echo $?`, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('name a 2\n1\n');
    expect(st).toBe(0);
  });

  it('keeps empty quoted arguments', async () => {
    const r = await script(`printf '[%s]' '' a "" b''c; echo`);
    expect(r.out).toBe('[][a][][bc]\n');
  });

  it('field-splits unquoted expansions on IFS, including newlines', async () => {
    const r = await script([
      'x="1',
      '2"',
      'printf "<%s>" $x; echo',
      'HOME="foo bar"; printf "<%s>" ~; echo',
      'IFS=:; z="p::q:"; printf "<%s>" $z; echo',
      'IFS=; y="a b"; printf "<%s>" $y; echo',
    ].join('\n'));
    expect(r.out).toBe('<1><2>\n<foo bar>\n<p><><q>\n<a b>\n');
  });

  it('an assignment takes the status of its command substitution', async () => {
    const r = await script('x=$(false); echo $?; y=1; echo $?\n');
    expect(r.out).toBe('1\n0\n');
  });

  it('getopts walks bundled options and option arguments', async () => {
    const r = await script([
      'set -- -abcdef -x rest',
      'while getopts abc: opt; do echo "$opt $OPTIND ${OPTARG-unset}"; done',
      'shift $((OPTIND - 1)); echo "left: $*"',
      'OPTIND=1',
      'while getopts :ab: opt -a -b; do echo "$opt $OPTARG"; done',
    ].join('\n'));
    expect(r.out).toBe('a 1 unset\nb 1 unset\nc 2 def\n? 3 unset\nleft: rest\na \n: b\n');
  });

  it('an alias is not re-expanded inside its own expansion', async () => {
    const r = await script("alias echo='echo foo'\necho bar\n");
    expect(r.out).toBe('foo bar\n');
  });

  it("functions keep $0 and don't see the caller's extra positionals", async () => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute(`sh -c 'f() { echo "$0 $# [$2]"; }; f one' prog a b`, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('prog 1 []\n');
  });

  it('here-docs work after done, in conditions, loops, functions and $(...), with $(cmd) in the body', async () => {
    const r = await script([
      'var=v',
      'cat <<EOF',
      `var: \${var} "q" \\$x $(echo hi) $((1+2))`,
      'EOF',
      'while read line; do echo "X $line"; done <<EOF',
      '1',
      '2',
      'EOF',
      'for i in 1 2; do',
      '  cat <<-E',
      '\ti=$i',
      '\tE',
      'done',
      'if cat <<EOF; then',
      'cond',
      'EOF',
      '  echo THEN',
      'fi',
      "x=$(cat <<'EOF'",
      'raw $var',
      'EOF',
      ')',
      'echo "$x"',
      'f() {',
      '  cat <<EOF',
      'in f $1',
      'EOF',
      '}',
      'f arg',
      'cat <<EOF; echo after',
      'one',
      'EOF',
    ].join('\n'));
    expect(r.err).toBe('');
    expect(r.out).toBe('var: v "q" $x hi 3\nX 1\nX 2\ni=1\ni=2\ncond\nTHEN\nraw $var\nin f arg\none\nafter\n');
  });

  it('"$@" keeps each argument, "$*" joins with IFS', async () => {
    const r = await script([
      'f() { printf "<%s>" "$@" -"$*"-; echo; }',
      'f "a b" "c d"',
      'f',
      'set -- x "y z"',
      'for a in "$@"; do echo "[$a]"; done',
      'for a; do echo "{$a}"; done',
    ].join('\n'));
    expect(r.out).toBe('<a b><c d><-a b c d->\n<-->\n[x]\n[y z]\n{x}\n{y z}\n');
  });

  it('brace expansion keeps quotes; for lists glob and split like arguments', async () => {
    const r = await script([
      'cd /tmp && touch bx1.t bx2.t',
      'printf "<%s>" "q r" x{a,b}y "{c,d}" $(echo {e,f}); echo',
      'for f in bx*.t "q r" {a,b}$((1+1)); do printf "<%s>" "$f"; done; echo',
      'for w in $(printf "a\\nb"); do printf "[%s]" $w; done; echo',
      'for x in; do echo no; done; echo ok',
    ].join('\n'));
    expect(r.out).toBe('<q r><xay><xby><{c,d}><e><f>\n<bx1.t><bx2.t><q r><a2><b2>\n[a][b]\nok\n');
  });

  it('subshells take redirections and stream LF output; \\| and a trailing \\\\ are literal', async () => {
    const r = await script('(echo 1; echo 2) > /tmp/sub.out\n(cat) < /tmp/sub.out\necho \\| \\\\\necho $"foo"\n');
    expect(r.out).toBe('1\n2\n| \\\nfoo\n');
    expect(await r.fs.readFile('/tmp/sub.out', 'utf8')).toBe('1\n2\n');
  });

  it('case: dynamic and quoted patterns, empty word, ;&, nested case', async () => {
    const r = await script([
      'for x in a b; do case $x in $x) echo loop;; *) echo star;; esac; done',
      "case $empty in ''|foo) echo match;; *) echo no;; esac",
      'x="*.py"; case "$x" in "*.py") echo lit;; esac',
      'x=b.py; pat="[ab].py"; case "$x" in $pat) echo glob;; esac',
      'x="[ab].py"; case "$x" in "$pat") echo quoted;; esac',
      's="foo()"; case $s in *\\(\\)) echo paren; esac',
      'case abc in a*) echo one;& b*) echo two;; c*) echo three;; esac',
      'case a in a) case b in b) echo nested;; esac;; esac',
    ].join('\n'));
    expect(r.out).toBe('loop\nloop\nmatch\nlit\nglob\nquoted\nparen\none\ntwo\nnested\n');
  });

  it('numbered fds: exec N>file, >&N, exec N<file + read <&N, exec N>&1, &>, noclobber, exec >log', async () => {
    const r = await script([
      'cd /tmp',
      'exec 3> fd3.txt; echo hello >&3; echo world 1>&3; exec 3>&-; cat fd3.txt',
      'echo foo51 > in.txt; exec 6< in.txt; read line <&6; echo "[$line]"',
      'exec 4>&1; echo four >&4; x=$(echo sub); echo $x',
      'echo both &> both.txt; cat both.txt',
      'set -o noclobber; echo YY > fd3.txt; echo st=$?; echo ZZ >| fd3.txt; cat fd3.txt; set +o noclobber',
      'exec 5>&1; exec >> log.txt; echo to-log; exec >&5; echo back; cat log.txt',
    ].join('\n'));
    expect(r.out).toBe('hello\nworld\n[foo51]\nfour\nsub\nboth\nst=1\nZZ\nback\nto-log\n');
  });

  it('globs match directories, keep quoted parts literal, honour set -f and nullglob', async () => {
    const r = await script([
      'cd /tmp && mkdir -p g/d1 g/d2 "g/s p" && touch g/a.txt g/b.txt g/.h g/d1/x.c "g/s p/z.txt" && cd g',
      'echo *.txt; echo */; echo d*/*.c; dir=d1; echo "$dir"/*; echo "s p"/*; echo \\*.txt; echo "*.txt"',
      'for d in */; do printf "[%s]" "$d"; done; echo',
      'set -f; echo *.txt; set +f; shopt -s nullglob; echo x *.none y; shopt -u nullglob; echo [ab].txt [!a].txt',
    ].join('\n'));
    expect(r.out).toBe('a.txt b.txt\nd1/ d2/ s p/\nd1/x.c\nd1/x.c\ns p/z.txt\n*.txt\n*.txt\n[d1/][d2/][s p/]\n*.txt\nx y\na.txt b.txt b.txt\n');
  });

  it('arrays keep quoted elements, are sparse, slice, and scope with local', async () => {
    const r = await script([
      "a=(1 '2 3' \"$HOME\"x)",
      'printf "[%s]" "${a[@]}"; echo " ${#a[@]} ${a[1]} ${a[-1]}"',
      'a[5]=five; unset "a[0]"; echo "${!a[@]} | ${#a[@]} | ${a[@]:2}"',
      'b=(x y); b+=(z); b[1]+=Y; s=str; s+=ing; echo "${b[*]} $s $b"',
      'f() { local b=(in side); echo "${b[@]}"; }; f; echo "${b[@]}"',
      'declare -A m=([k]=v ["two words"]=w); m[x]=1; echo "${m[k]} ${m[two words]} ${#m[@]}"',
      'n=(1 2 3); echo "${n[@]/2/X}" "${n[@]#1}"; e=(); printf "<%s>" "${e[@]}"; echo',
      'declare -p n',
    ].join('\n'));
    expect(r.out).toBe(
      '[1][2 3][/home/userx] 3 2 3 /home/userx\n' +
      '1 2 5 | 3 | /home/userx five\n' +
      'x yY z string x\n' +
      'in side\nx yY z\n' +
      'v w 3\n' +
      '1 X 3  2 3\n<>\n' +
      'declare -a n=([0]="1" [1]="2" [2]="3")\n');
  });

  it('arithmetic: precedence, assignment ops, bases, short-circuit, recursion, errors', async () => {
    const r = await script([
      'x=5; echo $(( -2**2 )) $(( 2**3**2 )) $(( x+=2, x*3 )) $x $(( 0x10 + 010 + 2#101 + 64#_ ))',
      'y=0; echo $(( 1 || y++ )) $y $(( 0 && y++ )) $y $(( y ? 10 : 20 ))',
      'e="1+2"; echo $(( e * 2 )) $(( (e) * 2 ))',
      'a=(10 20 30); i=1; echo $(( a[i] + a[i+1] )); (( a[0]++ )); echo ${a[0]}',
      'echo $((1',
      '+ 2))',
      '(( 1/0 )); echo st=$?',
      'let "z = 3 << 2" "w = z % 5"; echo $z $w',
    ].join('\n'));
    expect(r.out).toBe('4 512 21 7 92\n1 0 0 0 20\n6 6\n50\n11\n3\nst=1\n12 2\n');
  });

  it('${x/pat/rep} anchors, quoting and &; ${x#pat} with expanded patterns', async () => {
    const r = await script([
      'x=foo.bar.baz; p=ba; echo ${x/#foo/F} ${x/%baz/Z} ${x//./-} ${x/"."*/} ${x//$p/&&}',
      'echo ${x#*.} ${x##*.} ${x%.*} ${x%%.*} ${x#"$p"} ${x%[[:alpha:]]}',
    ].join('\n'));
    expect(r.out).toBe('F.bar.baz foo.bar.Z foo-bar-baz foo foo.babar.babaz\nbar.baz baz foo.bar foo foo.bar.baz foo.bar.ba\n');
  });

  it('read: backslashes, IFS splitting, -n/-N/-d/-a/-u, piped subshells', async () => {
    const r = await script([
      "echo '  a b  ' | (read; echo \"[$REPLY]\")",
      "printf 'A\\t\\tB C D E \\nFG\\n' | { read x y z; echo \"[$x/$y/$z]\"; }",
      "IFS=: read a b <<< \"x:y:\"; echo \"[$a][$b]\"",
      "printf 'one\\\\\\ntwo three\\n' | { read -r p q; read -a arr <<< \" 1  2 3 \"; echo \"[$p][$q] ${#arr[@]}\"; }",
      "printf 'abcdef' | { read -n 3 c; read -N 2 d; echo \"$c $d\"; read e; echo \"e=$e st=$?\"; }",
      "printf 'v1\\0v2\\0' | { read -r -d '' v; echo \"$v\"; }",
      "read -u 3 r 3<<< \"from3\"; echo \"$r\"",
    ].join('\n'));
    expect(r.out).toBe('[  a b  ]\n[A/B/C D E]\n[x][y]\n[one\\][] 3\nabc de\ne=f st=1\nv1\nfrom3\n');
  });

  it('[[ ]]: operators inside, patterns, =~ with BASH_REMATCH, arithmetic, -v, multi-line', async () => {
    const r = await script([
      "[[ ''||! (1 == 2)&&(2 == 2)]] && echo compound",
      "x='a b'; [[ $x == a* && $x != \"a*\" ]] && echo pat",
      "[[ foo123 =~ ^([a-z]+)([0-9]+)$ ]] && echo \"${BASH_REMATCH[1]}-${BASH_REMATCH[2]}\"",
      "re='a.c'; [[ abc =~ $re ]] && echo re1; [[ abc =~ \"$re\" ]] || echo re2",
      "[[ 017 -eq 15 && 2 -lt 10 && b > a ]] && echo arith",
      "[[ -v x && ! -v nope ]] && echo setvar",
      "[[ foo == foo",
      "&& bar == bar",
      "]] && echo multiline",
    ].join('\n'));
    expect(r.out).toBe('compound\npat\nfoo-123\nre1\nre2\narith\nsetvar\nmultiline\n');
  });

  it('backtick escapes, ${x:off:len} with arithmetic, ${@:off}, test -v, f-name(), ${!prefix@}', async () => {
    const r = await script([
      "X=/a/b; echo `echo \\$X | tr / _` \"`echo \\\"q\\\"`\" `echo a\\\\\\\\b`",
      "s=abcdef; i=1; echo ${s:i+1:2} ${s: -2} ${s:1:-2} ${s:(-3):1}",
      "set -- 4 5 6; echo \"${@:2}\" \"${*:1:2}\" \"${@: -1}\"",
      "x=\"it's\"; echo ${x/t/T} \"${x#i}\"",
      "a=(1 2); test -v 'a[1]' && echo set1; test -v 'a[5]' || echo unset5",
      "my-func() { echo hyphen \"$1\"; }; my-func ok",
      "v1=1 v2=2; echo ${!v@}",
    ].join('\n'));
    expect(r.out).toBe("_a_b q a\\b\ncd ef bcd d\n5 6 4 5 6\niT's t's\nset1\nunset5\nhyphen ok\nv1 v2\n");
  });

  it('trap listing/reset/ignore, background jobs in a child shell with $! and wait', async () => {
    const r = await script([
      "trap 'echo e' EXIT; trap \"it's\" TERM; trap '' USR1; trap; trap - TERM 0; trap -p",
      "trap foo; echo st=$?; trap 'x' 2 bogus; echo st=$?; trap 2",
      "x=1; { x=2; echo \"in $x\"; } & wait $!; echo \"st=$? x=$x\"",
      "for n in 1 2 3; do (exit $n) & done; wait; echo all",
      "f() { return 7; }; f & pid=$!; wait $pid; echo \"w=$?\"",
    ].join('\n'));
    expect(r.out).toBe("trap -- 'echo e' EXIT\ntrap -- '' SIGUSR1\ntrap -- 'it'\\''s' SIGTERM\ntrap -- '' SIGUSR1\nst=2\nst=1\nin 2\nst=0 x=1\nall\nw=7\n");
  });

  it('pipeline elements are subshells (exit, variables), PIPESTATUS, pipefail, $-, quoted alias', async () => {
    const r = await script([
      "{ echo a; exit 3; } | { cat; exit 4; } | { cat; }; echo \"st=$? ps=${PIPESTATUS[*]}\"",
      "set -o pipefail; { exit 9; } | { exit 2; } | { :; }; echo \"pf=$?\"; set +o pipefail",
      "x=1; echo | { x=2; }; echo \"x=$x\"",
      "set -eu; case $- in *e*u*) echo flags ;; esac; set +eu",
      "shopt -s expand_aliases; alias hi='echo hello'",
      "hi",
      "'hi' 2>/dev/null || echo quoted-not-alias",
    ].join('\n'));
    expect(r.out).toBe('a\nst=0 ps=3 4 0\npf=2\nx=1\nflags\nhello\nquoted-not-alias\n');
  });

  it('cd -L/-P/-/--/CDPATH with symlinks, pwd ignores $PWD assignment, shopt -p/-q/-o, source ARGS', async () => {
    const r = await script([
      "cd /tmp && rm -rf cdt && mkdir -p cdt/real/sub && cd cdt && ln -s real link",
      "cd link/sub && pwd && pwd -P && cd .. && pwd && cd - && echo \"old=$OLDPWD\"",
      "PWD=foo; pwd; cd BAD/.. 2>/dev/null; echo st=$?",
      "CDPATH=/tmp/cdt cd real && cd -- /tmp && pwd",
      "shopt -s nullglob; shopt -p nullglob; shopt -q extglob || echo noext; shopt -po errexit; shopt -u nullglob",
      "printf 'echo \"args: $*\"\\n' > /tmp/s.sh; set -- outer; source /tmp/s.sh a b; echo \"after: $*\"; eval -- 'echo ev'",
    ].join('\n'));
    expect(r.out).toBe('/tmp/cdt/link/sub\n/tmp/cdt/real/sub\n/tmp/cdt/link\n/tmp/cdt/link/sub\nold=/tmp/cdt/link\n/tmp/cdt/link/sub\nst=1\n' +
      '/tmp/cdt/real\n/tmp\nshopt -s nullglob\nnoext\nset +o errexit\nargs: a b\nafter: outer\nev\n');
  });

  it('loop statuses and set -e, break in a condition, $_, relative PATH entries, OSTYPE', async () => {
    const r = await script([
      "set -e; for x in 1 2; do test $x = 1 && echo \"one\"; done || echo \"loop-st=$?\"",
      "{ test no = yes && echo hi; }; echo \"group-st=$?\"; set +e",
      "while break; do echo x; done; echo after-break",
      "i=0; until [ $i -ge 2 ]; do i=$((i+1)); done; echo \"until=$i\"",
      "echo hi world; echo \"$_\"; : 'foo'\"bar\"; echo $_",
      "cd /tmp && rm -rf pp && mkdir -p pp/bin && printf 'echo mycmd-ran\\n' > pp/bin/mycmd && chmod +x pp/bin/mycmd && PATH=\"pp/bin:$PATH\" mycmd",
      "case $OSTYPE in linux*) echo has-ostype;; esac",
    ].join('\n'));
    expect(r.out).toBe('one\nloop-st=1\ngroup-st=1\nafter-break\nuntil=2\nhi world\nworld\nfoobar\nmycmd-ran\nhas-ostype\n');
  });

  it('function body on the next line; a \x01 byte survives command substitution', async () => {
    const r = await script([
      'testcase()',
      '{',
      '  echo "in $1"',
      '}',
      'testcase x',
      'v=$(printf "\\001\\002A"); printf %s "$v" | od -An -tx1',
      'e=()',
      'echo "empty=${#e[@]}"',
    ].join('\n'));
    expect(r.out).toBe('in x\n 01 02 41\nempty=0\n');
  });

  it('brace expansion: leading }, {x} literal, char ranges with steps, step sign ignored', async () => {
    const r = await script('echo }_{a,b} {x}_{a,b} -{a..e..2}- -{e..a..-2}- {a..a..2}- {1..8..-3} {5..1..2}');
    expect(r.out).toBe('}_a }_b {x}_a {x}_b -a- -c- -e- -e- -c- -a- a- 1 4 7 5 3 1\n');
  });

  it('${!ref-word} indirection with operators and array refs, ${@-word}, exec {fd}>file', async () => {
    const r = await script([
      "r=a; a=5; echo \"${!r-none} ${!r:+set}\"; arr=(x y); r2=\"arr[1]\"; echo \"${!r2}\"; unset nope; r3=nope; echo \"${!r3-dflt}\"",
      "set --; echo \"[${@-empty}] [${*:+plus}]\"; set -- a; echo \"[${@:+plus}]\"",
      "cd /tmp && exec {myfd}>nf.txt && echo hi >&$myfd && exec {myfd}>&- && cat nf.txt",
    ].join('\n'));
    expect(r.out).toBe('5 set\ny\ndflt\n[empty] []\n[plus]\nhi\n');
  });

  it('quoted < > are words, redirect-only commands create files, redirections apply in order, builtins in pipelines are subshells', async () => {
    const r = await script([
      "cd /tmp && rm -rf rz && mkdir rz && cd rz",
      "echo a \\< b '<' \">\"",
      "> made.txt; >> app.txt; ls",
      "ls /nonexist 2>&1 >/dev/null | wc -l",
      "{ echo out; echo err >&2; } > both.txt 2>&1; cat both.txt",
      "mkdir -p sub; echo | cd sub; echo | x=5; echo \"${PWD##*/} x=${x-unset}\"",
    ].join('\n'));
    expect(r.out).toBe('a < b < >\napp.txt\nmade.txt\n1\nout\nerr\nrz x=unset\n');
  });

  it('type and command -v/-V classify keywords, aliases, functions, builtins and files', async () => {
    const r = await script([
      'type while cd; type -t while cd f; f(){ :; }; type -t f; command -v cd; command -V cd',
      'alias ll="ls -l"; type ll; type -t ll; type nosuch 2>/dev/null; echo st=$?',
    ].join('\n'));
    expect(r.out).toBe("while is a shell keyword\ncd is a shell builtin\nkeyword\nbuiltin\nfunction\ncd\ncd is a shell builtin\nll is aliased to `ls -l'\nalias\nst=1\n");
  });

  it('function bodies that are any compound command (subshell, loop, with a here-doc); ~ after : in assignments', async () => {
    const r = await script([
      "f() ( echo sub; exit 3 )",
      "f; echo st=$?",
      "fun() { cat; } <<EOF",
      "heredoc body",
      "EOF",
      "fun",
      "g() for i in 1 2; do echo $i; done",
      "g",
      "function h { echo h; }",
      "h",
      "k() { echo \"a;b\"; }; k",
      "HOME=/home/bar",
      "x=foo:~; echo $x",
      "y=~:~/a; echo $y",
      "echo a:~",
      "P=/bin:~/bin:~; echo $P",
    ].join('\n'));
    expect(r.out).toBe('sub\nst=3\nheredoc body\n1\n2\nh\na;b\nfoo:/home/bar\n/home/bar:/home/bar/a\na:~\n/bin:/home/bar/bin:/home/bar\n');
  });

  it('process substitution: <(cmd) in a subshell, < <(cmd) into a loop, > >(cmd)', async () => {
    const r = await script([
      'x=1; cat <(echo 1; x=2; echo $x); echo "x=$x"',
      'while read l; do echo "got $l"; done < <(printf "a\\nb\\n")',
      'diff <(echo x) <(echo y) >/dev/null; echo st=$?',
      'echo hi > >(tr a-z A-Z)',
    ].join('\n'));
    expect(r.out).toBe('1\n2\nx=1\ngot a\ngot b\nst=1\nHI\n');
  });

  it('alias ending in a blank expands the next word; alias/unalias --; printf -v a[i]', async () => {
    const r = await script([
      "shopt -s expand_aliases",
      "alias hi=\"echo hello world \"",
      "alias punct=\"!!!\"",
      "hi punct",
      "alias e=\"echo \"",
      "alias x=\"X\"",
      "e x y",
      "alias -- q=quux; alias q; unalias -- q; alias q 2>/dev/null || echo gone",
      "alias s=\"echo it's\"; alias s",
      "a=(x y z); printf -v \"a[1]\" \"%s-\" B; echo \"${a[@]}\"",
      "printf -v \"bad name\" x; echo st=$?",
    ].join('\n'));
    expect(r.out).toBe("hello world !!!\nX y\nalias q='quux'\ngone\nalias s='echo it'\\''s'\nx B- z\nst=2\n");
  });

  it('set a b c sets the positional parameters; unquoted ${v:-word} splits its word on IFS', async () => {
    const r = await script([
      'set a b c; echo "n=$# $2"; set -e x y; echo "n=$# $1"; set +e',
      'IFS=; echo ["$*"]; IFS=x; v=; echo ${v:-AxBxC} "${v:-AxBxC}"x; unset IFS',
    ].join('\n'));
    expect(r.out).toBe('n=3 b\nn=2 x\n[xy]\nA B C AxBxCx\n');
  });

  it('case … esac inside $( … )', async () => {
    const r = await script([
      'x=$(case 5 in [0-9]) echo number;; [a-z]) echo letter ;; esac)',
      'echo "$x" $(case b in a) echo A;; b) echo B;; esac)',
    ].join('\n'));
    expect(r.out).toBe('number B\n');
  });

  it('return status mod 256, |&, ! ( … ), command NAME skips functions', async () => {
    const r = await script([
      "f() { return 257; }; f; echo r=$?",
      "(exit 258); echo e=$?",
      "f2() { return -1; }; f2; echo n=$?",
      "ls /nonexist |& wc -l",
      "! ( false ); echo neg=$?",
      "builtin echo bi",
      "command echo co",
      "echo() { printf \"fn\\n\"; }; command echo co2; builtin echo bi2; unset -f echo",
      "for i in 1 2; do command break; done; echo after",
    ].join('\n'));
    expect(r.out).toBe('r=1\ne=2\nn=255\n1\nneg=0\nbi\nco\nco2\nbi2\nafter\n');
  });

  it('break/continue outside a loop, return outside a function, test -a/-o', async () => {
    const r = await script([
      'continue; echo one; break; echo two',
      'for i in a b; do ( if true; then continue; fi; echo "sub $i" ); done',
      'g() { break; }; f() { for x in 1 2; do g; echo x$x; done; }; f',
      'while true; do while true; do break 2; done; done; echo after',
      'return; echo rc=$?',
      'h() ( return 42; ); h; echo h=$?',
      'test -a /tmp; echo $?; test -a /nonexist; echo $?',
      'set -o errexit; test -o errexit; echo $?; set +o errexit; test -o nounset; echo $?',
    ].join('\n'));
    expect(r.out).toBe('one\ntwo\nsub a\nsub b\nx1\nx2\nafter\nrc=2\nh=42\n0\n1\n0\n1\n');
  });

  it('${!a[i]}, list-valued defaults, array words as env prefixes, a[i]=(…) errors', async () => {
    const r = await script([
      'foo=bar; a=("1 2" foo); echo "${!a[1]}"',
      'd=("1 2" 3); for w in "${u[@]:-${d[@]}}"; do echo "[$w]"; done',
      'set -- x "y z"; for w in "${u:-"$@"}"; do echo "<$w>"; done',
      'B=(b b) sh -c \'echo "$B"\'',
      'a[0]=(3 4); echo st=$?',
      'IFS=; p_1=1; p_2=2; echo ${!p_*}; unset IFS',
    ].join('\n'));
    expect(r.out).toBe('bar\n[1 2]\n[3]\n<x>\n<y z>\n(b b)\nst=1\np_1p_2\n');
  });

  it('bad substitution / arithmetic errors abandon the line, ${x?} ends the script; in ( … ) only the subshell', async () => {
    const r = await script([
      '(echo ${a[0][0]}); echo s1=$?',
      '(echo ${!undef}); echo s2=$?',
      '(echo ${x?boom}); echo s3=$?',
      'echo ${#a[0]/1/x}; echo notreached',
      'echo next=$?; echo $((1+)); echo notreached',
      'echo next2=$?',
      ': ${x?boom}; echo notreached',
      'echo notreached',
    ].join('\n'));
    expect(r.out).toBe('s1=1\ns2=1\ns3=1\nnext=1\nnext2=1\n');
    expect(r.status).toBe(1);
  });

  it('inside "…" the word of ${x-word} is double-quoted: " groups, \' is literal, \\} escapes', async () => {
    const r = await script([
      'v="a b"; for w in "${U:-"x y"}" "${U:-"$v" c}"; do echo "[$w]"; done',
      'echo "${U:-\'$v\'}" "${U-\\}}" "${U-\'}\'}"',
      'f="\'a b d\'"; echo ${f%d\\\'} "${f%d\\\'}"',
      'echo "${U=$v x}" "$U"',
    ].join('\n'));
    expect(r.out).toBe("[x y]\n[a b c]\n'a b' } '}'\n'a b 'a b \na b x a b x\n");
  });

  it('backticks hold ; and |, keep an escaped trailing blank; $(<<EOF cmd) is a here-doc', async () => {
    const r = await script([
      'echo `echo -n l; echo -n s` `echo ab | tr a x`',
      'echo "[`echo \\ `]" [\\ ]',
      'echo $(<<EOF tac',
      'one',
      'two',
      'EOF',
      ')',
      'echo hi > "f g"; echo "$(< "f g")" $(<f\\ g)',
    ].join('\n'), async (fs) => { await fs.mkdir('/tmp/w', { recursive: true }); });
    expect(r.out).toBe('ls xb\n[ ] [ ]\ntwo one\nhi hi\n');
  });

  it('assignments: no globbing, NAME+=value in declaration builtins and env prefixes', async () => {
    const r = await script([
      'cd /tmp; mkdir -p gl; cd gl; touch foo=a foo=b',
      'foo=*; echo "$foo"; export bar=*; echo "$bar"; typeset baz=*; echo "$baz"',
      'typeset s+=foo; typeset s+=bar; echo $s; export e+=x; readonly r+=y; echo $e $r',
      'f() { local l+=1; local l+=2; echo $l; }; f',
      'a=(x y); typeset a+=s; echo "${a[@]}"',
      'declare d+=(d e); declare d+=(c); echo "${d[@]}"; readonly ro+=(r o); echo "${ro[@]}"',
      'A=a; A+=b sh -c \'echo $A\'; FOO=foo\\<foo sh -c \'echo $FOO\'',
    ].join('\n'));
    expect(r.out).toBe('*\n*\n*\nfoobar\nx y\n12\nxs y\nd e c\nr o\nab\nfoo<foo\n');
  });

  it('>& word, >&file (stdout and stderr), N>&M- moves a descriptor', async () => {
    const r = await script([
      'cd /tmp; exec {fd}> n.txt; echo a >&$fd; echo b >& $fd; cat n.txt',
      'ls /nonexist >&both.txt; grep -c nonexist both.txt',
      'exec 5> f5.txt; echo hello5 >&5; exec 6>&5-; echo world5 >&5; echo world6 >&6; exec 6>&-; cat f5.txt',
    ].join('\n'));
    expect(r.out).toBe('a\nb\n1\nhello5\nworld6\n');
  });

  it('sh -c/-i/-O and $-, vi/emacs, set -n; exit in an EXIT trap; trap -1; unset scopes', async () => {
    const r = await script([
      "sh -o nounset -c 'echo $-'; sh -i -c 'echo $-' | grep -c i",
      "sh -O nullglob -c 'echo foo *.none bar'",
      'set -o vi; shopt -o -p emacs vi; set -o emacs; shopt -o -p vi',
      "sh -c 'trap \"exit 42\" EXIT'; echo trap=$?",
      "sh -e -c 'trap -1 EXIT; echo bad'; echo st=$?",
      'f() { echo f; }; unset f; type f >/dev/null 2>&1 || echo nof',
      'unlocal() { unset "$@"; }; l2() { local h=yy; unlocal h; echo l2=$h; }; l1() { local h=xx; l2; unlocal h; echo l1=$h; }; h=g; l1',
      'echo 1; set -n; echo 2',
    ].join('\n'));
    expect(r.out).toBe('huBc\n1\nfoo bar\nset +o emacs\nset -o vi\nset +o vi\ntrap=42\nst=2\nnof\nl2=xx\nl1=g\n1\n');
  });

  it('$((…)) ends at its matching )), and may hold $(…) and `…`; 02#1 is no number', async () => {
    const r = await script([
      'a=1; b=2; echo $((a,(b+1))) $((!(1 || 2))) $((~(1|2)))',
      'echo $((1 + $(echo 1)${u:-3})) $((`echo 1` + 2))',
      'echo $((02#0110)); echo notreached',
      'echo st=$?',
    ].join('\n'));
    expect(r.out).toBe('3 0 -4\n14 3\nst=1\n');
  });

  it('function names and bodies: } as an argument, foo!bar(), name ( ) before a newline', async () => {
    const r = await script([
      'rbrace() { echo }; }; rbrace',
      'foo!bar() { echo bang; }; foo!bar',
      'fun ( )',
      '{ echo in-func; }',
      'fun',
      'echo {a,b} { x }',
    ].join('\n'));
    expect(r.out).toBe('}\nbang\nin-func\na b { x }\n');
  });

  it('/bin/NAME runs Shiro NAME; (( )) and redirects; set -e in conditions; printf errors', async () => {
    const r = await script([
      "sh -c 'set -e; false || /bin/false; echo bad'; echo s1=$?",
      '/usr/bin/printf "%s\\n" hi',
      '(( 2 + 2 )) > /tmp/ar.txt; echo s2=$?; (( 0 )) > /tmp/ar.txt; echo s3=$?',
      "sh -c 'set -e; (( 42 )) > /; echo bad'; echo s4=$?",
      'set -e; if ( false; echo still ); then echo cond; fi; if { false; true; } then echo brace; fi; set +e',
      'printf; echo p1=$?; printf "a%yb"; echo p2=$?',
    ].join('\n'));
    expect(r.out).toBe('s1=1\nhi\ns2=0\ns3=1\ns4=1\nstill\ncond\nbrace\np1=2\nap2=1\n');
  });

  it('set -u ends just a redirected subshell or a $(…); NAME=value with only redirects persists', async () => {
    const r = await script([
      'set -u',
      '(echo ${nope}) 2>/dev/null; echo s1=$?',
      'x=$(echo ${nope}) 2>/dev/null; echo s2=$?',
      'set +u',
      // an assignment with only redirects stays set (unexported) and has its $(…)'s status
      'y=$(echo hi) >/dev/null; z=$(exit 3) 2>/dev/null; echo "s3=$? $y"; sh -c \'echo ${y-unexported}\'',
    ].join('\n'));
    expect(r.out).toBe('s1=1\ns2=1\ns3=3 hi\nunexported\n');
  });

  it('a wasm program run through a symlink gets the link\'s name as argv[0] (multi-call binaries)', async () => {
    const { readFileSync } = await import('node:fs');
    const wasm = new Uint8Array(readFileSync(new URL('./fixtures/wasi/argv0.wasm', import.meta.url)));
    const r = await script('ln -s /tmp/a0/prog.wasm /tmp/a0/echo2; /tmp/a0/echo2; /tmp/a0/prog.wasm\n', async (fs) => {
      await fs.mkdir('/tmp/a0', { recursive: true });
      await fs.writeFile('/tmp/a0/prog.wasm', wasm, { mode: 0o755 });
    });
    expect(r.out).toBe('argv0=echo2\nargv0=prog.wasm\n');
  });

  it('tabcomputer#8: /proc/PID and /proc/self for in-page commands (fd/, environ, cwd, exe, stat, status)', async () => {
    const r = await script([
      'ls /proc | grep -qx "$$" && echo listed',
      'ls /proc/self | tr "\\n" " "; echo',
      'ls /proc/self/fd | tr "\\n" " "; echo',
      '[ "$(readlink /proc/self)" = "$$" ] && echo self-is-me',
      'cd /tmp; readlink /proc/self/cwd; readlink /proc/$$/exe',
      'X_PROC_TEST=1; export X_PROC_TEST; tr "\\0" "\\n" < /proc/self/environ | grep -c "^X_PROC_TEST=1$"',
      'cut -d" " -f1,3 /proc/$$/stat | sed "s/^$$/PID/"',
      'grep -c "^Pid:" /proc/self/status',
      'ls -ld /proc/self/cwd | cut -c1',
    ].join('\n'));
    expect(r.out).toBe('listed\ncmdline comm cwd environ exe fd io limits mounts root stat statm status syscall task wchan \n0 1 2 \nself-is-me\n/tmp\n/usr/bin/sh\n1\nPID R\n1\nl\n');
  });

  it('tabcomputer#8: uname, free, df and ps agree with /proc and each other', async () => {
    const r = await script([
      'uname -a',
      'uname -srm; uname --kernel-release --machine; uname -p; uname -o',
      '[ "$(uname -r)" = "$(cut -d" " -f3 /proc/version)" ] && echo release-matches',
      '[ "$(free -k | awk \'/^Mem:/ {print $2}\')" = "$(awk \'/^MemTotal:/ {print $2}\' /proc/meminfo)" ] && echo free-matches',
      'df -k / | awk \'NR == 2 { print $1, $6, ($3 + $4 == $2) }\'',
      'uname -x 2>&1; echo $?',
    ].join('\n'));
    expect(r.out).toBe('Linux tabcomputer 6.1.0-tabcomputer #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n' +
      'Linux 6.1.0-tabcomputer x86_64\n6.1.0-tabcomputer x86_64\nunknown\nGNU/Linux\n' +
      'release-matches\nfree-matches\nrootfs / 1\n' +
      "uname: invalid option -- 'x'\nTry 'uname --help' for more information.\n1\n");
  });

  it('tabcomputer#8: ps hides exited processes and escapes newlines in command lines', async () => {
    const kept = processTable.allocate('gone');
    processTable.markExited(kept.pid, 0);
    const live = processTable.allocate('two\nlines');
    try {
      const r = await script('ps');
      expect(r.out).not.toMatch(/\bgone\b/);
      expect(r.out).toContain('two\\nlines\n');
    } finally {
      processTable.remove(kept.pid);
      processTable.remove(live.pid);
    }
  });
});
