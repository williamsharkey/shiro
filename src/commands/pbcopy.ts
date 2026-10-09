/**
 * pbcopy / pbpaste / xclip / xsel / wl-copy on the browser clipboard.
 *
 * Programs like Claude Code shell out to these to copy and paste. Native
 * Claude Code probes xclip, then xsel, before falling back to a native
 * clipboard addon that hangs under the x86 emulator, so xclip and xsel
 * answer everything they're asked: text only, and a read that can't be
 * done (no permission, an image target) prints nothing instead of failing
 * into that fallback.
 *
 *   echo hi | pbcopy        xclip -selection clipboard -o        xsel -b -i
 */

import { Command, CommandContext } from './index';
import { copyText } from '../utils/osc52';

async function readClipboard(): Promise<string> {
  try { return (await navigator.clipboard?.readText?.()) ?? ''; } catch { return ''; }
}

async function copyStdin(ctx: CommandContext, name: string): Promise<number> {
  if (ctx.args.includes('-o') || ctx.args.includes('--paste')) {
    ctx.stdout += await readClipboard();
    return 0;
  }
  copyText(ctx.stdin || '');
  return 0;
}

const make = (name: string): Command => ({
  name,
  description: 'Copy stdin to the clipboard',
  exec: (ctx) => copyStdin(ctx, name),
});

export const pbcopyCmd = make('pbcopy');
export const wlCopyCmd = make('wl-copy');

export const pbpasteCmd: Command = {
  name: 'pbpaste',
  description: 'Print the clipboard',
  async exec(ctx) { ctx.stdout += await readClipboard(); return 0; },
};

const TEXT_TARGETS = ['TARGETS', 'UTF8_STRING', 'STRING', 'TEXT', 'text/plain', 'text/plain;charset=utf-8'];

export const xclipCmd: Command = {
  name: 'xclip',
  description: 'Copy to or paste from the clipboard (xclip-compatible, text only)',
  async exec(ctx) {
    let out = false;
    let target: string | null = null;
    const files: string[] = [];
    const a = ctx.args;
    for (let i = 0; i < a.length; i++) {
      const arg = a[i].replace(/^--/, '-');
      if (/^-o(ut)?$/.test(arg)) out = true;
      else if (/^-(i(n)?|f(ilter)?|silent|quiet|verbose|noutf8|r(mlastnl)?)$/.test(arg)) { /* the defaults */ }
      else if (/^-(sel(ection)?|d(isplay)?|l(oops)?)$/.test(arg)) i++; // one clipboard
      else if (/^-t(arget)?$/.test(arg)) target = a[++i] ?? null;
      else if (arg === '-h' || arg === '-help') {
        ctx.stdout += 'Usage: xclip [-i|-o] [-selection clipboard|primary] [-t target] [file ...]\n'
          + 'Copies stdin or files to the clipboard, or prints it with -o (text only).\n';
        return 0;
      } else if (arg === '-version') { ctx.stdout += 'xclip version 0.13 (tabcomputer: the browser clipboard)\n'; return 0; }
      else if (a[i].startsWith('-') && a[i] !== '-') { ctx.stderr += `xclip: unknown option ${a[i]}\n`; return 1; }
      else files.push(a[i]);
    }
    if (out) {
      if (target === 'TARGETS') { ctx.stdout += TEXT_TARGETS.join('\n') + '\n'; return 0; }
      if (target && !/^(UTF8_STRING|STRING|TEXT|text\/plain)/i.test(target)) {
        ctx.stderr += `Error: target ${target} not available\n`;
        return 1;
      }
      ctx.stdout += await readClipboard();
      return 0;
    }
    let text = files.length ? '' : ctx.stdin;
    for (const f of files) {
      try { text += await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string; } catch {
        ctx.stderr += `xclip: ${f}: No such file or directory\n`;
        return 1;
      }
    }
    copyText(text);
    return 0;
  },
};

export const xselCmd: Command = {
  name: 'xsel',
  description: 'Copy to or paste from the clipboard (xsel-compatible, text only)',
  async exec(ctx) {
    let mode: 'in' | 'out' | 'clear' | null = null;
    for (const arg of ctx.args) {
      if (arg === '-i' || arg === '--input') mode = 'in';
      else if (arg === '-o' || arg === '--output') mode = 'out';
      else if (arg === '-c' || arg === '--clear' || arg === '-d' || arg === '--delete') mode = 'clear';
      else if (arg === '-h' || arg === '--help') {
        ctx.stdout += 'Usage: xsel [-b|-p|-s] [-i|-o|-c]\nCopies stdin to the clipboard (-i) or prints it (-o; the default when nothing is piped in).\n';
        return 0;
      } else if (arg === '--version') { ctx.stdout += 'xsel version 1.2 (tabcomputer: the browser clipboard)\n'; return 0; }
      else if (/^-[bpsakfnvtl]+$|^--(clipboard|primary|secondary|append|keep|follow|nodetach|verbose|logfile|display|selectionTimeout|trim)/.test(arg)) { /* one clipboard */ }
      else { ctx.stderr += `xsel: unknown option ${arg}\n`; return 1; }
    }
    if (mode === null) mode = ctx.stdin ? 'in' : 'out';
    if (mode === 'out') { ctx.stdout += await readClipboard(); return 0; }
    copyText(mode === 'clear' ? '' : ctx.stdin);
    return 0;
  },
};
