import type { Command, CommandContext } from './index';
import { quoteArgsForShell } from '../shell';

/**
 * xargs — GNU findutils-compatible.
 *
 * Input is split on whitespace with '…', "…" and backslash quoting (or on NUL
 * with -0, a single delimiter with -d, whole lines with -I). Commands run with
 * argv (no re-parsing), batched by -n/-L/-s. Exit status follows GNU: 123 if
 * any command exited 1-125, 124 if one exited 255, 126/127 if it could not run.
 */

const DEFAULT_SIZE = 131072;

function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** -d argument: a single character, or a C escape */
function parseDelim(s: string): string | null {
  if (s.length === 1) return s;
  if (s[0] !== '\\') return null;
  const simple: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
  if (s.length === 2 && simple[s[1]] !== undefined) return simple[s[1]];
  let m = /^\\x([0-9a-fA-F]{1,2})$/.exec(s);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^\\([0-7]{1,3})$/.exec(s);
  if (m) return String.fromCharCode(parseInt(m[1], 8));
  return null;
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
const isBlank = (c: string) => c === ' ' || c === '\t';

interface Item { arg: string; /** number of input lines ended by this item (for -L) */ eol: boolean }

class XargsError extends Error {}

/** Split default-mode input (quotes, backslashes, EOF string) */
function splitQuoted(input: string, eofStr: string | null, replaceMode: boolean, items: Item[] = []): Item[] {
  let cur = '';
  let have = false; // an argument is in progress (possibly empty quoted)
  let state: 'space' | 'norm' | 'quote' | 'backslash' = 'space';
  let quote = '';
  let prev = '';
  const finish = (eol: boolean): boolean => {
    if (eofStr !== null && cur === eofStr) return false;
    items.push({ arg: cur, eol });
    cur = ''; have = false;
    return true;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    switch (state) {
      case 'space':
        if (isSpace(c)) { prev = c; continue; }
        state = 'norm';
      // fallthrough
      case 'norm':
        if (c === '\n') {
          if (!have && cur === '') { state = 'space'; prev = c; continue; }
          if (!finish(!isBlank(prev))) return items;
          state = 'space'; prev = c;
          continue;
        }
        if (!replaceMode && isSpace(c)) {
          if (!finish(false)) return items;
          state = 'space'; prev = c;
          continue;
        }
        if (c === '\\') { state = 'backslash'; prev = c; continue; }
        if (c === "'" || c === '"') { state = 'quote'; quote = c; have = true; prev = c; continue; }
        cur += c; have = true; prev = c;
        continue;
      case 'quote':
        if (c === '\n') throw new XargsError(`unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`);
        if (c === quote) { state = 'norm'; prev = c; continue; }
        cur += c; prev = c;
        continue;
      case 'backslash':
        cur += c; have = true; state = 'norm'; prev = c;
        continue;
    }
  }
  if (state === 'quote') throw new XargsError(`unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`);
  if (have || cur !== '') finish(true);
  return items;
}

/** Split on a single delimiter (-0, -d): no quoting, every field is an argument */
function splitDelim(input: string, delim: string, eofStr: string | null): Item[] {
  const parts = input.split(delim);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  const items: Item[] = [];
  for (const p of parts) {
    if (eofStr !== null && p === eofStr) break;
    items.push({ arg: p, eol: true });
  }
  return items;
}

async function runArgv(ctx: CommandContext, argv: string[], out: { stdout: string; stderr: string }): Promise<number> {
  const child = ctx.shell.fork();
  if (ctx.terminal) (child as any).setTerminal?.(ctx.terminal);
  child.cwd = ctx.cwd;
  child.env = { ...ctx.env };
  child.options.delete('errexit');
  const name = argv[0];
  if (!name.includes('/') && !ctx.shell.commands.get(name) && !ctx.shell.functions[name] &&
      !(await ctx.shell.findExecutableInPath(name))) {
    out.stderr += `xargs: ${name}: No such file or directory\n`;
    return 127;
  }
  let o = '';
  let e = '';
  let code: number;
  try {
    code = await child.executeWithStdin(quoteArgsForShell(argv), '', (s) => { o += s; }, (s) => { e += s; });
  } catch (err: any) {
    e += `xargs: ${argv[0]}: ${err?.message ?? err}\n`;
    code = 126;
  }
  out.stdout += o.replace(/\r\n/g, '\n');
  out.stderr += e.replace(/\r\n/g, '\n');
  return code;
}

export const xargs: Command = {
  name: 'xargs',
  description: 'Build and execute command lines from stdin',
  async exec(ctx) {
    const args = ctx.args;
    let nullDelim = false;
    let delim: string | null = null;
    let eofStr: string | null = null;
    let replace: string | null = null;
    let maxArgs: number | null = null;
    let maxLines: number | null = null;
    let maxSize: number | null = null;
    let verbose = false;
    let noRunIfEmpty = false;
    let exitOnSize = false;
    let argFile: string | null = null;
    let i = 0;
    const err = (msg: string, code = 1) => { ctx.stderr += `xargs: ${msg}\n`; return code; };
    const num = (opt: string, v: string, min: number): number => {
      if (!/^\s*[+-]?\d+$/.test(v)) throw new XargsError(`invalid number "${v}" for -${opt} option`);
      const n = parseInt(v, 10);
      if (n < min) throw new XargsError(`value ${v} for -${opt} option should be >= ${min}`);
      return n;
    };
    try {
      for (; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { i++; break; }
        if (!a.startsWith('-') || a === '-') break;
        if (a.startsWith('--')) {
          const eq = a.indexOf('=');
          const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
          const v = eq >= 0 ? a.slice(eq + 1) : undefined;
          const need = () => {
            if (v !== undefined) return v;
            if (i + 1 >= args.length) throw new XargsError(`option '--${name}' requires an argument`);
            return args[++i];
          };
          switch (name) {
            case 'null': nullDelim = true; break;
            case 'delimiter': { const d = parseDelim(need()); if (d === null) throw new XargsError('invalid delimiter'); delim = d; break; }
            case 'eof': eofStr = v ?? null; if (eofStr === '') eofStr = null; break;
            case 'replace': replace = v ?? '{}'; maxLines = 1; maxArgs = null; exitOnSize = true; break;
            case 'max-args': maxArgs = num('n', need(), 1); maxLines = null; break;
            case 'max-lines': maxLines = v === undefined ? 1 : num('L', v, 1); maxArgs = null; break;
            case 'max-chars': maxSize = num('s', need(), 1); break;
            case 'verbose': verbose = true; break;
            case 'no-run-if-empty': noRunIfEmpty = true; break;
            case 'exit': exitOnSize = true; break;
            case 'arg-file': argFile = need(); break;
            case 'max-procs': need(); break;
            case 'interactive': case 'open-tty': case 'show-limits': break;
            case 'process-slot-var': need(); break;
            default: return err(`unrecognized option '${a}'\nUsage: xargs [OPTION]... COMMAND [INITIAL-ARGS]...`);
          }
          continue;
        }
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          const rest = a.slice(j + 1);
          const need = () => {
            j = a.length;
            if (rest) return rest;
            if (i + 1 >= args.length) throw new XargsError(`option requires an argument -- '${c}'`);
            return args[++i];
          };
          switch (c) {
            case '0': nullDelim = true; break;
            case 'd': { const d = parseDelim(need()); if (d === null) throw new XargsError('invalid delimiter'); delim = d; break; }
            case 'E': { const v = need(); eofStr = v === '' ? null : v; break; }
            case 'e': eofStr = rest === '' ? null : rest; j = a.length; break;
            case 'I': replace = need(); maxLines = 1; maxArgs = null; exitOnSize = true; break;
            case 'i': replace = rest || '{}'; j = a.length; maxLines = 1; maxArgs = null; exitOnSize = true; break;
            case 'n': maxArgs = num('n', need(), 1); if (replace === null) maxLines = null; break;
            case 'L': maxLines = num('L', need(), 1); maxArgs = null; break;
            case 'l': maxLines = rest ? num('l', rest, 1) : 1; j = a.length; maxArgs = null; break;
            case 's': maxSize = num('s', need(), 1); break;
            case 't': verbose = true; break;
            case 'r': noRunIfEmpty = true; break;
            case 'x': exitOnSize = true; break;
            case 'a': argFile = need(); break;
            case 'P': need(); break;
            case 'p': case 'o': break;
            default: return err(`invalid option -- '${c}'\nUsage: xargs [OPTION]... COMMAND [INITIAL-ARGS]...`);
          }
        }
      }
    } catch (e: any) {
      if (e instanceof XargsError) return err(e.message);
      throw e;
    }
    const cmd = args.slice(i);
    if (!cmd.length) cmd.push('echo');

    let input = ctx.stdin || '';
    if (argFile !== null) {
      try { input = await ctx.fs.readFile(ctx.fs.resolvePath(argFile, ctx.cwd), 'utf8') as string; }
      catch { return err(`${argFile}: No such file or directory`); }
    }

    let items: Item[];
    let inputError: string | null = null;
    if (nullDelim) items = splitDelim(input, '\0', eofStr);
    else if (delim !== null) items = splitDelim(input, delim, eofStr);
    else {
      // On a quoting error GNU still runs the command with the arguments read before it
      const partial: Item[] = [];
      try { items = splitQuoted(input, eofStr, replace !== null, partial); }
      catch (e: any) {
        if (!(e instanceof XargsError)) throw e;
        inputError = e.message;
        items = partial;
      }
    }

    const limit = Math.min(maxSize ?? DEFAULT_SIZE, DEFAULT_SIZE);
    const baseSize = cmd.reduce((n, a) => n + utf8Len(a) + 1, 0);
    const out = { stdout: '', stderr: '' };
    let status = 0;

    const run = async (argv: string[]): Promise<boolean> => {
      if (verbose) out.stderr += argv.join(' ') + '\n';
      const code = await runArgv(ctx, argv, out);
      if (code === 255) {
        out.stderr += `xargs: ${argv[0]}: exited with status 255; aborting\n`;
        status = 124;
        return false;
      }
      if (code === 126 || code === 127) { status = code; return false; }
      if (code >= 128) { status = 125; return false; }
      if (code !== 0) status = 123;
      return true;
    };
    const flush = () => { ctx.stdout += out.stdout; ctx.stderr += out.stderr; out.stdout = ''; out.stderr = ''; };

    if (replace !== null) {
      for (const it of items) {
        const argv = cmd.map((a) => a.split(replace!).join(it.arg));
        if (argv.reduce((n, a) => n + utf8Len(a) + 1, 0) > limit) {
          flush();
          return err('argument line too long');
        }
        if (!(await run(argv))) break;
      }
      flush();
      if (inputError !== null) { ctx.stderr += `xargs: ${inputError}\n`; return 1; }
      return status;
    }

    if (!items.length) {
      if (inputError !== null) { ctx.stderr += `xargs: ${inputError}\n`; return 1; }
      if (!noRunIfEmpty) await run(cmd);
      flush();
      return status;
    }

    if (baseSize > limit) {
      return err(`argument list too long`);
    }

    let k = 0;
    while (k < items.length) {
      const batch: string[] = [];
      let size = baseSize;
      let lines = 0;
      while (k < items.length) {
        const it = items[k];
        const sz = utf8Len(it.arg) + 1;
        if (size + sz > limit) {
          if (!batch.length || exitOnSize) {
            flush();
            return err('argument line too long');
          }
          break;
        }
        batch.push(it.arg);
        size += sz;
        k++;
        if (maxArgs !== null && batch.length >= maxArgs) break;
        if (maxLines !== null && it.eol && ++lines >= maxLines) break;
      }
      if (!(await run([...cmd, ...batch]))) break;
    }
    flush();
    if (inputError !== null) { ctx.stderr += `xargs: ${inputError}\n`; return 1; }
    return status;
  },
};
