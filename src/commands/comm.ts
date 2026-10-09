import type { Command } from './index';
import { readOperands, splitLines } from './flags';

/** comm [-123] [--output-delimiter=S] [-z] [--total] FILE1 FILE2 (either may be `-`) */
export const comm: Command = {
  name: "comm",
  description: "Compare two sorted files line by line",
  async exec(ctx) {
    const sup = { 1: false, 2: false, 3: false };
    let delim = "\t";
    let zero = false;
    let total = false;
    const positional: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { positional.push(...args.slice(i + 1)); break; }
      if (a.startsWith("--output-delimiter")) {
        delim = a.includes("=") ? a.slice(a.indexOf("=") + 1) : (args[++i] ?? "");
        if (delim === "") delim = "\0";
        continue;
      }
      if (a === "--zero-terminated") { zero = true; continue; }
      if (a === "--total") { total = true; continue; }
      if (a === "--check-order" || a === "--nocheck-order") continue;
      if (a.startsWith("--")) { ctx.stderr += `comm: unrecognized option '${a}'\n`; return 1; }
      if (a.length > 1 && a[0] === "-") {
        for (const ch of a.slice(1)) {
          if (ch === "1" || ch === "2" || ch === "3") sup[ch] = true;
          else if (ch === "z") zero = true;
          else { ctx.stderr += `comm: invalid option -- '${ch}'\n`; return 1; }
        }
        continue;
      }
      positional.push(a);
    }

    if (positional.length < 2) {
      ctx.stderr += positional.length ? `comm: missing operand after '${positional[0]}'\n` : "comm: missing operand\n";
      return 1;
    }
    if (positional.length > 2) {
      ctx.stderr += `comm: extra operand '${positional[2]}'\n`;
      return 1;
    }

    const sep = zero ? "\0" : "\n";
    const r1 = await readOperands(ctx, "comm", [positional[0]]);
    if (r1.status) return 1;
    // `comm - -`: both read the same stdin
    const r2 = positional[1] === "-" && positional[0] === "-" ? r1 : await readOperands(ctx, "comm", [positional[1]]);
    if (r2.status) return 1;
    const lines1 = splitLines(r1.content, sep);
    const lines2 = splitLines(r2.content, sep);

    let out = "";
    const counts = [0, 0, 0];
    const emit = (col: 1 | 2 | 3, line: string) => {
      counts[col - 1]++;
      if (sup[col]) return;
      let prefix = "";
      if (col >= 2 && !sup[1]) prefix += delim;
      if (col === 3 && !sup[2]) prefix += delim;
      out += prefix + line + sep;
    };
    let i = 0, j = 0;
    while (i < lines1.length || j < lines2.length) {
      if (j >= lines2.length) emit(1, lines1[i++]);
      else if (i >= lines1.length) emit(2, lines2[j++]);
      else if (lines1[i] < lines2[j]) emit(1, lines1[i++]);
      else if (lines1[i] > lines2[j]) emit(2, lines2[j++]);
      else { emit(3, lines1[i]); i++; j++; }
    }
    if (total) out += `${counts[0]}${delim}${counts[1]}${delim}${counts[2]}${delim}total${sep}`;
    ctx.stdout += out;
    return 0;
  },
};
