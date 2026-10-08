/**
 * Regressions found by the oils spec conformance run (tests/conformance):
 * comments, multi-line statements in scripts, exit, set -e, script and
 * command-substitution isolation.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

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
});
