/**
 * Bash features real scripts use, from the oils spec files added to the
 * conformance run (tests/conformance/oils/FILES: var-op-bash, introspect,
 * assign-extended, nameref, builtin-trap-bash…). Each case is checked
 * against bash 5.2's output.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function bash(text: string) {
  const { fs, shell } = await createTestShell();
  await fs.writeFile('/tmp/t.sh', text);
  let out = '';
  let err = '';
  const status = await shell.execute('bash /tmp/t.sh', (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), status };
}

describe('${x@op} transformations', () => {
  it('@Q quotes for reuse: $\'…\' for control characters; unset is nothing', async () => {
    const r = await bash(`x="it's"; nl=$'a\\nb'; e=''
echo \${x@Q} \${nl@Q} \${e@Q} [\${undef@Q}]
a=(x 'y z'); echo \${a@Q} \${a[1]@Q} "\${a[@]@Q}"
set -- p 'q r'; echo \${@@Q}
`);
    expect(r.out).toBe(`'it'\\''s' $'a\\nb' '' []\n'x' 'y z' 'x' 'y z'\n'p' 'q r'\n`);
  });

  it('@a lists attributes; @A is an assignment; @E decodes escapes; @U @u @L', async () => {
    const r = await bash(`a=(1 2); declare -A m=([k]=v); export ex=1; s=hi
echo "[\${a@a}] [\${a[0]@a}] [\${m@a}] [\${ex@a}] [\${s@a}] [\${?@a}]"
echo \${s@A}
t='a\\tb'; printf '%s\\n' "\${t@E}"
echo \${s@U} \${s@u} \${s@L}
`);
    expect(r.out).toBe('[a] [a] [A] [x] [] []\ns=\'hi\'\na\tb\nHI Hi hi\n');
  });

  it('@P expands prompt escapes', async () => {
    const r = await bash(`p='\\u:\\$ \\101'; echo "\${p@P}"\n`);
    expect(r.out).toBe('user:$ A\n');
  });
});

describe('call stack: FUNCNAME, BASH_SOURCE, BASH_LINENO, caller', () => {
  it('a script file is BASH_SOURCE[0]; functions and source push frames, "main" at the bottom', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/tmp/d', { recursive: true });
    await fs.writeFile('/tmp/d/lib.sh', 'echo "lib: F=[${FUNCNAME[*]}] S=[${BASH_SOURCE[*]}]"\nlibf() { echo "libf: F=[${FUNCNAME[*]}] S=[${BASH_SOURCE[*]}] L=[${BASH_LINENO[*]}]"; caller 0; }\n');
    await fs.writeFile('/tmp/d/main.sh', [
      'echo "top: F=[${FUNCNAME[*]}] S=[${BASH_SOURCE[*]}] L=[${BASH_LINENO[*]}] set=${FUNCNAME+y}"',
      'f() { echo "f: F=[${FUNCNAME[*]}] #=${#FUNCNAME}"; . ./lib.sh; libf; }',
      'g() { f; }',
      'g',
      'cd "$(dirname "${BASH_SOURCE[0]}")" && pwd',
      '',
    ].join('\n'));
    let out = '';
    await shell.execute('cd /tmp/d && bash main.sh', (s) => { out += s; }, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe([
      'top: F=[] S=[main.sh] L=[0] set=',
      'f: F=[f g main] #=1',
      'lib: F=[source f g main] S=[./lib.sh main.sh main.sh main.sh]',
      'libf: F=[libf f g main] S=[./lib.sh main.sh main.sh main.sh] L=[2 3 4 0]',
      '2 f main.sh',
      '/tmp/d',
      '',
    ].join('\n'));
  });
});

describe('traps and errors', () => {
  it("the ERR trap doesn't fire inside itself, in conditions, or for &&/|| left sides and !", async () => {
    const r = await bash(`trap 'echo err $?; false' ERR
false
if false; then :; fi
false || true
! false
true && false
echo end $?
`);
    expect(r.out).toBe('err 1\nerr 1\nend 1\n');
  });

  it('DEBUG runs before each command, keeps $?, not in functions without set -T; ERR in functions needs set -E', async () => {
    let r = await bash(`f() { echo in-f; }
trap 'echo "dbg $?"' DEBUG
false; echo a && echo b || echo c
f
trap - DEBUG
`);
    expect(r.out).toBe('dbg 0\ndbg 1\na\ndbg 0\nb\ndbg 0\nin-f\ndbg 0\n');
    r = await bash(`trap 'echo err' ERR
g() { false; true; }
g
set -E
g
(false)
echo "sub $BASH_SUBSHELL $(echo $BASH_SUBSHELL)"
`);
    // (set -E: inside the subshell, then for it in the parent)
    expect(r.out).toBe('err\nerr\nerr\nsub 0 1\n');
  });

  it('set -u: an unbound variable ends a script with status 1 (127 under -c)', async () => {
    expect((await bash('set -u\necho ${#undef}\necho no\n')).status).toBe(1);
    const { shell } = await createTestShell();
    expect(await shell.execute(`bash -c 'set -u; echo $undef'`, () => {}, () => {})).toBe(127);
  });
});

describe('declare and attributes', () => {
  it('-i evaluates assignments (+= adds), -l/-u fold case, -p prints attributes', async () => {
    const r = await bash(`declare -i n=2+3; n+=4; echo $n
declare -u up=abc; up+=def; echo $up
declare -l lo=ABC; echo $lo
readonly ro=1; export ex=2; declare x
declare -p n up ro ex x
declare -ar arr=(a b); arr+=(c); echo "\${arr[@]} $?"
declare -pr | grep -E ' (ro|arr)='
`);
    expect(r.out).toBe([
      '9', 'ABCDEF', 'abc',
      'declare -i n="9"', 'declare -u up="ABCDEF"', 'declare -r ro="1"', 'declare -x ex="2"', 'declare -- x',
      'a b 1',
      'declare -ar arr=([0]="a" [1]="b")', 'declare -r ro="1"', '',
    ].join('\n'));
  });

  it('declare in a function is local unless -g; +x unexports; readonly and getopts vars are not exported', async () => {
    const r = await bash(`f() { declare L=1; declare -g G=2; local -i I=3+4; echo "in $L $I"; }
f; echo "out [$L] $G [$I]"
export E=1; typeset +x E
readonly RO=1; getopts a: opt -a v
bash -c 'echo "child [$E] [$RO] [$opt] [$OPTARG]"'
set -a; A=1; set +a; B=2
bash -c 'echo "allexport [$A] [$B]"'
`);
    expect(r.out).toBe('in 1 7\nout [] 2 []\nchild [] [] [] []\nallexport [1] []\n');
  });

  it('a function overrides a builtin of the same name; builtin/command reach the builtin', async () => {
    const r = await bash(`cd() { echo "cd wrapper $1"; builtin cd "$@"; }
cd /tmp; pwd
echo() { command echo "[$*]"; }
echo hi
`);
    expect(r.out).toBe('cd wrapper /tmp\n/tmp\n[hi]\n');
  });
});

describe('namerefs', () => {
  it('chains, array elements, unset through the ref, ${!ref}, +n', async () => {
    const r = await bash(`x=foo; declare -n r1=x; declare -n r2=r1; echo $r2
a=(zero one two); declare -n e='a[2]'; echo $e; e=TWO; echo \${a[2]}
echo \${!r1}
show() { local -n arr=$1; echo "\${arr[1]} \${#arr[@]}"; }
g() { local list=(p q r); show list; }; g
unset r1; echo "[$x]"
declare -n c1=c2; declare -n c2=c1; c1=z; echo "circular $?"
y=val; declare -n p=y; declare +n p; echo $p
`);
    expect(r.out).toBe('foo\ntwo\nTWO\nx\nq 3\n[]\ncircular 1\ny\n');
  });
});

describe('builtins scripts lean on', () => {
  it('mapfile keeps the delimiter unless -t; -d, -O, -s, -n, -C; < FILE and pipes', async () => {
    const r = await bash(`printf 'a\\nb\\n' > /tmp/m.txt
mapfile x < /tmp/m.txt; printf '[%s]' "\${x[@]}"; echo
mapfile -t y < /tmp/m.txt; printf '[%s]' "\${y[@]}"; echo
printf '1:2:3:' | { mapfile -t -d : z; echo "\${#z[@]} \${z[2]}"; }
printf '%s\\0' p q | { mapfile -d '' n; printf '[%s]' "\${n[@]}"; echo; }
w=(k l m); printf 'u\\nv\\n' | { mapfile -t -O 1 w; echo "\${w[*]}"; }
seq 10 | { mapfile -t -s 2 -n 3 s; echo "\${s[*]}"; }
cb() { echo "cb $1 $2"; }; printf '1\\n2\\n3\\n4\\n' | { readarray -t -C cb -c 2 c; echo "\${c[*]}"; }
`);
    expect(r.out).toBe('[a\n][b\n]\n[a][b]\n3 3\n[p][q]\nk u v\n3 4 5\ncb 1 2\ncb 3 4\n1 2 3 4\n');
  });

  it('brace ranges pad only for a leading zero, sign included', async () => {
    const r = await bash('echo a{0..3} {08..10} {-05..-3} {3..-1}\n');
    expect(r.out).toBe('a0 a1 a2 a3 08 09 10 -05 -04 -03 3 2 1 0 -1\n');
  });

  it('PIPESTATUS for builtins and subshells; >(cmd) after a group or exec; a group\'s 2> file', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/t.sh', `exit 55 | (exit 44); echo "ps \${PIPESTATUS[@]}"
(exit 3); echo "ps \${PIPESTATUS[@]}"
{ echo 1; echo 2; } > >(tac)
{ echo out; echo err >&2; } 2>/tmp/e.txt; echo "e=$(cat /tmp/e.txt)"
exec > >(tee /tmp/log.txt) 2>&1
echo logged; echo oops >&2
`);
    let out = '';
    await shell.execute('bash /tmp/t.sh', (x) => { out += x; }, (x) => { out += x; });
    expect(out.replace(/\r\n/g, '\n')).toBe('ps 55 44\nps 3\n2\n1\nout\ne=err\nlogged\noops\n');
    expect(await fs.readFile('/tmp/log.txt', 'utf8')).toBe('logged\noops\n');
  });

  it('SHELLOPTS and BASHOPTS follow set -o and shopt; they are readonly', async () => {
    const r = await bash(`echo "$SHELLOPTS"; set -o pipefail; echo "$SHELLOPTS"; shopt -s extglob
case :$BASHOPTS: in *:extglob:*) echo extglob;; esac
SHELLOPTS=x; echo "rc=$?"
`);
    expect(r.out).toBe('braceexpand:hashall:interactive-comments\nbraceexpand:hashall:interactive-comments:pipefail\nextglob\nrc=1\n');
  });

  it('umask: octal and symbolic modes, -S and -p, and new files get 0666 less it', async () => {
    const r = await bash(`umask; umask -S; umask 027; umask -p
umask g+w,o=r; umask; umask 089; echo "rc=$?"; umask u+r+w; echo "rc=$?"
umask 0002; echo x > /tmp/u1; umask 077; echo y > /tmp/u2
ls -l /tmp/u1 /tmp/u2 | cut -c1-10
`);
    expect(r.out).toBe('0022\nu=rwx,g=rx,o=rx\numask 0027\n0003\nrc=1\nrc=1\n-rw-rw-r--\n-rw-------\n');
  });

  it('pushd / popd / dirs: ~ for $HOME, -v -p -l -c, +N rotation, usage errors', async () => {
    const r = await bash(`mkdir -p /tmp/h/a /tmp/h/b; HOME=/tmp/h; cd /
pushd /tmp/h/a; pushd /tmp/h/b >/dev/null; dirs -v; dirs -l -p
pushd +2 >/dev/null; pwd
popd >/dev/null; dirs
popd zz; echo "rc=$?"; dirs -c; dirs
`);
    expect(r.out).toBe('~/a /\n 0  ~/b\n 1  ~/a\n 2  /\n/tmp/h/b\n/tmp/h/a\n/\n/\n~/b ~/a\nrc=2\n~/b\n');
  });
});

/** What GNU hello's autoconf ./configure (and its config.status) needed */
describe('autoconf configure idioms', () => {
  it('word splitting, case in if bodies, multi-line backticks and quotes, case in subshells and pipelines', async () => {
    const r = await bash(`IFS=' 	
'
x=' a  b '; set -- $x; echo "$#:$1:$2"
nl='
'
y="\${nl}p\${nl}"; set -- x$y; echo "$#"
if true; then
  case a in
  a) echo A ;;
  *) echo other ;;
  esac
fi
v=\`echo one
echo two\`
echo "$v"
c=": 'a
b'"; if eval "$c"; then echo evalok; fi
( case x in *y*) echo nl ;; *) echo other ;; esac; )
( echo q | case x in *) cat ;; esac | sort )
`);
    expect(r.err).toBe('');
    expect(r.out).toBe('2:a:b\n2\nA\none\ntwo\nevalok\nother\nq\n');
  });

  it('an EXIT trap with #( comments; { } >&N, >&2, > /dev/stdout; exec 7<&0', async () => {
    const r = await bash(`trap 'st=$?
  # a comment
  for v in a; do
    case $v in #(
    *z*) echo z ;; #(
    *) echo "trap v=$v st=$st" ;;
    esac
  done
' 0
exec 5>&1
{ echo to5; } >&5
{ echo to2; } >&2
if true; then echo fi-out; fi > /dev/stdout
exec 7<&0 </dev/null
exit 4
`);
    expect(r.out).toBe('to5\nfi-out\ntrap v=a st=4\n');
    expect(r.err).toBe('to2\n');
    expect(r.status).toBe(4);
  });

  it('sh SCRIPT keeps option-like arguments; source does not run the EXIT trap; xtrace ignores 2>&1', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/s.sh', 'echo "args: $*"\n');
    await fs.writeFile('/tmp/lib.sh', 'trap "echo exit-trap" EXIT\necho in-lib\n');
    await fs.writeFile('/tmp/t.sh', 'sh /tmp/s.sh -x -- a\n. /tmp/lib.sh\necho after-source\nset -x\nv=$(echo hi 2>&1)\nset +x\necho "v=$v"\n');
    let out = '';
    let err = '';
    await shell.execute('bash /tmp/t.sh', (s) => { out += s; }, (s) => { err += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('args: -x -- a\nin-lib\nafter-source\nv=hi\nexit-trap\n');
    expect(err.replace(/\r\n/g, '\n')).toContain('+ v=hi\n');
  });
});
