import type { Command, CommandContext } from './index';
import { Parser } from './awk/parser';
import { AwkSyntaxError, unescapeString } from './awk/lexer';
import { compileProgram } from './awk/compile';
import { Runtime, SN, ExitSig, AwkFatal, NEXT, NEXTFILE } from './awk/runtime';

const USAGE = 'Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\n' +
  'Usage: awk [POSIX or GNU style options] [--] \'program\' file ...\n';

interface Options {
  fs?: string;
  assigns: string[];
  progFiles: string[];
  sources: string[];
  operands: string[];
}

function parseOptions(args: string[]): Options | string {
  const o: Options = { assigns: [], progFiles: [], sources: [], operands: [] };
  let i = 0;
  const value = (a: string, short: string): string | null => {
    if (a.length > short.length) return a.slice(short.length);
    if (i + 1 >= args.length) return null;
    return args[++i];
  };
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (a === '-' || !a.startsWith('-')) break;
    if (a.startsWith('--')) {
      const [name, val] = a.includes('=') ? [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a.slice(2), undefined];
      const v = () => (val !== undefined ? val : i + 1 < args.length ? args[++i] : null);
      switch (name) {
        case 'field-separator': { const x = v(); if (x === null) return 'option requires an argument -- F'; o.fs = x; break; }
        case 'assign': { const x = v(); if (x === null) return 'option requires an argument -- v'; o.assigns.push(x); break; }
        case 'file': { const x = v(); if (x === null) return 'option requires an argument -- f'; o.progFiles.push(x); o.sources.push('\0file:' + x); break; }
        case 'source': { const x = v(); if (x === null) return 'option requires an argument -- e'; o.sources.push(x); break; }
        case 'version': return '\0version';
        case 'help': case 'usage': return '\0usage';
        default: break; // --posix, --traditional, --lint, ...: accepted, no effect
      }
      continue;
    }
    const c = a[1];
    if (c === 'F') { const x = value(a, '-F'); if (x === null) return 'option requires an argument -- F'; o.fs = x; continue; }
    if (c === 'v') { const x = value(a, '-v'); if (x === null) return 'option requires an argument -- v'; o.assigns.push(x); continue; }
    if (c === 'f') { const x = value(a, '-f'); if (x === null) return 'option requires an argument -- f'; o.progFiles.push(x); o.sources.push('\0file:' + x); continue; }
    if (c === 'e') { const x = value(a, '-e'); if (x === null) return 'option requires an argument -- e'; o.sources.push(x); continue; }
    if (c === 'W') { value(a, '-W'); continue; }
    if (c === 'V') return '\0version';
    // other gawk flags (-b -c -P -n -S -s -r ...) are accepted and ignored
  }
  o.operands = args.slice(i);
  return o;
}

export const awk: Command = {
  name: 'awk',
  description: 'Pattern scanning and processing language',
  async exec(ctx: CommandContext) {
    const opts = parseOptions(ctx.args);
    if (typeof opts === 'string') {
      if (opts === '\0version') { ctx.stdout += 'awk (tabcomputer) 1.0, POSIX awk with gawk extensions\n'; return 0; }
      if (opts === '\0usage') { ctx.stdout += USAGE; return 0; }
      ctx.stderr += `awk: ${opts}\n${USAGE}`;
      return 2;
    }

    let stdinUsedForProgram = false;
    let src = '';
    let srcName = 'cmd. line';
    if (opts.sources.length) {
      const parts: string[] = [];
      for (const s of opts.sources) {
        if (!s.startsWith('\0file:')) { parts.push(s); continue; }
        const f = s.slice(6);
        if (f === '-' || f === '/dev/stdin') {
          parts.push(ctx.stdin);
          stdinUsedForProgram = true;
          srcName = '-';
          continue;
        }
        try {
          const data = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8');
          parts.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
          srcName = f;
        } catch {
          ctx.stderr += `awk: fatal: can't open source file \`${f}' for reading: No such file or directory\n`;
          return 2;
        }
      }
      src = parts.join('\n');
    } else {
      if (opts.operands.length === 0) {
        ctx.stderr += USAGE;
        return 2;
      }
      src = opts.operands.shift()!;
    }

    let compiled;
    try {
      const prog = new Parser(src).parseProgram();
      compiled = compileProgram(prog);
    } catch (e) {
      if (e instanceof AwkSyntaxError) {
        ctx.stderr += `awk: ${srcName}:${e.line || 1}: ${e.message}\n`;
        return 1;
      }
      throw e;
    }

    const rt = new Runtime(ctx, stdinUsedForProgram ? '' : () => ctx.stdin);
    const out = ctx;
    let factory: (...a: unknown[]) => { begin: () => Promise<void>; main: () => Promise<void>; end: () => Promise<void>; hasMain: boolean; hasEnd: boolean };
    try {
      factory = new Function('rt', 'h', 'SNc', 'NEXT', 'NEXTFILE', 'ExitSig', compiled.source) as typeof factory;
    } catch (e) {
      ctx.stderr += `awk: internal error: ${e instanceof Error ? e.message : e}\n`;
      return 2;
    }
    const P = factory(rt, rt.h, SN, NEXT, NEXTFILE, ExitSig);

    rt.ARGV.set('0', 'awk');
    opts.operands.forEach((a, i) => rt.ARGV.set(String(i + 1), new SN(a)));
    rt.ARGC = opts.operands.length + 1;
    for (const [k, v] of Object.entries(ctx.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) rt.ENVIRON.set(k, new SN(String(v)));
    }

    let code = 0;
    const finish = () => rt.closeAll();
    try {
      if (opts.fs !== undefined) rt.FS = unescapeString(opts.fs);
      for (const a of opts.assigns) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
        if (!m) { ctx.stderr += `awk: fatal: \`${a}' is not a legal variable name\n`; return 2; }
        rt.assignVar(m[1], rt.cmdlineValue(m[2]));
      }
      let exited = false;
      try {
        await P.begin();
      } catch (e) {
        if (!(e instanceof ExitSig)) throw e;
        exited = true;
        if (e.code !== undefined) code = Math.trunc(e.code) & 0xff;
      }
      if (!exited && (P.hasMain || P.hasEnd)) {
        try {
          for (;;) {
            const r = await rt.nextMainRecord();
            if (r === null) break;
            rt.setRecord(r);
            try {
              await P.main();
            } catch (e) {
              if (e === NEXT) continue;
              if (e === NEXTFILE) { rt.skipFile(); continue; }
              throw e;
            }
          }
        } catch (e) {
          if (!(e instanceof ExitSig)) throw e;
          if (e.code !== undefined) code = Math.trunc(e.code) & 0xff;
        }
      }
      try {
        await P.end();
      } catch (e) {
        if (!(e instanceof ExitSig)) throw e;
        if (e.code !== undefined) code = Math.trunc(e.code) & 0xff;
      }
    } catch (e) {
      if (e instanceof AwkFatal) {
        out.stderr += `awk: cmd. line:1: ${e.kind}: ${e.message}\n`;
        await finish().catch(() => {});
        return e.status;
      }
      if (e === NEXT || e === NEXTFILE) {
        out.stderr += `awk: cmd. line:1: fatal: \`next' used in BEGIN or END action\n`;
        await finish().catch(() => {});
        return 2;
      }
      await finish().catch(() => {});
      out.stderr += `awk: ${e instanceof Error ? e.message : String(e)}\n`;
      return 2;
    }
    await finish();
    return code;
  },
};
