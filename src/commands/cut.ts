import type { Command } from './index';
import { decodeBytes, encodeText } from '../utils/byte-text';
import { readOperands } from './flags';

type Range = { lo: number; hi: number };

/**
 * cut, as GNU coreutils: -b/-c/-f LIST (ranges merged, output in input
 * order, each position once), -d, -s, -n, --complement,
 * --output-delimiter, -z; lines without the delimiter print whole (-f).
 */
export const cut: Command = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(ctx) {
    let mode: 'b' | 'c' | 'f' | null = null;
    let list = '';
    let delim: string | null = null;
    let outDelim: string | null = null;
    let onlyDelimited = false;
    let complement = false;
    let zero = false;
    const files: string[] = [];
    const usage = (msg: string) => {
      ctx.stderr += `cut: ${msg}\nTry 'cut --help' for more information.\n`;
      return 1;
    };
    const setMode = (m: 'b' | 'c' | 'f', v: string | undefined): string | null => {
      if (v === undefined) return `option requires an argument -- '${m}'`;
      if (mode) return 'only one list may be specified';
      mode = m;
      list = v;
      return null;
    };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
        let e: string | null = null;
        switch (name) {
          case 'bytes': e = setMode('b', val()); break;
          case 'characters': e = setMode('c', val()); break;
          case 'fields': e = setMode('f', val()); break;
          case 'delimiter': delim = val() ?? ''; break;
          case 'output-delimiter': outDelim = val() ?? ''; break;
          case 'only-delimited': onlyDelimited = true; break;
          case 'complement': complement = true; break;
          case 'zero-terminated': zero = true; break;
          default: return usage(`unrecognized option '${a}'`);
        }
        if (e) return usage(e);
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (ch === 'b' || ch === 'c' || ch === 'f' || ch === 'd') {
            const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            if (ch === 'd') {
              if (v === undefined) return usage("option requires an argument -- 'd'");
              delim = v;
            } else {
              const e = setMode(ch, v);
              if (e) return usage(e);
            }
            break;
          }
          if (ch === 's') onlyDelimited = true;
          else if (ch === 'n') { /* ignored */ }
          else if (ch === 'z') zero = true;
          else return usage(`invalid option -- '${ch}'`);
        }
        continue;
      }
      files.push(a);
    }

    if (!mode) return usage('you must specify a list of bytes, characters, or fields');
    if (delim !== null && mode !== 'f') return usage('an input delimiter may be specified only when operating on fields');
    if (onlyDelimited && mode !== 'f') return usage('suppressing non-delimited lines makes sense\n\tonly when operating on fields');
    if (delim !== null && [...delim].length > 1) return usage('the delimiter must be a single character');
    const d = delim === null || delim === '' ? (delim === '' ? '\0' : '\t') : delim;

    // Parse and normalize the list
    const ranges: Range[] = [];
    {
      // GNU set_fields
      const isF = mode === 'f';
      let value = 0, initial = 0;
      let lhs = false, rhs = false, dash = false;
      for (let i = 0; ; i++) {
        const c = list[i];
        if (c === '-') {
          if (dash) return usage(isF ? 'invalid field range' : 'invalid byte or character range');
          dash = true;
          if (lhs && value === 0) return usage(`${isF ? 'fields' : 'byte/character positions'} are numbered from 1`);
          initial = lhs ? value : 1;
          value = 0;
        } else if (c === undefined || c === ',' || c === ' ' || c === '\t') {
          if (dash) {
            if (!lhs && !rhs) return usage('invalid range with no endpoint: -');
            if (!rhs) ranges.push({ lo: initial, hi: Infinity });
            else {
              if (value < initial) return usage('invalid decreasing range');
              ranges.push({ lo: initial, hi: value });
            }
          } else {
            if (value === 0) return usage(`${isF ? 'fields' : 'byte/character positions'} are numbered from 1`);
            ranges.push({ lo: value, hi: value });
          }
          if (c === undefined) break;
          value = 0; lhs = rhs = dash = false;
        } else if (c >= '0' && c <= '9') {
          if (dash) rhs = true; else lhs = true;
          value = value * 10 + (c.charCodeAt(0) - 48);
        } else {
          return usage(`invalid ${isF ? 'field value' : 'byte/character position'} '${list.slice(i)}'`);
        }
      }
    }
    ranges.sort((x, y) => x.lo - y.lo);
    const merged: Range[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.lo <= last.hi) last.hi = Math.max(last.hi, r.hi);
      else merged.push({ ...r });
    }
    let sel: Range[] = merged;
    if (complement) {
      sel = [];
      let next = 1;
      for (const r of merged) {
        if (r.lo > next) sel.push({ lo: next, hi: r.lo - 1 });
        next = r.hi + 1;
      }
      if (next !== Infinity) sel.push({ lo: next, hi: Infinity });
    }

    const { content, status } = await readOperands(ctx, 'cut', files);
    const eol = zero ? '\0' : '\n';
    const lines = content === '' ? [] : content.split(eol);
    const hadFinal = content.endsWith(eol);
    if (hadFinal) lines.pop();

    let out = '';
    for (const line of lines) {
      if (mode === 'f') {
        if (!line.includes(d)) {
          if (!onlyDelimited) out += line + eol;
          continue;
        }
        const fields = line.split(d);
        const od = outDelim ?? d;
        const picked: string[] = [];
        for (const r of sel) {
          for (let k = r.lo; k <= r.hi && k <= fields.length; k++) picked.push(fields[k - 1]);
        }
        out += picked.join(od) + eol;
      } else if (mode === 'b') {
        // Bytes of the data (src/utils/byte-text.ts), not characters
        const bytes = encodeText(line);
        const parts: Uint8Array[] = [];
        for (const r of sel) {
          if (r.lo > bytes.length) break;
          parts.push(bytes.subarray(r.lo - 1, r.hi === Infinity ? undefined : r.hi));
        }
        out += parts.map(decodeBytes).join(outDelim ?? '') + eol;
      } else {
        const chars = [...line];
        let s = '';
        let first = true;
        for (const r of sel) {
          if (r.lo > chars.length) break;
          if (!first && outDelim !== null) s += outDelim;
          s += chars.slice(r.lo - 1, r.hi === Infinity ? undefined : r.hi).join('');
          first = false;
        }
        out += s + eol;
      }
    }
    ctx.stdout += out;
    return status;
  },
};
