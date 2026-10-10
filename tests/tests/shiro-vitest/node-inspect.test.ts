/**
 * util.inspect / console.log print values as node does (src/node-compat/inspect.ts).
 * EXPECTED is node 22's own output for CASES.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

const CASES = "const util = require('util');\nclass Foo { constructor() { this.x = 1; this['a-b'] = 'it\\'s'; } }\nconst circ = { name: 'c' }; circ.self = circ;\nconst cases = [\n  { a: 1, b: 'x', c: [1, 2, 3], d: { e: { f: { g: 1 } } } },\n  [1, 2, 3],\n  Array.from({ length: 30 }, (_, i) => i * 3),\n  ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape', 'honeydew'],\n  new Map([['k', 1], ['l', { m: 2 }]]),\n  new Set([1, 'two', [3]]),\n  new Foo(),\n  Object.create(null),\n  Object.assign(Object.create(null), { a: 1 }),\n  circ,\n  [1, , , 4],\n  { fn() {}, arrow: () => 1, anon: function () {}, cls: class Bar {}, async af() {} },\n  { long1: 'aaaaaaaaaaaaaaaaaaaa', long2: 'bbbbbbbbbbbbbbbbbbbb', long3: 'cccccccccccccccccccc', long4: 'dddd' },\n  { s: 'he said \"hi\"', t: \"it's\", u: 'both \\' and \"' },\n  [undefined, null, true, -0, 1n, Symbol('s')],\n  { [Symbol('k')]: 1, 'not ident': 2, $ok: 3 },\n  new Date(0),\n  /ab+c/gi,\n  Array.from({ length: 120 }, (_, i) => i),\n  { get g() { return 1; }, set s(v) {}, get gs() { return 1; }, set gs(v) {} },\n  [[1, [2, [3, [4, [5]]]]]],\n  { a: [{ b: { c: {} } }] },\n  new Uint8Array([1, 2, 3]),\n  [new Map(), new Set(), {}, []],\n  { x: 'a\\nb', y: 'tab\\there' },\n];\nfor (const c of cases) console.log(c);\nconsole.log('%s is %d and %o', 'x', 42, { a: [1] }, 'extra', { b: 2 });\nconsole.log(util.format('%j %i %f %%', { a: 1 }, '42.9x', '3.5'));\nconsole.log(util.inspect({ a: { b: { c: { d: { e: 1 } } } } }, { depth: 0 }), util.inspect('str'), util.inspect(5));\nconsole.log(util.inspect({ a: 1, b: [1, 2] }, { compact: false }));\nconsole.log(util.inspect({ [util.inspect.custom]() { return 'CUSTOM'; } }), { inner: { [util.inspect.custom]: () => ({ replaced: true }) } });\nconsole.log(Buffer.from('hi there'));\nconsole.log([['a', 1], ['b', 2]], { nested: [[1, 2], [3, 4]] });\n";

const EXPECTED = "{ a: 1, b: 'x', c: [ 1, 2, 3 ], d: { e: { f: [Object] } } }\n[ 1, 2, 3 ]\n[\n   0,  3,  6,  9, 12, 15, 18, 21, 24,\n  27, 30, 33, 36, 39, 42, 45, 48, 51,\n  54, 57, 60, 63, 66, 69, 72, 75, 78,\n  81, 84, 87\n]\n[\n  'apple',\n  'banana',\n  'cherry',\n  'date',\n  'elderberry',\n  'fig',\n  'grape',\n  'honeydew'\n]\nMap(2) { 'k' => 1, 'l' => { m: 2 } }\nSet(3) { 1, 'two', [ 3 ] }\nFoo { x: 1, 'a-b': \"it's\" }\n[Object: null prototype] {}\n[Object: null prototype] { a: 1 }\n<ref *1> { name: 'c', self: [Circular *1] }\n[ 1, <2 empty items>, 4 ]\n{\n  fn: [Function: fn],\n  arrow: [Function: arrow],\n  anon: [Function: anon],\n  cls: [class Bar],\n  af: [AsyncFunction: af]\n}\n{\n  long1: 'aaaaaaaaaaaaaaaaaaaa',\n  long2: 'bbbbbbbbbbbbbbbbbbbb',\n  long3: 'cccccccccccccccccccc',\n  long4: 'dddd'\n}\n{ s: 'he said \"hi\"', t: \"it's\", u: `both ' and \"` }\n[ undefined, null, true, -0, 1n, Symbol(s) ]\n{ 'not ident': 2, '$ok': 3, [Symbol(k)]: 1 }\n1970-01-01T00:00:00.000Z\n/ab+c/gi\n[\n   0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11,\n  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,\n  24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,\n  36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,\n  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,\n  60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71,\n  72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,\n  84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95,\n  96, 97, 98, 99,\n  ... 20 more items\n]\n{ g: [Getter], s: [Setter], gs: [Getter/Setter] }\n[ [ 1, [ 2, [Array] ] ] ]\n{ a: [ { b: [Object] } ] }\nUint8Array(3) [ 1, 2, 3 ]\n[ Map(0) {}, Set(0) {}, {}, [] ]\n{ x: 'a\\nb', y: 'tab\\there' }\nx is 42 and { a: [ 1, [length]: 1 ] } extra { b: 2 }\n{\"a\":1} 42 3.5 %\n{ a: [Object] } 'str' 5\n{\n  a: 1,\n  b: [\n    1,\n    2\n  ]\n}\nCUSTOM { inner: { replaced: true } }\n<Buffer 68 69 20 74 68 65 72 65>\n[ [ 'a', 1 ], [ 'b', 2 ] ] { nested: [ [ 1, 2 ], [ 3, 4 ] ] }\n";

describe('node-style inspect', () => {
  it('console.log, util.inspect and util.format print like node', async () => {
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/tmp/inspect-cases.js', CASES);
    let out = '', err = '';
    await shell.execute('node /tmp/inspect-cases.js < /dev/null', (s) => { out += s; }, (s) => { err += s; });
    expect(err).toBe('');
    expect(out.replace(/\r\n/g, '\n')).toBe(EXPECTED);
  }, 60_000);

  it('node -p and strings at the top level print raw; objects inspected', async () => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute(`node -p '({ a: [1, "x"] })' < /dev/null; node -p '"raw"' < /dev/null; node -e 'console.log("s", 1, [2])' < /dev/null`, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe("{ a: [ 1, 'x' ] }\nraw\ns 1 [ 2 ]\n");
  }, 60_000);
});
