import type { Command } from './index';
import { printfFormat } from '../utils/printf';

/** Digits after the decimal point in a numeric operand (`.30` → 2, `1e2` → 0) */
function fracDigits(s: string): number {
  const m = /\.(\d*)/.exec(s);
  return m && !/[eE]/.test(s) ? m[1].length : 0;
}

/**
 * seq [OPTION]... [FIRST [INCREMENT]] LAST, as GNU coreutils: values are
 * FIRST + k*INCREMENT printed with the operands' decimal precision; -w pads
 * with zeros to equal width; -s separates, and a newline always ends output.
 */
export const seq: Command = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(ctx) {
    let separator = '\n';
    let format: string | null = null;
    let equalWidth = false;
    const operands: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      // Negative numbers are operands, not options
      if (operands.length || !a.startsWith('-') || /^-\.?\d/.test(a)) { operands.push(a); continue; }
      if (a === '--') { operands.push(...args.slice(i + 1)); break; }
      if (a === '-w' || a === '--equal-width') { equalWidth = true; continue; }
      const long = /^--(separator|format)=(.*)$/s.exec(a);
      if (long) { if (long[1] === 'separator') separator = long[2]; else format = long[2]; continue; }
      if (a === '-s' || a === '--separator') { separator = args[++i] ?? ''; continue; }
      if (a === '-f' || a === '--format') { format = args[++i] ?? ''; continue; }
      if (a.startsWith('-s')) { separator = a.slice(2); continue; }
      if (a.startsWith('-f')) { format = a.slice(2); continue; }
      if (/^-w+$/.test(a)) { equalWidth = true; continue; }
      ctx.stderr += `seq: invalid option -- '${a.slice(1, 2)}'\n`;
      return 1;
    }
    if (operands.length === 0) { ctx.stderr += 'seq: missing operand\n'; return 1; }
    if (operands.length > 3) { ctx.stderr += `seq: extra operand '${operands[3]}'\nTry 'seq --help' for more information.\n`; return 1; }

    const [firstS, incS, lastS] = operands.length === 1 ? ['1', '1', operands[0]]
      : operands.length === 2 ? [operands[0], '1', operands[1]] : operands;
    const num = (s: string) => (/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s) ? Number(s)
      : /^\s*[+-]?0[xX][0-9a-fA-F]+\s*$/.test(s) ? (s.includes('-') ? -1 : 1) * parseInt(s.trim().replace(/^[+-]?0[xX]/, ''), 16)
      : /^\s*[+-]?inf(inity)?\s*$/i.test(s) ? (s.includes('-') ? -Infinity : Infinity) : NaN);
    const first = num(firstS), inc = num(incS), last = num(lastS);
    for (const [s, v] of [[firstS, first], [incS, inc], [lastS, last]] as [string, number][]) {
      if (Number.isNaN(v)) { ctx.stderr += `seq: invalid floating point argument: '${s}'\n`; return 1; }
    }
    if (inc === 0) { ctx.stderr += `seq: invalid Zero increment value: '${incS}'\n`; return 1; }

    // GNU seq's scan_arg: printed width and precision of an operand (Infinity = unknown, use %g)
    const scan = (arg: string, v: number): { width: number; prec: number } => {
      const a = arg.replace(/^[\s+]+/, '').replace(/\s+$/, '');
      let width = a.length;
      let prec = Infinity;
      if (/[xX]/.test(a) || !Number.isFinite(v)) return { width: 0, prec };
      const dot = a.indexOf('.');
      const ePos = a.search(/[eE]/);
      let fracLen = 0;
      if (dot < 0) prec = 0;
      else {
        fracLen = (ePos >= 0 ? a.slice(dot + 1, ePos) : a.slice(dot + 1)).length;
        prec = fracLen;
        width += fracLen === 0 ? -1 : (dot === 0 || !/\d/.test(a[dot - 1]) ? 1 : 0);
      }
      if (ePos >= 0) {
        let exp = parseInt(a.slice(ePos + 1), 10) || 0;
        prec += exp < 0 ? -exp : -Math.min(prec, exp);
        width -= a.length - ePos;
        if (exp < 0) {
          if (dot >= 0) { if (ePos === dot + 1) width++; } else width++;
          exp = -exp;
        } else {
          if (dot >= 0 && prec === 0 && fracLen) width--;
          exp = -Math.min(prec, exp);
        }
        width += exp;
      }
      return { width, prec };
    };
    const fo = scan(firstS, first), so = scan(incS, inc), lo = scan(lastS, last);
    const precRaw = Math.max(fo.prec, so.prec);
    const useG = precRaw === Infinity || lo.prec === Infinity;
    const prec = useG ? 0 : precRaw;
    let width = 0;
    if (equalWidth && !useG) {
      let fw = fo.width + (prec - fo.prec);
      let lw = lo.width + (prec - lo.prec);
      if (lo.prec && prec === 0) lw--;
      if (lo.prec === 0 && prec) lw++;
      if (fo.prec === 0 && prec) fw++;
      width = Math.max(fw, lw);
    }
    const scale = 10 ** prec;
    const fmt = (v: number, negZero: boolean): string => {
      if (format !== null) return printfFormat(format, [String(v)]).out;
      if (useG) return printfFormat('%g', [String(v)]).out;
      // Round in the operands' precision so .3 steps don't drift (3.5999999…)
      let s = (Math.round(Math.abs(v) * scale) / scale).toFixed(prec);
      const neg = v < 0 || negZero;
      if (width) s = s.padStart(width - (neg ? 1 : 0), '0');
      if (neg) s = '-' + s;
      return s;
    };

    const out: string[] = [];
    for (let k = 0; ; k++) {
      const v = first + k * inc;
      const rounded = useG ? v : Math.round(v * scale) / scale;
      if (inc > 0 ? rounded > last + 1e-12 : rounded < last - 1e-12) break;
      out.push(fmt(rounded, k === 0 && Object.is(first, -0) || (rounded === 0 && firstS.trim().startsWith('-') && k === 0)));
      if (out.length > 10_000_000 || !Number.isFinite(v)) break;
    }
    if (out.length) ctx.stdout += out.join(separator) + '\n';
    return 0;
  },
};
