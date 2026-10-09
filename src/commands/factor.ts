/**
 * factor — print prime factors of numbers, as GNU coreutils: any size
 * (BigInt; Miller-Rabin + Pollard-Brent rho), leading blanks and '+'
 * accepted, operands from stdin when none are given, -h/--exponents.
 */

import type { Command } from './index';

const SMALL_PRIMES: number[] = (() => {
  const out: number[] = [];
  const sieve = new Uint8Array(1000);
  for (let i = 2; i < 1000; i++) {
    if (sieve[i]) continue;
    out.push(i);
    for (let j = i * i; j < 1000; j += i) sieve[j] = 1;
  }
  return out;
})();

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function isPrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES.slice(0, 15)) {
    const bp = BigInt(p);
    if (n === bp) return true;
    if (n % bp === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) { d >>= 1n; s++; }
  // Deterministic for n < 3.3e24; probabilistic (and extremely reliable) beyond
  const bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n];
  outer: for (const a of bases) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let r = 1; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

/** A non-trivial factor of composite n (Pollard-Brent) */
function rho(n: bigint): bigint {
  if ((n & 1n) === 0n) return 2n;
  for (let c = 1n; ; c++) {
    let y = 2n, x = 2n, g = 1n, q = 1n, ys = 2n;
    const f = (v: bigint) => (v * v + c) % n;
    let r = 1;
    const m = 128;
    do {
      x = y;
      for (let i = 0; i < r; i++) y = f(y);
      let k = 0;
      while (k < r && g === 1n) {
        ys = y;
        const lim = Math.min(m, r - k);
        for (let i = 0; i < lim; i++) {
          y = f(y);
          q = (q * (x > y ? x - y : y - x)) % n;
        }
        g = gcd(q, n);
        k += m;
      }
      r *= 2;
    } while (g === 1n);
    if (g === n) {
      do {
        ys = f(ys);
        g = gcd(x > ys ? x - ys : ys - x, n);
      } while (g === 1n);
    }
    if (g !== n) return g;
  }
}

function factorize(n: bigint): bigint[] {
  const out: bigint[] = [];
  for (const p of SMALL_PRIMES) {
    const bp = BigInt(p);
    if (bp * bp > n) break;
    while (n % bp === 0n) { out.push(bp); n /= bp; }
  }
  const stack = n > 1n ? [n] : [];
  while (stack.length) {
    const m = stack.pop()!;
    if (m === 1n) continue;
    if (isPrime(m)) { out.push(m); continue; }
    const d = rho(m);
    stack.push(d, m / d);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export const factorCmd: Command = {
  name: 'factor',
  description: 'Print prime factors of numbers',
  async exec(ctx) {
    let exponents = false;
    const numbers: string[] = [];
    let opts = true;
    for (const a of ctx.args) {
      if (opts && a === '--') { opts = false; continue; }
      if (opts && (a === '-h' || a === '--exponents')) { exponents = true; continue; }
      if (opts && a.length > 1 && a[0] === '-') {
        ctx.stderr += a.startsWith('--') ? `factor: unrecognized option '${a}'\n` : `factor: invalid option -- '${a[1]}'\n`;
        ctx.stderr += "Try 'factor --help' for more information.\n";
        return 1;
      }
      numbers.push(a);
    }
    if (numbers.length === 0) {
      numbers.push(...ctx.stdin.split(/\s+/).filter(Boolean));
    }

    let status = 0;
    let out = '';
    for (const s of numbers) {
      const m = /^[ \t\n\v\f\r]*\+?(\d+)$/.exec(s);
      if (!m) {
        ctx.stdout += out;
        out = '';
        ctx.stderr += `factor: '${s}' is not a valid positive integer\n`;
        status = 1;
        continue;
      }
      const n = BigInt(m[1]);
      const fs = factorize(n);
      let line = `${n}:`;
      if (exponents) {
        for (let i = 0; i < fs.length;) {
          let j = i;
          while (j < fs.length && fs[j] === fs[i]) j++;
          line += ` ${fs[i]}${j - i > 1 ? '^' + (j - i) : ''}`;
          i = j;
        }
      } else {
        for (const f of fs) line += ` ${f}`;
      }
      out += line + '\n';
    }
    ctx.stdout += out;
    return status;
  },
};
