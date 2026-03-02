
import type { Command } from './index';
import { parseArgs, readInput } from './flags';

interface KeySpec {
  startField: number;
  startChar: number;
  endField: number;
  endChar: number;
  numeric: boolean;
  reverse: boolean;
  ignoreCase: boolean;
  humanNumeric: boolean;
  versionSort: boolean;
}

function parseKeySpec(spec: string): KeySpec {
  const ks: KeySpec = { startField: 1, startChar: 0, endField: 0, endChar: 0, numeric: false, reverse: false, ignoreCase: false, humanNumeric: false, versionSort: false };
  // Format: FIELD[.CHAR][FLAGS][,FIELD[.CHAR][FLAGS]]
  const [startPart, endPart] = spec.split(',');
  const parseFieldPart = (s: string) => {
    let field = 0, char = 0, flags = '';
    const m = s.match(/^(\d+)(?:\.(\d+))?([nrfhV]*)?$/);
    if (m) {
      field = parseInt(m[1], 10);
      char = m[2] ? parseInt(m[2], 10) : 0;
      flags = m[3] || '';
    }
    return { field, char, flags };
  };
  const start = parseFieldPart(startPart);
  ks.startField = start.field;
  ks.startChar = start.char;
  const applyFlags = (flags: string) => {
    if (flags.includes('n')) ks.numeric = true;
    if (flags.includes('r')) ks.reverse = true;
    if (flags.includes('f')) ks.ignoreCase = true;
    if (flags.includes('h')) ks.humanNumeric = true;
    if (flags.includes('V')) ks.versionSort = true;
  };
  applyFlags(start.flags);
  if (endPart) {
    const end = parseFieldPart(endPart);
    ks.endField = end.field;
    ks.endChar = end.char;
    applyFlags(end.flags);
  }
  return ks;
}

function extractField(line: string, spec: KeySpec, delim: string | null): string {
  const parts = delim ? line.split(delim) : line.split(/\s+/).filter(Boolean);
  const si = spec.startField - 1;
  const ei = spec.endField > 0 ? spec.endField - 1 : si;
  let result = parts.slice(si, ei + 1).join(delim || ' ');
  if (spec.startChar > 0) result = result.slice(spec.startChar - 1);
  if (spec.endChar > 0 && spec.endField > 0) {
    // endChar is relative to the end field
    const endFieldContent = parts[ei] || '';
    const endFieldStart = result.length - endFieldContent.length;
    if (endFieldStart >= 0 && spec.endChar < endFieldContent.length) {
      result = result.slice(0, endFieldStart + spec.endChar);
    }
  }
  return result;
}

function parseHumanSize(s: string): number {
  const m = s.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*([KMGTPE]i?)?B?$/i);
  if (!m) return parseFloat(s) || 0;
  let num = parseFloat(m[1]);
  const suffix = (m[2] || '').toUpperCase().replace('I', '');
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  if (suffix && multipliers[suffix]) num *= multipliers[suffix];
  return num;
}

function versionCompare(a: string, b: string): number {
  const splitVersion = (s: string) => s.split(/(\d+)/).filter(Boolean);
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || '';
    const y = pb[i] || '';
    const xn = parseInt(x, 10);
    const yn = parseInt(y, 10);
    if (!isNaN(xn) && !isNaN(yn)) {
      if (xn !== yn) return xn - yn;
    } else {
      const cmp = x.localeCompare(y);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function makeComparator(keys: KeySpec[], delim: string | null, globalNumeric: boolean, globalReverse: boolean, globalIgnoreCase: boolean, globalHuman: boolean, globalVersion: boolean, ignoreBlanks: boolean): (a: string, b: string) => number {
  return (a: string, b: string) => {
    if (keys.length > 0) {
      for (const key of keys) {
        let fa = extractField(a, key, delim);
        let fb = extractField(b, key, delim);
        if (ignoreBlanks) { fa = fa.trimStart(); fb = fb.trimStart(); }
        const numeric = key.numeric || globalNumeric;
        const ignoreCase = key.ignoreCase || globalIgnoreCase;
        const human = key.humanNumeric || globalHuman;
        const version = key.versionSort || globalVersion;
        const reverse = key.reverse || globalReverse;
        let cmp = 0;
        if (human) {
          cmp = parseHumanSize(fa) - parseHumanSize(fb);
        } else if (version) {
          cmp = versionCompare(fa, fb);
        } else if (numeric) {
          cmp = (parseFloat(fa) || 0) - (parseFloat(fb) || 0);
        } else {
          if (ignoreCase) { fa = fa.toLowerCase(); fb = fb.toLowerCase(); }
          cmp = fa.localeCompare(fb);
        }
        if (cmp !== 0) return reverse ? -cmp : cmp;
      }
      return 0;
    }
    // No key specs — sort whole line
    let la = ignoreBlanks ? a.trimStart() : a;
    let lb = ignoreBlanks ? b.trimStart() : b;
    if (globalHuman) return parseHumanSize(la) - parseHumanSize(lb);
    if (globalVersion) return versionCompare(la, lb);
    if (globalNumeric) return (parseFloat(la) || 0) - (parseFloat(lb) || 0);
    if (globalIgnoreCase) { la = la.toLowerCase(); lb = lb.toLowerCase(); }
    return la.localeCompare(lb);
  };
}

export const sort: Command = {
  name: "sort",
  description: "Sort lines of text",
  async exec(ctx) {
    const args = ctx.args;
    // Custom parsing for -k and -t which need value arguments
    const keys: KeySpec[] = [];
    let delim: string | null = null;
    let numeric = false, reverse = false, unique = false, stable = false;
    let ignoreCase = false, humanNumeric = false, versionSort = false;
    let ignoreBlanks = false, checkSorted = false;
    const positional: string[] = [];

    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === '-k' && i + 1 < args.length) {
        keys.push(parseKeySpec(args[++i]));
      } else if (arg.startsWith('-k') && arg.length > 2) {
        keys.push(parseKeySpec(arg.slice(2)));
      } else if (arg === '-t' && i + 1 < args.length) {
        delim = args[++i];
      } else if (arg.startsWith('-t') && arg.length > 2) {
        delim = arg.slice(2);
      } else if (arg === '--') {
        positional.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (ch === 'n') numeric = true;
          else if (ch === 'r') reverse = true;
          else if (ch === 'u') unique = true;
          else if (ch === 's') stable = true;
          else if (ch === 'f') ignoreCase = true;
          else if (ch === 'h') humanNumeric = true;
          else if (ch === 'V') versionSort = true;
          else if (ch === 'b') ignoreBlanks = true;
          else if (ch === 'c') checkSorted = true;
        }
      } else {
        positional.push(arg);
      }
      i++;
    }

    try {
      const { content } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
      );
      let lines = content.split("\n").filter(Boolean);

      const cmp = makeComparator(keys, delim, numeric, false, ignoreCase, humanNumeric, versionSort, ignoreBlanks);

      if (checkSorted) {
        for (let j = 1; j < lines.length; j++) {
          if (cmp(lines[j - 1], lines[j]) > 0) {
            ctx.stderr += `sort: -:${j + 1}: disorder: ${lines[j]}\n`;
            return 1;
          }
        }
        return 0;
      }

      if (stable) {
        // Stable sort (JS sort is stable in modern engines, but we make it explicit)
        lines.sort(cmp);
      } else {
        lines.sort(cmp);
      }

      if (unique) {
        lines = lines.filter((line, idx) => idx === 0 || cmp(lines[idx - 1], line) !== 0);
      }

      if (reverse && keys.length === 0) {
        lines.reverse();
      } else if (reverse && keys.length > 0) {
        // Reverse was not already applied per-key for global reverse
        // Only apply if no key has its own reverse flag
        const anyKeyReverse = keys.some(k => k.reverse);
        if (!anyKeyReverse) lines.reverse();
      }

      ctx.stdout += lines.join("\n") + "\n";
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `sort: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
