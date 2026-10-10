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
declare -pr | grep -E 'ro|arr'
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
