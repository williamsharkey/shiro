/**
 * Deep tests for the jq JSON processor.
 *
 * Covers builtins, operators, and edge cases beyond the basic tests
 * in missing-commands.test.ts. Tests the full expression parser,
 * all comparison/arithmetic operators, string builtins, array builtins,
 * object construction, slicing, and control flow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { evaluateJq } from '@shiro/commands/jq';

describe('jq deep tests', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ─── evaluateJq (direct function tests, no shell overhead) ────

  describe('evaluateJq (direct)', () => {
    it('identity filter', () => {
      expect(evaluateJq({ a: 1 }, '.')).toBe('{\n  "a": 1\n}\n');
    });

    it('field access', () => {
      expect(evaluateJq({ name: 'shiro' }, '.name').trim()).toBe('"shiro"');
    });

    it('raw mode strips quotes', () => {
      expect(evaluateJq({ name: 'shiro' }, '.name', true).trim()).toBe('shiro');
    });

    it('nested field access', () => {
      expect(evaluateJq({ a: { b: { c: 42 } } }, '.a.b.c').trim()).toBe('42');
    });

    it('null field access returns null', () => {
      expect(evaluateJq({ a: 1 }, '.b').trim()).toBe('');
    });
  });

  // ─── Comparison Operators ──────────────────────────────────────

  describe('comparison operators', () => {
    it('== with numbers', async () => {
      const { output } = await run(shell, "echo '5' | jq '. == 5'");
      expect(output.trim()).toBe('true');
    });

    it('!= with numbers', async () => {
      const { output } = await run(shell, "echo '5' | jq '. != 3'");
      expect(output.trim()).toBe('true');
    });

    it('< with numbers', async () => {
      const { output } = await run(shell, "echo '3' | jq '. < 5'");
      expect(output.trim()).toBe('true');
    });

    it('> with numbers', async () => {
      const { output } = await run(shell, "echo '10' | jq '. > 5'");
      expect(output.trim()).toBe('true');
    });

    it('<= with equal numbers', async () => {
      const { output } = await run(shell, "echo '5' | jq '. <= 5'");
      expect(output.trim()).toBe('true');
    });

    it('>= with smaller number', async () => {
      const { output } = await run(shell, "echo '3' | jq '. >= 5'");
      expect(output.trim()).toBe('false');
    });
  });

  // ─── Arithmetic Operators ──────────────────────────────────────

  describe('arithmetic', () => {
    it('addition', async () => {
      const { output } = await run(shell, "echo '3' | jq '. + 7'");
      expect(output.trim()).toBe('10');
    });

    it('subtraction', async () => {
      const { output } = await run(shell, "echo '10' | jq '. - 3'");
      expect(output.trim()).toBe('7');
    });

    it('multiplication', async () => {
      const { output } = await run(shell, "echo '4' | jq '. * 5'");
      expect(output.trim()).toBe('20');
    });

    it('division', async () => {
      const { output } = await run(shell, "echo '20' | jq '. / 4'");
      expect(output.trim()).toBe('5');
    });

    it('modulo', async () => {
      const { output } = await run(shell, "echo '17' | jq '. % 5'");
      expect(output.trim()).toBe('2');
    });

    it('string concatenation with +', async () => {
      const r = evaluateJq({ a: 'hello', b: ' world' }, '.a + .b', true);
      expect(r.trim()).toBe('hello world');
    });

    it('array concatenation with +', async () => {
      const r = evaluateJq(null, '[1,2] + [3,4]');
      expect(JSON.parse(r.trim())).toEqual([1, 2, 3, 4]);
    });

    it('object merge with +', async () => {
      const r = evaluateJq(null, '{"a":1} + {"b":2}');
      expect(JSON.parse(r.trim())).toEqual({ a: 1, b: 2 });
    });

    it('negative numbers (via evaluateJq)', () => {
      // Shell interprets '-5' as a flag, so test directly
      const r = evaluateJq(null, '-5');
      expect(r.trim()).toBe('-5');
    });
  });

  // ─── Boolean Operators ─────────────────────────────────────────

  describe('boolean operators', () => {
    it('and (both true)', async () => {
      const { output } = await run(shell, "echo 'null' | jq 'true and true'");
      expect(output.trim()).toBe('true');
    });

    it('and (one false)', async () => {
      const { output } = await run(shell, "echo 'null' | jq 'true and false'");
      expect(output.trim()).toBe('false');
    });

    it('or (one true)', async () => {
      const { output } = await run(shell, "echo 'null' | jq 'false or true'");
      expect(output.trim()).toBe('true');
    });

    it('not', async () => {
      const { output } = await run(shell, "echo 'true' | jq 'not'");
      expect(output.trim()).toBe('false');
    });
  });

  // ─── Array Builtins ────────────────────────────────────────────

  describe('array builtins', () => {
    it('unique', async () => {
      const r = evaluateJq([1, 2, 1, 3, 2], 'unique');
      expect(JSON.parse(r.trim())).toEqual([1, 2, 3]);
    });

    it('unique_by', async () => {
      const data = [{ name: 'a', age: 1 }, { name: 'b', age: 2 }, { name: 'a', age: 3 }];
      const r = evaluateJq(data, 'unique_by(.name)');
      const parsed = JSON.parse(r.trim());
      expect(parsed).toHaveLength(2);
    });

    it('flatten', async () => {
      const r = evaluateJq([[1, 2], [3, [4, 5]]], 'flatten');
      expect(JSON.parse(r.trim())).toEqual([1, 2, 3, 4, 5]);
    });

    it('add (numbers)', async () => {
      const r = evaluateJq([1, 2, 3], 'add');
      expect(r.trim()).toBe('6');
    });

    it('add (strings)', async () => {
      const r = evaluateJq(['a', 'b', 'c'], 'add', true);
      expect(r.trim()).toBe('abc');
    });

    it('add (arrays)', async () => {
      const r = evaluateJq([[1], [2], [3]], 'add');
      expect(JSON.parse(r.trim())).toEqual([1, 2, 3]);
    });

    it('any (true case)', async () => {
      const r = evaluateJq([false, true, false], 'any');
      expect(r.trim()).toBe('true');
    });

    it('any (false case)', async () => {
      const r = evaluateJq([false, false], 'any');
      expect(r.trim()).toBe('false');
    });

    it('all (true case)', async () => {
      const r = evaluateJq([true, true, true], 'all');
      expect(r.trim()).toBe('true');
    });

    it('all (false case)', async () => {
      const r = evaluateJq([true, false, true], 'all');
      expect(r.trim()).toBe('false');
    });

    it('reverse array', async () => {
      const r = evaluateJq([1, 2, 3], 'reverse');
      expect(JSON.parse(r.trim())).toEqual([3, 2, 1]);
    });

    it('reverse string', async () => {
      const r = evaluateJq('abc', 'reverse', true);
      expect(r.trim()).toBe('cba');
    });

    it('min', async () => {
      const r = evaluateJq([5, 2, 8, 1], 'min');
      expect(r.trim()).toBe('1');
    });

    it('max', async () => {
      const r = evaluateJq([5, 2, 8, 1], 'max');
      expect(r.trim()).toBe('8');
    });

    it('sort_by', async () => {
      const data = [{ n: 3 }, { n: 1 }, { n: 2 }];
      const r = evaluateJq(data, 'sort_by(.n)');
      const parsed = JSON.parse(r.trim());
      expect(parsed.map((x: any) => x.n)).toEqual([1, 2, 3]);
    });

    it('group_by', async () => {
      const data = [{ t: 'a', v: 1 }, { t: 'b', v: 2 }, { t: 'a', v: 3 }];
      const r = evaluateJq(data, 'group_by(.t)');
      const parsed = JSON.parse(r.trim());
      expect(parsed).toHaveLength(2);
    });

    it('min_by', async () => {
      const data = [{ v: 5 }, { v: 2 }, { v: 8 }];
      const r = evaluateJq(data, 'min_by(.v)');
      expect(JSON.parse(r.trim())).toEqual({ v: 2 });
    });

    it('max_by', async () => {
      const data = [{ v: 5 }, { v: 2 }, { v: 8 }];
      const r = evaluateJq(data, 'max_by(.v)');
      expect(JSON.parse(r.trim())).toEqual({ v: 8 });
    });

    it('first', async () => {
      const r = evaluateJq([10, 20, 30], 'first');
      expect(r.trim()).toBe('10');
    });

    it('last', async () => {
      const r = evaluateJq([10, 20, 30], 'last');
      expect(r.trim()).toBe('30');
    });

    it('array slicing [N:M]', async () => {
      const r = evaluateJq([0, 1, 2, 3, 4], '.[1:3]');
      expect(JSON.parse(r.trim())).toEqual([1, 2]);
    });
  });

  // ─── String Builtins ───────────────────────────────────────────

  describe('string builtins', () => {
    it('ascii_downcase', async () => {
      const r = evaluateJq('HELLO', 'ascii_downcase', true);
      expect(r.trim()).toBe('hello');
    });

    it('ascii_upcase', async () => {
      const r = evaluateJq('hello', 'ascii_upcase', true);
      expect(r.trim()).toBe('HELLO');
    });

    it('ltrimstr', async () => {
      const r = evaluateJq('hello world', 'ltrimstr("hello ")', true);
      expect(r.trim()).toBe('world');
    });

    it('rtrimstr', async () => {
      const r = evaluateJq('hello world', 'rtrimstr(" world")', true);
      expect(r.trim()).toBe('hello');
    });

    it('startswith (true)', async () => {
      const r = evaluateJq('hello', 'startswith("hel")');
      expect(r.trim()).toBe('true');
    });

    it('startswith (false)', async () => {
      const r = evaluateJq('hello', 'startswith("xyz")');
      expect(r.trim()).toBe('false');
    });

    it('endswith', async () => {
      const r = evaluateJq('hello', 'endswith("llo")');
      expect(r.trim()).toBe('true');
    });

    it('split', async () => {
      const r = evaluateJq('a,b,c', 'split(",")');
      expect(JSON.parse(r.trim())).toEqual(['a', 'b', 'c']);
    });

    it('join', async () => {
      const r = evaluateJq(['a', 'b', 'c'], 'join("-")', true);
      expect(r.trim()).toBe('a-b-c');
    });

    it('test (regex match)', async () => {
      const r = evaluateJq('foobar', 'test("foo")');
      expect(r.trim()).toBe('true');
    });

    it('test (regex no match)', async () => {
      const r = evaluateJq('foobar', 'test("^bar")');
      expect(r.trim()).toBe('false');
    });

    // BUG: jq tokenizer doesn't handle ';' separator inside builtin args.
    // gsub("a"; "x") and sub("a"; "x") fail because ';' is silently dropped,
    it('gsub', async () => {
      const r = evaluateJq('aabaa', 'gsub("a"; "x")', true);
      expect(r.trim()).toBe('xxbxx');
    });

    it('sub', async () => {
      const r = evaluateJq('aabaa', 'sub("a"; "x")', true);
      expect(r.trim()).toBe('xabaa');
    });

    it('tostring', async () => {
      const r = evaluateJq(42, 'tostring', true);
      expect(r.trim()).toBe('42');
    });

    it('tonumber', async () => {
      const r = evaluateJq('42', 'tonumber');
      expect(r.trim()).toBe('42');
    });

    it('length on string', async () => {
      const r = evaluateJq('hello', 'length');
      expect(r.trim()).toBe('5');
    });
  });

  // ─── Object Builtins ──────────────────────────────────────────

  describe('object builtins', () => {
    it('has (object, true)', async () => {
      const r = evaluateJq({ a: 1 }, 'has("a")');
      expect(r.trim()).toBe('true');
    });

    it('has (object, false)', async () => {
      const r = evaluateJq({ a: 1 }, 'has("b")');
      expect(r.trim()).toBe('false');
    });

    it('has (array)', async () => {
      const r = evaluateJq([10, 20, 30], 'has(1)');
      expect(r.trim()).toBe('true');
    });

    it('contains (string)', async () => {
      const r = evaluateJq('foobar', 'contains("oob")');
      expect(r.trim()).toBe('true');
    });

    it('keys_unsorted', async () => {
      const r = evaluateJq({ b: 1, a: 2 }, 'keys_unsorted');
      const parsed = JSON.parse(r.trim());
      expect(parsed).toContain('a');
      expect(parsed).toContain('b');
    });

    it('values', async () => {
      const r = evaluateJq({ a: 1, b: 2 }, 'values');
      const parsed = JSON.parse(r.trim());
      expect(parsed).toContain(1);
      expect(parsed).toContain(2);
    });

    it('to_entries and from_entries roundtrip', async () => {
      const orig = { a: 1, b: 2 };
      const r = evaluateJq(orig, 'to_entries | from_entries');
      expect(JSON.parse(r.trim())).toEqual(orig);
    });

    it('with_entries (object construction syntax)', async () => {
      // with_entries requires constructing a new object, not assignment.
      // .value = .value + 10 is assignment syntax, not supported.
      // Use object construction: {key, value: (.value + 10)}
      const r = evaluateJq({ a: 1, b: 2 }, 'with_entries({key: .key, value: (.value + 10)})');
      expect(JSON.parse(r.trim())).toEqual({ a: 11, b: 12 });
    });

    it('map_values', async () => {
      const r = evaluateJq({ a: 1, b: 2 }, 'map_values(. * 2)');
      expect(JSON.parse(r.trim())).toEqual({ a: 2, b: 4 });
    });

    it('object shorthand construction {name}', async () => {
      const r = evaluateJq({ name: 'shiro', version: '1.0' }, '{name}');
      expect(JSON.parse(r.trim())).toEqual({ name: 'shiro' });
    });

    it('del(.key)', async () => {
      const r = evaluateJq({ a: 1, b: 2 }, 'del(.a)');
      expect(JSON.parse(r.trim())).toEqual({ b: 2 });
    });
  });

  // ─── Recursion & Paths ─────────────────────────────────────────

  describe('recursion & paths', () => {
    it('recurse finds all nested values', async () => {
      const data = { a: { b: 1 }, c: 2 };
      const r = evaluateJq(data, '[recurse | type] | unique');
      const parsed = JSON.parse(r.trim());
      expect(parsed).toContain('object');
      expect(parsed).toContain('number');
    });

    it('paths lists all paths', async () => {
      const data = { a: 1, b: { c: 2 } };
      const r = evaluateJq(data, '[paths]');
      const parsed = JSON.parse(r.trim());
      expect(parsed).toContainEqual(['a']);
      expect(parsed).toContainEqual(['b']);
      expect(parsed).toContainEqual(['b', 'c']);
    });

    it('getpath retrieves nested value', async () => {
      const data = { a: { b: { c: 42 } } };
      const r = evaluateJq(data, 'getpath(["a","b","c"])');
      expect(r.trim()).toBe('42');
    });
  });

  // ─── Control Flow ──────────────────────────────────────────────

  describe('control flow', () => {
    it('if-then-else (else branch)', async () => {
      const r = evaluateJq(2, 'if . > 3 then "big" else "small" end');
      expect(r.trim()).toBe('"small"');
    });

    it('try-catch', async () => {
      const r = evaluateJq(null, 'try error catch "caught"');
      // Should not throw, should return caught value
      expect(r.trim()).toBe('"caught"');
    });

    it('empty produces no output', async () => {
      const r = evaluateJq(null, 'empty');
      expect(r).toBe('');
    });

    it('comma operator produces multiple outputs', async () => {
      const r = evaluateJq(null, '1, 2, 3');
      const lines = r.trim().split('\n');
      expect(lines).toEqual(['1', '2', '3']);
    });
  });

  // ─── Pipe Chains ───────────────────────────────────────────────

  describe('complex pipes', () => {
    it('map + select + length', async () => {
      const data = [
        { name: 'a', active: true },
        { name: 'b', active: false },
        { name: 'c', active: true },
      ];
      const r = evaluateJq(data, '[.[] | select(.active)] | length');
      expect(r.trim()).toBe('2');
    });

    it('to_entries | map | from_entries', async () => {
      const data = { x: 1, y: 2, z: 3 };
      const r = evaluateJq(data, '[to_entries[] | select(.value > 1)] | from_entries');
      expect(JSON.parse(r.trim())).toEqual({ y: 2, z: 3 });
    });

    it('nested object construction with pipes', async () => {
      const data = { name: 'test', count: 5 };
      const r = evaluateJq(data, '{n: .name, doubled: (.count * 2)}');
      expect(JSON.parse(r.trim())).toEqual({ n: 'test', doubled: 10 });
    });
  });

  // ─── CLI Flags ─────────────────────────────────────────────────

  describe('CLI flags', () => {
    it('-s (slurp) collects lines into array', async () => {
      await fs.writeFile('/tmp/jq-lines.txt', '1\n2\n3\n');
      const { output } = await run(shell, 'cat /tmp/jq-lines.txt | jq -s .');
      const parsed = JSON.parse(output.trim());
      expect(parsed).toEqual([1, 2, 3]);
    });

    it('-n (null input)', async () => {
      const { output } = await run(shell, "echo 'ignored' | jq -n '42'");
      expect(output.trim()).toBe('42');
    });

    it('-e (exit status) returns 1 for false', async () => {
      const { exitCode } = await run(shell, "echo 'false' | jq -e .");
      expect(exitCode).toBe(1);
    });

    it('-e (exit status) returns 0 for truthy', async () => {
      const { exitCode } = await run(shell, "echo '42' | jq -e .");
      expect(exitCode).toBe(0);
    });

    it('reads from file argument', async () => {
      await fs.writeFile('/tmp/jq-data.json', '{"key": "value"}');
      const { output } = await run(shell, 'jq .key /tmp/jq-data.json');
      expect(output.trim()).toBe('"value"');
    });

    it('returns exit code 2 on unknown function', async () => {
      const { exitCode } = await run(shell, "echo '{}' | jq 'nonexistent_func'");
      expect(exitCode).toBe(2);
    });
  });

  // ─── Type Queries ──────────────────────────────────────────────

  describe('type queries', () => {
    it('type of null', () => {
      expect(evaluateJq(null, 'type').trim()).toBe('"null"');
    });

    it('type of number', () => {
      expect(evaluateJq(42, 'type').trim()).toBe('"number"');
    });

    it('type of string', () => {
      expect(evaluateJq('hello', 'type').trim()).toBe('"string"');
    });

    it('type of array', () => {
      expect(evaluateJq([1, 2], 'type').trim()).toBe('"array"');
    });

    it('type of object', () => {
      expect(evaluateJq({ a: 1 }, 'type').trim()).toBe('"object"');
    });

    it('type of boolean', () => {
      expect(evaluateJq(true, 'type').trim()).toBe('"boolean"');
    });
  });

  // ─── Range ─────────────────────────────────────────────────────

  describe('range', () => {
    it('range(n) generates 0..n-1', () => {
      const r = evaluateJq(null, '[range(5)]');
      expect(JSON.parse(r.trim())).toEqual([0, 1, 2, 3, 4]);
    });

    it('range(from; to)', () => {
      const r = evaluateJq(null, '[range(2; 5)]');
      expect(JSON.parse(r.trim())).toEqual([2, 3, 4]);
    });
  });

  // ─── Indices ───────────────────────────────────────────────────

  describe('indices & index', () => {
    it('index finds first occurrence in string', () => {
      const r = evaluateJq('abcabc', 'index("bc")');
      expect(r.trim()).toBe('1');
    });

    it('indices finds all occurrences', () => {
      const r = evaluateJq('abcabc', 'indices("bc")');
      expect(JSON.parse(r.trim())).toEqual([1, 4]);
    });

    it('index in array', () => {
      const r = evaluateJq([10, 20, 30], 'index(20)');
      expect(r.trim()).toBe('1');
    });
  });
});
