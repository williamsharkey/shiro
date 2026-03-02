/**
 * numfmt — convert numbers from/to human-readable strings
 */

import type { Command } from './index';
import { parseArgs } from './flags';

const SI_SUFFIXES = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
const IEC_SUFFIXES = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
const IECI_SUFFIXES = ['', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei'];

function parseNumber(s: string, from: string): number {
  s = s.trim();
  if (from === 'none') return parseFloat(s);

  // Try to extract suffix
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([A-Za-z]*)$/);
  if (!m) return parseFloat(s);

  const num = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  if (!suffix) return num;

  // Determine base from suffix and mode
  let base: number;
  if (from === 'iec' || (from === 'auto' && suffix.endsWith('I'))) {
    base = 1024;
  } else {
    base = 1000;
  }

  const letter = suffix.charAt(0);
  const idx = 'KMGTPE'.indexOf(letter);
  if (idx === -1) return num;
  return num * Math.pow(base, idx + 1);
}

function formatNumber(value: number, to: string, fmt: string, roundMethod: string): string {
  if (to === 'none') return applyFormat(value, fmt, roundMethod);

  const base = (to === 'iec' || to === 'iec-i') ? 1024 : 1000;
  const suffixes = to === 'iec-i' ? IECI_SUFFIXES : (to === 'iec' ? IEC_SUFFIXES : SI_SUFFIXES);

  let idx = 0;
  let v = Math.abs(value);
  while (v >= base && idx < suffixes.length - 1) {
    v /= base;
    idx++;
  }
  if (value < 0) v = -v;

  const formatted = applyFormat(v, fmt, roundMethod);
  return formatted + suffixes[idx];
}

function applyFormat(value: number, fmt: string, roundMethod: string): string {
  // Apply rounding
  const rounded = applyRounding(value, fmt, roundMethod);

  // Parse format string like %.2f
  const fmtMatch = fmt.match(/^%\.?(\d*)f$/);
  if (fmtMatch) {
    const decimals = fmtMatch[1] ? parseInt(fmtMatch[1], 10) : 1;
    return rounded.toFixed(decimals);
  }
  // Default: 1 decimal place
  return rounded.toFixed(1);
}

function applyRounding(value: number, fmt: string, method: string): number {
  const fmtMatch = fmt.match(/^%\.?(\d*)f$/);
  const decimals = fmtMatch && fmtMatch[1] ? parseInt(fmtMatch[1], 10) : 1;
  const factor = Math.pow(10, decimals);

  switch (method) {
    case 'up': return Math.ceil(value * factor) / factor;
    case 'down': return Math.floor(value * factor) / factor;
    case 'from-zero':
      return value >= 0
        ? Math.ceil(value * factor) / factor
        : Math.floor(value * factor) / factor;
    case 'towards-zero':
      return value >= 0
        ? Math.floor(value * factor) / factor
        : Math.ceil(value * factor) / factor;
    case 'nearest':
    default:
      return Math.round(value * factor) / factor;
  }
}

export const numfmtCmd: Command = {
  name: 'numfmt',
  description: 'Convert numbers from/to human-readable strings',
  async exec(ctx) {
    try {
      // Pre-process args to split --key=value into --key value
      const expandedArgs: string[] = [];
      for (const arg of ctx.args) {
        const eqMatch = arg.match(/^(--[a-z-]+)=(.*)$/);
        if (eqMatch) {
          expandedArgs.push(eqMatch[1], eqMatch[2]);
        } else {
          expandedArgs.push(arg);
        }
      }
      const { values, positional, flags } = parseArgs(expandedArgs, [
        'from', 'to', 'format', 'padding', 'suffix', 'header', 'round',
      ]);

      const from = values.from || 'none';
      const to = values.to || 'none';
      const fmt = values.format || '%.1f';
      const padding = values.padding ? parseInt(values.padding, 10) : 0;
      const suffix = values.suffix || '';
      const headerCount = values.header ? parseInt(values.header, 10) || 1 : (flags.header ? 1 : 0);
      const roundMethod = values.round || 'nearest';

      let inputs: string[];
      if (positional.length > 0) {
        inputs = positional;
      } else if (ctx.stdin) {
        inputs = ctx.stdin.trimEnd().split('\n');
      } else {
        return 0;
      }

      for (let i = 0; i < inputs.length; i++) {
        const line = inputs[i];
        // Pass through header lines
        if (i < headerCount) {
          ctx.stdout += line + '\n';
          continue;
        }

        const num = parseNumber(line, from);
        if (isNaN(num)) {
          ctx.stderr += `numfmt: invalid number: '${line}'\n`;
          return 1;
        }

        let result = formatNumber(num, to, fmt, roundMethod) + suffix;

        // Apply padding
        if (padding > 0 && result.length < padding) {
          result = ' '.repeat(padding - result.length) + result;
        } else if (padding < 0 && result.length < -padding) {
          result = result + ' '.repeat(-padding - result.length);
        }

        ctx.stdout += result + '\n';
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `numfmt: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
