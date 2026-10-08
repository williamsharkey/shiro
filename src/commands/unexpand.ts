import type { Command } from './index';
import { readOperands } from './flags';
import { parseTabArgs } from './expand';

/**
 * unexpand, as GNU coreutils: converts leading blanks (all blanks with -a
 * or -t) to tabs; a single space before a tab stop stays a space.
 */
export const unexpand: Command = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(ctx) {
    let all = false;
    let firstOnly = false;
    const parsed = parseTabArgs('unexpand', ctx.args, (f) => {
      if (f === '-a' || f === '--all') { all = true; return true; }
      if (f === '--first-only') { firstOnly = true; return true; }
      return false;
    });
    if (parsed.error) {
      ctx.stderr += `unexpand: ${parsed.error}\n`;
      if (/option/.test(parsed.error)) ctx.stderr += `Try 'unexpand --help' for more information.\n`;
      return 1;
    }
    const { tabs } = parsed;
    const convertAll = (all || parsed.sawT) && !firstOnly;
    const { content, status } = await readOperands(ctx, 'unexpand', parsed.files);

    let out = '';
    let i = 0;
    const n = content.length;
    while (i < n) {
      // One line (GNU unexpand.c's inner loop)
      let convert = true;
      let column = 0;
      const state = { index: 0 };
      let oneBlankBeforeTabStop = false;
      let prevBlank = true;
      let pending: string[] = [];
      let c: string | null;
      do {
        c = i < n ? content[i++] : null;
        if (convert) {
          const blank = c === ' ' || c === '\t';
          if (blank) {
            const nt = tabs.next(column, state);
            if (nt.last) convert = false;
            if (convert) {
              if (c === '\t') {
                column = nt.col;
                if (pending.length) pending[0] = '\t';
              } else {
                column++;
                if (!(prevBlank && column === nt.col)) {
                  // Not yet time to output a tab
                  if (column === nt.col) oneBlankBeforeTabStop = true;
                  pending.push(c!);
                  prevBlank = true;
                  continue;
                }
                // Replace the pending blanks by a tab or two
                c = '\t';
                pending[0] = '\t';
              }
              // Discard pending blanks, unless a single blank just before the previous tab stop
              pending = oneBlankBeforeTabStop ? pending.slice(0, 1) : [];
            }
          } else if (c === '\b') {
            if (column) column--;
            if (state.index) state.index--;
          } else {
            column++;
          }
          if (pending.length) {
            if (pending.length > 1 && oneBlankBeforeTabStop) pending[0] = '\t';
            out += pending.join('');
            pending = [];
            oneBlankBeforeTabStop = false;
          }
          prevBlank = blank;
          convert = convert && (convertAll || blank);
        }
        if (c === null) break;
        out += c;
      } while (c !== '\n');
    }
    ctx.stdout += out;
    return status;
  },
};
