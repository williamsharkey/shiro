import { Command } from './index';

/**
 * iconv -f FROM -t TO[//TRANSLIT][//IGNORE] [-c] [-o FILE] [FILE...]
 *
 * Decodes with the browser's TextDecoder (UTF-8, ISO-8859-*, WINDOWS-125*,
 * UTF-16, KOI8-R, Shift_JIS, ...) and encodes to UTF-8, UTF-16/32, ASCII
 * or ISO-8859-1/WINDOWS-1252. A character the target can't hold is an
 * error (exit 1), unless //TRANSLIT approximates it (é → e, ß → ss,
 * “ → ") or //IGNORE or -c drops it.
 */

const TRANSLIT: Record<string, string> = {
  'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L',
  'þ': 'th', 'Þ': 'TH', 'ð': 'd', 'Ð': 'D', 'ı': 'i', 'ĳ': 'ij', 'Ĳ': 'IJ',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '«': '<<', '»': '>>', '‹': '<', '›': '>',
  '–': '-', '—': '-', '‐': '-', '‑': '-', '−': '-', '…': '...', '•': 'o', '·': '.', '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ',
  '€': 'EUR', '£': 'GBP', '¥': 'JPY', '©': '(C)', '®': '(R)', '™': '(TM)', '°': '?', '×': 'x', '÷': ':',
  '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4', '¿': '?', '¡': '!',
};

function canonical(name: string): string {
  const n = name.toUpperCase().replace(/^CP(\d+)$/, 'WINDOWS-$1');
  if (/^(US-?)?ASCII$|^ANSI_X3\.4-1968$|^646$/.test(n)) return 'ASCII';
  if (/^UTF-?8$/.test(n)) return 'UTF-8';
  if (/^(ISO[-_]?8859-1|LATIN-?1|L1|ISO-IR-100)$/.test(n)) return 'ISO-8859-1';
  if (/^UTF-?16$/.test(n)) return 'UTF-16';
  if (/^UTF-?16LE$/.test(n)) return 'UTF-16LE';
  if (/^UTF-?16BE$/.test(n)) return 'UTF-16BE';
  if (/^UTF-?32$/.test(n)) return 'UTF-32';
  if (/^UTF-?32LE$/.test(n)) return 'UTF-32LE';
  if (/^UTF-?32BE$/.test(n)) return 'UTF-32BE';
  return n;
}

function decode(bytes: Uint8Array, enc: string): string {
  if (enc === 'ASCII') return new TextDecoder('utf-8').decode(bytes);
  if (enc.startsWith('UTF-32')) {
    let le = enc !== 'UTF-32BE';
    let i = 0;
    if (enc === 'UTF-32' && bytes.length >= 4) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) i = 4;
      else if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) { le = false; i = 4; }
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = '';
    for (; i + 4 <= bytes.length; i += 4) s += String.fromCodePoint(dv.getUint32(i, le));
    return s;
  }
  return new TextDecoder(enc === 'UTF-16' ? 'utf-16le' : enc.toLowerCase(), { fatal: false }).decode(bytes);
}

/** The bytes of `text` in `enc`; `fit` decides about each character the target lacks */
function encode(text: string, enc: string, fit: (ch: string) => string | null): { bytes: Uint8Array; bad?: number } {
  if (enc === 'UTF-8') return { bytes: new TextEncoder().encode(text) };
  const out: number[] = [];
  const chars = [...text];
  const limit = enc === 'ASCII' ? 0x7f : enc === 'ISO-8859-1' ? 0xff : enc === 'WINDOWS-1252' ? 0xff : Infinity;
  const cp1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f };
  const push = (cp: number) => {
    if (enc.startsWith('UTF-16')) {
      const be = enc === 'UTF-16BE';
      const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
      for (const u of units) out.push(...(be ? [u >> 8, u & 0xff] : [u & 0xff, u >> 8]));
    } else if (enc.startsWith('UTF-32')) {
      const b = [cp & 0xff, (cp >> 8) & 0xff, (cp >> 16) & 0xff, cp >>> 24];
      out.push(...(enc === 'UTF-32BE' ? b.reverse() : b));
    } else out.push(cp);
  };
  if (enc === 'UTF-16') out.push(0xff, 0xfe);
  if (enc === 'UTF-32') out.push(0xff, 0xfe, 0, 0);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    let cp = ch.codePointAt(0)!;
    if (enc === 'WINDOWS-1252' && cp1252[cp] !== undefined) { out.push(cp1252[cp]); continue; }
    if (enc === 'WINDOWS-1252' && cp >= 0x80 && cp <= 0x9f) cp = Infinity;
    if (cp <= limit) { push(cp); continue; }
    const repl = fit(ch);
    if (repl === null) return { bytes: new Uint8Array(out), bad: i };
    for (const r of repl) push(r.codePointAt(0)!);
  }
  return { bytes: new Uint8Array(out) };
}

function translit(ch: string): string {
  if (TRANSLIT[ch] !== undefined) return TRANSLIT[ch];
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return base !== ch && /^[\x00-\x7f]+$/.test(base) ? base : '?';
}

export const iconvCmd: Command = {
  name: 'iconv',
  description: 'Convert text from one character encoding to another',
  async exec(ctx) {
    let from = 'UTF-8', to = 'UTF-8', drop = false, outFile = '';
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const val = (flag: string) => (a.length > flag.length ? a.slice(flag.length).replace(/^=/, '') : args[++i] ?? '');
      if (a === '-l' || a === '--list') {
        ctx.stdout = 'ASCII\nUTF-8\nUTF-16 UTF-16LE UTF-16BE\nUTF-32 UTF-32LE UTF-32BE\nISO-8859-1 LATIN1\nISO-8859-2 ... ISO-8859-16\nWINDOWS-1250 ... WINDOWS-1258\nKOI8-R KOI8-U\nSHIFT_JIS EUC-JP EUC-KR GBK GB18030 BIG5 (decoding)\n';
        return 0;
      }
      if (a.startsWith('--from-code')) from = val('--from-code');
      else if (a.startsWith('--to-code')) to = val('--to-code');
      else if (a.startsWith('--output')) outFile = val('--output');
      else if (a.startsWith('-f')) from = val('-f');
      else if (a.startsWith('-t')) to = val('-t');
      else if (a.startsWith('-o')) outFile = val('-o');
      else if (a === '-c') drop = true;
      else if (a === '-s' || a === '--silent') { /* quiet */ }
      else if (a === '--') files.push(...args.slice(i + 1)), (i = args.length);
      else if (a.startsWith('-') && a !== '-') { ctx.stderr = `iconv: unrecognized option '${a}'\n`; return 1; }
      else files.push(a);
    }
    const [toName, ...suffixes] = to.split('//');
    const translitOn = suffixes.some((s) => s.toUpperCase() === 'TRANSLIT');
    const ignore = drop || suffixes.some((s) => s.toUpperCase() === 'IGNORE');
    const fromEnc = canonical(from.split('//')[0]), toEnc = canonical(toName);
    for (const [name, enc] of [[from, fromEnc], [toName, toEnc]]) {
      if (['ASCII', 'UTF-8', 'UTF-16', 'UTF-16LE', 'UTF-16BE', 'UTF-32', 'UTF-32LE', 'UTF-32BE', 'ISO-8859-1', 'WINDOWS-1252'].includes(enc)) continue;
      try {
        new TextDecoder(enc.toLowerCase());
        if (name === toName) throw new Error();
      } catch {
        ctx.stderr = `iconv: conversion ${name === toName ? 'to' : 'from'} \`${name}' is not supported\n`;
        return 1;
      }
    }

    let input: Uint8Array;
    if (files.length && !(files.length === 1 && files[0] === '-')) {
      const parts: Uint8Array[] = [];
      for (const f of files) {
        try {
          const data = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
          parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        } catch {
          ctx.stderr = `iconv: cannot open input file \`${f}': No such file or directory\n`;
          return 1;
        }
      }
      input = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) { input.set(p, off); off += p.length; }
    } else {
      input = new TextEncoder().encode(ctx.stdin);
    }

    const text = decode(input, fromEnc);
    const { bytes, bad } = encode(text, toEnc, (ch) => (translitOn ? translit(ch) : ignore ? '' : null));
    if (outFile) await ctx.fs.writeFile(ctx.fs.resolvePath(outFile, ctx.cwd), bytes);
    else ctx.stdout = toEnc === 'UTF-8' || toEnc === 'ASCII' ? new TextDecoder().decode(bytes) : Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    if (bad !== undefined) {
      const before = [...text].slice(0, bad).join('');
      const line = before.split('\n').length, col = before.length - before.lastIndexOf('\n');
      ctx.stderr = `iconv: cannot convert\niconv: illegal input sequence at position ${new TextEncoder().encode(before).length} (line ${line}, column ${col})\n`;
      return 1;
    }
    return 0;
  },
};
