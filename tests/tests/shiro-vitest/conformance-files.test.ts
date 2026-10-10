/**
 * The conformance suites (tests/conformance/*.conf.ts) only run under
 * `npm run conformance`, so a syntax error in one (an unescaped quote in a
 * results note) would go unnoticed here: each must at least parse.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { transformSync } from 'esbuild';

const dir = resolve(__dirname, '../../conformance');

describe('conformance suite files', () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.conf.ts'))) {
    it(`${f} parses`, () => {
      expect(() => transformSync(readFileSync(join(dir, f), 'utf8'), { loader: 'ts' })).not.toThrow();
    });
  }
});
