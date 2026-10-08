import type { Command } from './index';

/**
 * cat, as GNU coreutils: `-` (or no operand) is stdin; -n numbers lines,
 * -b non-blank lines, -s squeezes blank lines, -E marks line ends with $,
 * -T shows tabs as ^I, -v shows control characters, -A = -vET, -e = -vE,
 * -t = -vT. A missing file is reported and the rest are still printed.
 */
export const cat: Command = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(ctx) {
    let number = false, numberNonBlank = false, squeeze = false, showEnds = false, showTabs = false, showNonPrinting = false;
    const files: string[] = [];
    let opts = true;
    for (const a of ctx.args) {
      if (opts && a === '--') { opts = false; continue; }
      if (opts && a.startsWith('--') && a.length > 2) {
        const map: Record<string, () => void> = {
          '--number': () => { number = true; }, '--number-nonblank': () => { numberNonBlank = true; },
          '--squeeze-blank': () => { squeeze = true; }, '--show-ends': () => { showEnds = true; },
          '--show-tabs': () => { showTabs = true; }, '--show-nonprinting': () => { showNonPrinting = true; },
          '--show-all': () => { showNonPrinting = showEnds = showTabs = true; },
        };
        if (!map[a]) { ctx.stderr += `cat: unrecognized option '${a}'\n`; return 1; }
        map[a]();
        continue;
      }
      if (opts && a.startsWith('-') && a.length > 1) {
        for (const f of a.slice(1)) {
          switch (f) {
            case 'n': number = true; break;
            case 'b': numberNonBlank = true; break;
            case 's': squeeze = true; break;
            case 'E': showEnds = true; break;
            case 'T': showTabs = true; break;
            case 'v': showNonPrinting = true; break;
            case 'A': showNonPrinting = showEnds = showTabs = true; break;
            case 'e': showNonPrinting = showEnds = true; break;
            case 't': showNonPrinting = showTabs = true; break;
            case 'u': break;
            default: ctx.stderr += `cat: invalid option -- '${f}'\n`; return 1;
          }
        }
        continue;
      }
      files.push(a);
    }
    if (files.length === 0) files.push('-');

    const plain = !number && !numberNonBlank && !squeeze && !showEnds && !showTabs && !showNonPrinting;
    let status = 0;
    let lineNo = 0;
    let prevBlank = false;
    let atLineStart = true;
    let stdinUsed = false;
    for (const f of files) {
      let text: string;
      if (f === '-') {
        text = stdinUsed ? '' : ctx.stdin;
        stdinUsed = true;
      } else {
        try {
          const path = ctx.fs.resolvePath(f, ctx.cwd);
          const st = await ctx.fs.stat(path);
          if (st.isDirectory()) { ctx.stderr += `cat: ${f}: Is a directory\n`; status = 1; continue; }
          text = await ctx.fs.readFile(path, 'utf8') as string;
        } catch {
          ctx.stderr += `cat: ${f}: No such file or directory\n`;
          status = 1;
          continue;
        }
      }
      if (plain) { ctx.stdout += text; continue; }
      let out = '';
      // Line state carries across files, like one stream
      for (let i = 0; i < text.length; ) {
        const nl = text.indexOf('\n', i);
        const end = nl < 0 ? text.length : nl;
        let line = text.slice(i, end);
        const hasNl = nl >= 0;
        i = hasNl ? nl + 1 : text.length;
        const blank = atLineStart && line === '' && hasNl;
        if (squeeze && blank && prevBlank) continue;
        if (atLineStart) {
          prevBlank = blank;
          if (numberNonBlank ? !blank : number) out += String(++lineNo).padStart(6) + '\t';
        }
        if (showNonPrinting) {
          line = [...line].map((ch) => {
            const c = ch.charCodeAt(0);
            if (ch === '\t') return ch;
            if (c < 32) return '^' + String.fromCharCode(c + 64);
            if (c === 127) return '^?';
            if (c >= 128 && c < 160) return 'M-^' + String.fromCharCode(c - 128 + 64);
            if (c >= 160 && c < 256) return 'M-' + String.fromCharCode(c - 128);
            return ch;
          }).join('');
        }
        if (showTabs) line = line.replace(/\t/g, '^I');
        out += line;
        if (hasNl) out += (showEnds ? '$' : '') + '\n';
        atLineStart = hasNl;
      }
      ctx.stdout += out;
    }
    return status;
  },
};
