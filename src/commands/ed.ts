import { Command } from './index';

export const edCmd: Command = {
  name: 'ed',
  description: 'Line editor',
  async exec(ctx) {
    const file = ctx.args[0] || '';
    let buffer: string[] = [];
    let current = 0;
    let dirty = false;
    let filename = file;

    // Load file if specified
    if (filename) {
      const resolved = ctx.fs.resolvePath(filename, ctx.cwd);
      try {
        const data = await ctx.fs.readFile(resolved);
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        buffer = text.split('\n');
        // Remove trailing empty line from split
        if (buffer.length > 0 && buffer[buffer.length - 1] === '') buffer.pop();
        current = buffer.length;
        ctx.stdout += `${new TextEncoder().encode(text).length}\n`;
      } catch {
        ctx.stdout += `${filename}: No such file or directory\n`;
      }
    }

    // Process commands from stdin (pipe mode)
    const lines = ctx.stdin ? ctx.stdin.split('\n') : [];
    let li = 0;

    function getLine(): string | null {
      if (li >= lines.length) return null;
      return lines[li++];
    }

    function parseAddr(addr: string): number {
      if (addr === '.') return current;
      if (addr === '$') return buffer.length;
      if (/^\d+$/.test(addr)) return parseInt(addr);
      if (addr.startsWith('/') && addr.endsWith('/')) {
        const pat = new RegExp(addr.slice(1, -1));
        for (let i = current; i < buffer.length; i++) {
          if (pat.test(buffer[i])) return i + 1;
        }
        for (let i = 0; i < current; i++) {
          if (pat.test(buffer[i])) return i + 1;
        }
      }
      return current;
    }

    function parseRange(cmd: string): { start: number; end: number; op: string } {
      // Match address,address or %
      if (cmd.startsWith('%')) {
        return { start: 1, end: buffer.length, op: cmd.slice(1) };
      }
      const m = cmd.match(/^(\d+|\$|\.|\/.+?\/)?,?(\d+|\$|\.|\/.+?\/)?(.*)$/);
      if (!m) return { start: current, end: current, op: cmd };
      const op = m[3] || '';
      if (m[1] && m[2]) {
        return { start: parseAddr(m[1]), end: parseAddr(m[2]), op };
      }
      if (m[1]) {
        const addr = parseAddr(m[1]);
        return { start: addr, end: addr, op };
      }
      return { start: current, end: current, op };
    }

    while (true) {
      const line = getLine();
      if (line === null) break;
      const trimmed = line.trim();
      if (trimmed === '') continue;

      const { start, end, op } = parseRange(trimmed);
      const cmd = op.trim() || trimmed;

      switch (cmd[0]) {
        case 'q': {
          if (cmd === 'Q' || !dirty) return 0;
          // q with dirty buffer — just quit in pipe mode
          return 0;
        }

        case 'w': {
          const wFile = cmd.slice(1).trim() || filename;
          if (!wFile) {
            ctx.stderr += '?\n';
            continue;
          }
          filename = wFile;
          const text = buffer.join('\n') + '\n';
          const resolved = ctx.fs.resolvePath(filename, ctx.cwd);
          await ctx.fs.writeFile(resolved, text);
          ctx.stdout += `${new TextEncoder().encode(text).length}\n`;
          dirty = false;
          if (cmd.startsWith('wq')) return 0;
          break;
        }

        case 'p': {
          for (let i = start - 1; i < end && i < buffer.length; i++) {
            ctx.stdout += buffer[i] + '\n';
          }
          current = Math.min(end, buffer.length);
          break;
        }

        case 'n': {
          for (let i = start - 1; i < end && i < buffer.length; i++) {
            ctx.stdout += `${i + 1}\t${buffer[i]}\n`;
          }
          current = Math.min(end, buffer.length);
          break;
        }

        case 'd': {
          buffer.splice(start - 1, end - start + 1);
          current = Math.min(start, buffer.length);
          dirty = true;
          break;
        }

        case 'a': {
          const newLines: string[] = [];
          while (true) {
            const l = getLine();
            if (l === null || l === '.') break;
            newLines.push(l);
          }
          buffer.splice(start, 0, ...newLines);
          current = start + newLines.length;
          dirty = true;
          break;
        }

        case 'i': {
          const newLines: string[] = [];
          while (true) {
            const l = getLine();
            if (l === null || l === '.') break;
            newLines.push(l);
          }
          buffer.splice(start - 1, 0, ...newLines);
          current = start - 1 + newLines.length;
          dirty = true;
          break;
        }

        case 'c': {
          const newLines: string[] = [];
          while (true) {
            const l = getLine();
            if (l === null || l === '.') break;
            newLines.push(l);
          }
          buffer.splice(start - 1, end - start + 1, ...newLines);
          current = start - 1 + newLines.length;
          dirty = true;
          break;
        }

        case 's': {
          // s/pattern/replacement/flags
          const delim = cmd[1];
          if (!delim) break;
          const parts = cmd.slice(2).split(delim);
          const pattern = parts[0] || '';
          const replacement = parts[1] || '';
          const flags = parts[2] || '';
          const globalFlag = flags.includes('g');
          const re = new RegExp(pattern, globalFlag ? 'g' : '');

          for (let i = start - 1; i < end && i < buffer.length; i++) {
            buffer[i] = buffer[i].replace(re, replacement);
          }
          current = end;
          dirty = true;
          break;
        }

        case 'e': {
          const eFile = cmd.slice(1).trim() || filename;
          if (!eFile) { ctx.stderr += '?\n'; continue; }
          filename = eFile;
          const resolved = ctx.fs.resolvePath(filename, ctx.cwd);
          try {
            const data = await ctx.fs.readFile(resolved);
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
            buffer = text.split('\n');
            if (buffer.length > 0 && buffer[buffer.length - 1] === '') buffer.pop();
            current = buffer.length;
            ctx.stdout += `${new TextEncoder().encode(text).length}\n`;
            dirty = false;
          } catch {
            ctx.stderr += `${filename}: No such file or directory\n`;
          }
          break;
        }

        case 'r': {
          const rFile = cmd.slice(1).trim();
          if (!rFile) { ctx.stderr += '?\n'; continue; }
          const resolved = ctx.fs.resolvePath(rFile, ctx.cwd);
          try {
            const data = await ctx.fs.readFile(resolved);
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const rLines = text.split('\n');
            if (rLines.length > 0 && rLines[rLines.length - 1] === '') rLines.pop();
            buffer.splice(current, 0, ...rLines);
            current += rLines.length;
            ctx.stdout += `${new TextEncoder().encode(text).length}\n`;
            dirty = true;
          } catch {
            ctx.stderr += `${rFile}: No such file or directory\n`;
          }
          break;
        }

        case '=': {
          ctx.stdout += `${buffer.length}\n`;
          break;
        }

        default: {
          // Bare number — set current line
          if (/^\d+$/.test(cmd)) {
            current = parseInt(cmd);
            if (current > 0 && current <= buffer.length) {
              ctx.stdout += buffer[current - 1] + '\n';
            }
          } else {
            ctx.stderr += '?\n';
          }
        }
      }
    }
    return 0;
  },
};
