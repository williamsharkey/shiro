import { describe, it, expect } from 'vitest';
import { carryAsyncContext } from '@shiro/node-compat/async-context';

// The rewrite that carries AsyncLocalStorage's store across await (async-context.ts)
describe('carryAsyncContext', () => {
  it('rewrites awaits and direct evals, not methods, accessors or functions named await or eval', () => {
    const src = 'class A { get await() { return 1 } eval(x) { return x } static await(y) {} async eval() {} }\n'
      + 'const o = { await: 1, eval(c) { return c } };\n'
      + 'async function f() { await (x); await g(); eval(y); obj.eval(z); (0, eval)(w); }';
    const out = carryAsyncContext(src);
    expect(out).toBe('class A { get await() { return 1 } eval(x) { return x } static await(y) {} async eval() {} }\n'
      + 'const o = { await: 1, eval(c) { return c } };\n'
      + 'async function f() { __shiroAls.r(__shiroAls.c(), await (x)); __shiroAls.r(__shiroAls.c(), await g()); eval(__shiroAls.e(y)); obj.eval(z); (0, eval)(w); }');
    // (rollup 4's dist/shared/rollup.js has `get await()`: the rewrite was a syntax error, and astro build failed)
    expect(() => new Function(out)).not.toThrow();
  });
});
