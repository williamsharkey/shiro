/**
 * The built-in jq as jq 1.7 (src/commands/jq.ts): the language — bindings,
 * reduce/foreach, def, paths and assignment, try/label, formats, dates,
 * regexes — and the command line. The expected outputs are real jq's.
 *
 * Nothing it doesn't know gives an empty result with exit 0
 * (williamsharkey/tabcomputer#20): an unknown function or a syntax error is a
 * compile error (exit 3), a runtime error exits 5.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { evaluateJq } from '@shiro/commands/jq';

let shell: Shell;
let fs: FileSystem;
beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.writeFile('/tmp/two.json', '{"a":1}\n{"a":2}\n');
});

async function sh(cmd: string) {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  return { out: lf(out), err: lf(err), code };
}
/** `jq -c PROGRAM` on null input (-n), as one string */
const jqn = (prog: string) => evaluateJq(null, prog, false, true);

describe('tabcomputer#20: what gave empty or null output with exit 0', () => {
  it('jq --version', async () => {
    expect(await sh('jq --version')).toEqual({ out: 'jq-1.7.1\n', err: '', code: 0 });
  });

  it('. as $a', async () => {
    expect((await sh(`echo '[5,7]' | jq '. as $a | 1'`)).out).toBe('1\n');
    expect((await sh(`echo '[5,7]' | jq '. as $a | $a[1]'`)).out).toBe('7\n');
    expect((await sh(`echo '{"k":[1,2]}' | jq -c '.k as $v | $v'`)).out).toBe('[1,2]\n');
  });

  it('--arg, --argjson, $ARGS', async () => {
    expect((await sh(`echo 1 | jq --arg x 3 '$x'`)).out).toBe('"3"\n');
    expect((await sh(`jq -n --argjson x '{"a":1}' '$x.a'`)).out).toBe('1\n');
    expect((await sh(`jq -cn --args '$ARGS' a b`)).out).toBe('{"positional":["a","b"],"named":{}}\n');
    expect((await sh(`jq -cn --jsonargs '$ARGS.positional' 1 '{}'`)).out).toBe('[1,{}]\n');
    expect((await sh(`jq -cn --arg a 1 --arg b 2 '$ARGS.named'`)).out).toBe('{"a":"1","b":"2"}\n');
  });

  it('combined short flags: -rs, -sr, -nr, -cs', async () => {
    expect((await sh(`printf '{"a":1}\\n{"a":2}\\n' | jq -rs length`)).out).toBe('2\n');
    expect((await sh(`printf '{"a":1}\\n{"a":2}\\n' | jq -sr length`)).out).toBe('2\n');
    expect((await sh(`jq -nr '"x"'`)).out).toBe('x\n');
    expect((await sh(`printf '1 2' | jq -cs .`)).out).toBe('[1,2]\n');
  });

  it('reduce, floor, fromdate', async () => {
    expect((await sh(`echo '[5,7]' | jq 'reduce .[] as $i (0; .+$i)'`)).out).toBe('12\n');
    expect((await sh(`echo 2.7 | jq floor`)).out).toBe('2\n');
    expect((await sh(`echo '"2026-10-10T14:38:23Z"' | jq fromdate`)).out).toBe('1791643103\n');
  });

  it('an unknown function, a misspelled variable, a syntax error: compile errors, exit 3', async () => {
    expect(await sh(`jq -n 'foo(1)'`)).toEqual({
      out: '', code: 3, err: 'jq: error: foo/1 is not defined at <top-level>, line 1:\nfoo(1)\njq: 1 compile error\n',
    });
    const v = await sh(`jq -n '$nope'`);
    expect([v.code, v.err.split('\n')[0]]).toEqual([3, 'jq: error: $nope is not defined at <top-level>, line 1:']);
    const s = await sh(`jq -n '1 +'`);
    expect([s.code, s.err.split('\n')[0]]).toEqual([3, 'jq: error: syntax error, unexpected end of file (Unix shell quoting issues?) at <top-level>, line 1:']);
    // (an unknown function in a branch not taken too, as jq)
    expect((await sh(`jq -n 'if true then 1 else nosuch end'`)).code).toBe(3);
    expect((await sh(`jq -n 'import "a" as a; 1'`)).code).toBe(3);
  });

  it('a runtime error: jq: error (at FILE:LINE), the next input still runs, exit 5', async () => {
    expect(await sh(`printf '{"a":1}\\n"x"\\n{"a":3}\\n' | jq .a`)).toEqual({
      out: '1\n3\n', code: 5, err: 'jq: error (at <stdin>:2): Cannot index string with string "a"\n',
    });
    expect((await sh(`jq '.a.b' /tmp/two.json`)).err).toBe(
      'jq: error (at /tmp/two.json:1): Cannot index number with string "b"\njq: error (at /tmp/two.json:2): Cannot index number with string "b"\n');
    expect(await sh(`jq -n '{a:1} | error'`)).toEqual({ out: '', code: 5, err: 'jq: error (at <unknown>) (not a string): {"a":1}\n' });
  });

  it('an unknown option: exit 2', async () => {
    const r = await sh('jq --foo .');
    expect([r.code, r.err.split('\n')[0]]).toEqual([2, 'jq: Unknown option --foo']);
  });
});

describe('the command line', () => {
  it('input, inputs, input_filename, -n', async () => {
    expect((await sh(`jq -cn input /tmp/two.json`)).out).toBe('{"a":1}\n');
    expect((await sh(`jq -cn '[inputs.a]' /tmp/two.json`)).out).toBe('[1,2]\n');
    expect((await sh(`jq -c '[., input]' /tmp/two.json`)).out).toBe('[{"a":1},{"a":2}]\n');
    expect((await sh(`jq input_filename /tmp/two.json`)).out).toBe('"/tmp/two.json"\n"/tmp/two.json"\n');
    expect((await sh(`echo '[3]' | jq -cn '[inputs]'`)).out).toBe('[[3]]\n');
    expect((await sh(`jq -n 'input'`)).code).toBe(5);
  });

  it('-R, -Rs, -j, -a, -S, --tab, --indent, --seq, --raw-output0', async () => {
    expect((await sh(`jq -R . /tmp/two.json`)).out).toBe('"{\\"a\\":1}"\n"{\\"a\\":2}"\n');
    expect((await sh(`jq -Rs . /tmp/two.json`)).out).toBe('"{\\"a\\":1}\\n{\\"a\\":2}\\n"\n');
    expect((await sh(`printf 'a\\nb\\n' | jq -nR '[inputs]' -c`)).out).toBe('["a","b"]\n');
    expect((await sh(`jq -j .a /tmp/two.json`)).out).toBe('12');
    expect((await sh(`jq -an '"é"'`)).out).toBe('"\\u00e9"\n');
    expect((await sh(`jq -cSn '{b:1,a:{d:1,c:2}}'`)).out).toBe('{"a":{"c":2,"d":1},"b":1}\n');
    expect((await sh(`jq --tab -n '{a:1}'`)).out).toBe('{\n\t"a": 1\n}\n');
    expect((await sh(`jq --indent 1 -n '{a:[1]}'`)).out).toBe('{\n "a": [\n  1\n ]\n}\n');
    expect((await sh(`jq --seq -n 1`)).out).toBe('\x1e1\n');
    expect((await sh(`jq --raw-output0 -n '"a","b"'`)).out).toBe('a\0b\0');
  });

  it('--stream, --slurpfile, --rawfile, -f', async () => {
    expect((await sh(`jq -c --stream . /tmp/two.json`)).out).toBe('[["a"],1]\n[["a"]]\n[["a"],2]\n[["a"]]\n');
    expect((await sh(`jq -cn --slurpfile f /tmp/two.json '$f'`)).out).toBe('[{"a":1},{"a":2}]\n');
    expect((await sh(`jq -n --rawfile f /tmp/two.json '$f'`)).out).toBe('"{\\"a\\":1}\\n{\\"a\\":2}\\n"\n');
    await fs.writeFile('/tmp/prog.jq', '# a comment\n.a * 10\n');
    expect((await sh(`jq -f /tmp/prog.jq /tmp/two.json`)).out).toBe('10\n20\n');
  });

  it('-e: 1 when the last output is false or null, 4 when there is none', async () => {
    expect((await sh(`jq -e '.a == 2' /tmp/two.json`)).code).toBe(0);
    expect((await sh(`jq -e '.a == 3' /tmp/two.json`)).code).toBe(1);
    expect((await sh(`jq -e 'empty' /tmp/two.json`)).code).toBe(4);
  });

  it('halt, halt_error, $ENV, env', async () => {
    expect(await sh(`jq -n '"bye\\n" | halt_error(1)'`)).toEqual({ out: '', err: 'bye\n', code: 1 });
    expect(await sh(`jq -n '{a:1} | halt_error'`)).toEqual({ out: '', err: '{"a":1}\n', code: 5 });
    expect(await sh(`jq -n '1, halt, 2'`)).toEqual({ out: '1\n', err: '', code: 0 });
    expect((await sh(`FOO=bar jq -rn '$ENV.FOO, env.FOO'`)).out).toBe('bar\nbar\n');
  });

  it('a file that is not there: exit 2', async () => {
    const r = await sh(`jq . /nonexistent`);
    expect([r.code, r.err]).toEqual([2, 'jq: error: Could not open file /nonexistent: No such file or directory\n']);
  });

  it('input that is not JSON: exit 2', async () => {
    const r = await sh(`echo '{"a":' | jq .`);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^jq: error \(at <stdin>:\d+\): Cannot parse/);
  });
});

describe('the language', () => {
  it('bindings and destructuring, ?//', () => {
    expect(jqn('[1,[2,3]] | . as [$a, [$b, $c]] | [$a,$b,$c]')).toBe('[1,2,3]\n');
    expect(jqn('{a:1,b:{c:2}} | . as {a:$x, b:{c:$y}} | [$x,$y]')).toBe('[1,2]\n');
    expect(jqn('{a:1} | . as {$a} | $a')).toBe('1\n');
    expect(jqn('{"k":"a","a":5} | . as {k:$k} | .[$k]')).toBe('5\n');
    expect(jqn('[[1,2],{a:3}] | .[] as [$a] ?// {a:$a} | $a')).toBe('1\n3\n');
    expect(jqn('[1,2,3] | .[] as $x | select($x > 1) | $x * 10')).toBe('20\n30\n');
  });

  it('reduce, foreach, limit, first, until, while, repeat, recurse', () => {
    expect(jqn('reduce range(5) as $x (0; . + $x)')).toBe('10\n');
    expect(jqn('[foreach (1,2,3) as $x (0; . + $x; [$x, .])]')).toBe('[[1,1],[2,3],[3,6]]\n');
    expect(jqn('[limit(3; range(100000000))]')).toBe('[0,1,2]\n');
    expect(jqn('[range(10)] | first(.[] | select(. > 5))')).toBe('6\n');
    expect(jqn('1 | until(. > 100; . * 2)')).toBe('128\n');
    expect(jqn('[1 | while(. < 100; . * 2)]')).toBe('[1,2,4,8,16,32,64]\n');
    expect(jqn('[limit(5; 1 | repeat(. * 2))]')).toBe('[1,2,4,8,16]\n');
    expect(jqn('2 | [recurse(if . < 20 then . * . else empty end; . < 20)]')).toBe('[2,4,16]\n');
    expect(jqn('[[1,[2]] | .. | numbers]')).toBe('[1,2]\n');
    // deep: no JS frame per step
    expect(jqn('[limit(100000; repeat(1))] | length')).toBe('100000\n');
    expect(jqn('0 | until(. >= 100000; . + 1)')).toBe('100000\n');
  });

  it('def: filter and $value parameters, recursion, closures', () => {
    expect(jqn('def f: . * 2; [1,2] | map(f)')).toBe('[2,4]\n');
    expect(jqn('def f($a; $b): $a + $b; f(1; 2)')).toBe('3\n');
    expect(jqn('def fac: if . <= 1 then 1 else . * (. - 1 | fac) end; 10 | fac')).toBe('3628800\n');
    expect(jqn('def addvalue(f): f as $x | map(. + $x); [[1,2],[10,20]] | addvalue(.[0])')).toBe('[[1,2,1,2],[10,20,1,2]]\n');
    expect(jqn('def f: 1; def g: f + 1; def f: 10; g, f')).toBe('2\n10\n');
  });

  it('paths and assignment', () => {
    expect(jqn('{a:[1,2,3]} | (.a[] | select(. >= 2)) |= . * 10')).toBe('{"a":[1,20,30]}\n');
    expect(jqn('[1,[2,[3]]] | (.. | numbers) |= . + 1')).toBe('[2,[3,[4]]]\n');
    expect(jqn('{} | .a.b.c = 1')).toBe('{"a":{"b":{"c":1}}}\n');
    expect(jqn('{a:1} | .b //= 5 | .a += 1')).toBe('{"a":2,"b":5}\n');
    expect(jqn('[1,2,3] | (.[] | select(. == 2)) |= empty')).toBe('[1,3]\n');
    expect(jqn('{a:[1,2,3]} | del(.a[] | select(. == 2))')).toBe('{"a":[1,3]}\n');
    expect(jqn('[1,2,3] | .[1:] |= map(. * 2)')).toBe('[1,4,6]\n');
    expect(jqn('[1,2,3] | [path(.[] | select(. > 1))]')).toBe('[[1],[2]]\n');
    expect(jqn('{a:{b:1}} | [paths]')).toBe('[["a"],["a","b"]]\n');
    expect(jqn('{a:{b:1,c:2}} | pick(.a.b)')).toBe('{"a":{"b":1}}\n');
  });

  it('a value where a path must be: an error', () => {
    expect(() => jqn('{a:1} | path(.a + 1)')).toThrow('Invalid path expression with result 2');
  });

  it('try, catch, ?, label, break, error values', () => {
    expect(jqn('try error({a:1}) catch .a')).toBe('1\n');
    expect(jqn('[(1,2,error("x"),3)?]')).toBe('[1,2]\n');
    expect(jqn('[label $f | range(10) | ., (select(. == 2) | break $f)]')).toBe('[0,1,2]\n');
    expect(jqn('try (try error("x") catch error("y")) catch .')).toBe('"y"\n');
    expect(() => jqn('error("custom")')).toThrow('custom');
  });

  it('strings: interpolation, @formats', () => {
    expect(jqn('"\\(1,2)-\\(3,4)"')).toBe('"1-3"\n"2-3"\n"1-4"\n"2-4"\n');
    expect(jqn('@base64 "x\\("hi")y"')).toBe('"xaGk=y"\n');
    expect(jqn('[1,"a,b",null,true] | @csv')).toBe('"1,\\"a,b\\",,true"\n');
    expect(jqn('[1,"a\\tb"] | @tsv')).toBe('"1\\ta\\\\tb"\n');
    expect(jqn('@sh "cp \\(["a b","c"]) dest"')).toBe('"cp \'a b\' \'c\' dest"\n');
    expect(jqn('"a b/c?" | @uri')).toBe('"a%20b%2Fc%3F"\n');
    expect(jqn('"<&>" | @html')).toBe('"&lt;&amp;&gt;"\n');
    expect(jqn('"hello" | @base64 | ., @base64d')).toBe('"aGVsbG8="\n"hello"\n');
  });

  it('regexes: test, match, capture, scan, sub, gsub, splits', () => {
    expect(jqn('"abc" | test("B"; "i")')).toBe('true\n');
    expect(jqn('"foo bar foo" | [match("foo"; "g") | .offset]')).toBe('[0,8]\n');
    expect(jqn('"xyzzy-14" | capture("(?<a>[a-z]+)-(?<n>[0-9]+)")')).toBe('{"a":"xyzzy","n":"14"}\n');
    expect(jqn('"test 123 abc 456" | [scan("[0-9]+")]')).toBe('["123","456"]\n');
    expect(jqn('"abc" | sub("(?<l>.)"; "\\(.l|ascii_upcase)"; "g")')).toBe('"ABC"\n');
    expect(jqn('"a1b2" | [splits("[0-9]")]')).toBe('["a","b",""]\n');
    expect(jqn('"test" | [match("";"g")] | length')).toBe('5\n');
    expect(jqn('"aé😀b" | [match(".";"g").offset]')).toBe('[0,1,2,3]\n');
  });

  it('dates', () => {
    expect(jqn('1425599507 | todate')).toBe('"2015-03-05T23:51:47Z"\n');
    expect(jqn('1425599507 | gmtime')).toBe('[2015,2,5,23,51,47,4,63]\n');
    expect(jqn('"2015-03-05T23:51:47Z" | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime')).toBe('1425599507\n');
    expect(jqn('1425599507 | strftime("%A, %B %d, %Y %j %H:%M:%S %Z")')).toBe('"Thursday, March 05, 2015 064 23:51:47 UTC"\n');
    expect(jqn('"10:15 2015-03-05" | strptime("%H:%M %Y-%m-%d")')).toBe('[2015,2,5,10,15,0,4,63]\n');
  });

  it('sorting and comparing in jq\'s order', () => {
    expect(jqn('[null,true,false,1,"a",[],{}] | sort')).toBe('[null,false,true,1,"a",[],{}]\n');
    expect(jqn('[{a:1,b:2},{a:1,b:1}] | sort_by(.a, .b)')).toBe('[{"a":1,"b":1},{"a":1,"b":2}]\n');
    expect(jqn('[1,2,3] | group_by(. % 2)')).toBe('[[2],[1,3]]\n');
    expect(jqn('[(1,2) + (10,20)]')).toBe('[11,12,21,22]\n');
  });

  it('streams', () => {
    expect(jqn('[{"a":[1,{"b":2}]} | tostream] | fromstream(.[])')).toBe('{"a":[1,{"b":2}]}\n');
    expect(jqn('[1|truncate_stream([[0],1],[[1,0],2],[[1,0]],[[1]])]')).toBe('[[[0],2],[[0]]]\n');
  });
});

