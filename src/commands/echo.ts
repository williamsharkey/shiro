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
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (c !== '\\' || k + 1 >= text.length) { out += c; continue; }
      const n = text[++k];
      const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
      if (simple[n] !== undefined) { out += simple[n]; continue; }
      if (n === 'c') { ctx.stdout += out; return 0; }
      if (n === '0') {
        const m = /^[0-7]{0,3}/.exec(text.slice(k + 1))![0];
        out += String.fromCharCode(parseInt(m || '0', 8) & 0xff);
        k += m.length;
        continue;
      }
      if (n === 'x' || n === 'u' || n === 'U') {
        const max = n === 'x' ? 2 : n === 'u' ? 4 : 8;
        const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(text.slice(k + 1));
        if (m) {
          const v = parseInt(m[0], 16);
          out += n === 'x' ? String.fromCharCode(v) : String.fromCodePoint(v);
          k += m[0].length;
          continue;
        }
      }
      out += '\\' + n;
    }
    ctx.stdout += out + (newline ? '\n' : '');
    return 0;
  },
};
