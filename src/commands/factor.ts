/**
 * factor — print prime factors of a number
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';

function primeFactors(n: number): number[] {
  if (n <= 1) return [];
  const factors: number[] = [];
  while (n % 2 === 0) { factors.push(2); n /= 2; }
  for (let i = 3; i * i <= n; i += 2) {
    while (n % i === 0) { factors.push(i); n /= i; }
  }
  if (n > 1) factors.push(n);
  return factors;
}

export const factorCmd: Command = {
  name: 'factor',
  description: 'Print prime factors of numbers',
  async exec(ctx) {
    try {
      const { positional } = parseArgs(ctx.args, []);

      let numbers: string[];
      if (positional.length > 0) {
        numbers = positional;
      } else if (ctx.stdin) {
        numbers = ctx.stdin.trim().split(/\s+/);
      } else {
        return 0;
      }

      for (const s of numbers) {
        const n = parseInt(s, 10);
        if (isNaN(n) || n < 0 || s !== String(n)) {
          ctx.stderr += `factor: '${s}' is not a valid positive integer\n`;
          return 1;
        }
        const factors = primeFactors(n);
        ctx.stdout += `${n}:${factors.length ? ' ' + factors.join(' ') : ''}\n`;
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `factor: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
