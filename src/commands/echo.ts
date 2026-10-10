import { EscapedBytes } from '../utils/printf';
import type { Command } from './index';

/**
 * echo, as bash's builtin: leading words made only of -n/-e/-E are options
 * (`-ne` too); -e interprets \a \b \c \e \f \n \r \t \v \\ \0NNN \xHH
 * \uHHHH \UHHHHHHHH, and \c ends all output.
 */
export const echo: Command = {
  name: "echo",
  description: "Display text",
  async exec(ctx) {
    const args = ctx.args;
    let newline = true;
    let escapes = false;
    let i = 0;
    for (; i < args.length && /^-[neE]+$/.test(args[i]); i++) {
      for (const f of args[i].slice(1)) {
        if (f === 'n') newline = false;
        else if (f === 'e') escapes = true;
        else escapes = false;
      }
    }
    const text = args.slice(i).join(' ');
    if (!escapes) {
      ctx.stdout += text + (newline ? '\n' : '');
      return 0;
    }
    let out = '';
    // \0NNN and \xHH are bytes, decoded a run at a time (\xc3\xa9 is é; \xff one byte)
    const bytes = new EscapedBytes();
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (c !== '\\' || k + 1 >= text.length) { out += bytes.flush() + c; continue; }
      const n = text[++k];
      if (n === '0') {
        const m = /^[0-7]{0,3}/.exec(text.slice(k + 1))![0];
        bytes.push(parseInt(m || '0', 8) & 0xff);
        k += m.length;
        continue;
      }
      if (n === 'x') {
        const m = /^[0-9a-fA-F]{1,2}/.exec(text.slice(k + 1));
        if (m) { bytes.push(parseInt(m[0], 16)); k += m[0].length; continue; }
      }
      out += bytes.flush();
      const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
      if (simple[n] !== undefined) { out += simple[n]; continue; }
      if (n === 'c') { ctx.stdout += out; return 0; }
      if (n === 'u' || n === 'U') {
        const m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(text.slice(k + 1));
        if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); k += m[0].length; continue; }
      }
      out += '\\' + n;
    }
    ctx.stdout += out + bytes.flush() + (newline ? '\n' : '');
    return 0;
  },
};
