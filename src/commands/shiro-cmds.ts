/**
 * Shiro-specific command implementations.
 *
 * These override unix.ts versions with Shiro FS-aware behavior,
 * or provide browser-specific functionality.
 */
import { Command } from './index';
import { getAssociation } from '../file-associations';

export const rmCmd: Command = {
  name: 'rm',
  description: 'Remove files or directories',
  async exec(ctx) {
    let recursive = false;
    let force = false;
    const files: string[] = [];
    for (const arg of ctx.args) {
      if (arg.startsWith('-')) {
        if (arg.includes('r') || arg.includes('R')) recursive = true;
        if (arg.includes('f')) force = true;
      } else {
        files.push(arg);
      }
    }
    for (const f of files) {
      const resolved = ctx.fs.resolvePath(f, ctx.cwd);
      try { await ctx.fs.rm(resolved, { recursive }); }
      catch (e: any) {
        if (!force) { ctx.stderr += `rm: ${e.message}\n`; return 1; }
      }
    }
    return 0;
  },
};

/**
 * ln — GNU coreutils-compatible: -s -f -n -T -t -v -r -b -i -L -P.
 * The filesystem has no hard links: a "hard link" is a copy of the file
 * (as node's fs.link() and the kernel's link syscall also do).
 */
export const lnCmd: Command = {
  name: 'ln',
  description: 'Create links between files',
  async exec(ctx) {
    const args = ctx.args;
    let symbolic = false, force = false, noDeref = false, noTargetDir = false, verbose = false;
    let relative = false, backup = false, interactive = false, logical = false;
    let suffix = '~';
    let targetDir: string | null = null;
    const operands: string[] = [];
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const usage = (msg: string) => { ctx.stderr += `ln: ${msg}\nTry 'ln --help' for more information.\n`; return 1; };
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!opts || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
      if (a === '--') { opts = false; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = eq >= 0 ? a.slice(eq + 1) : undefined;
        switch (name) {
          case 'symbolic': symbolic = true; break;
          case 'force': force = true; break;
          case 'no-dereference': noDeref = true; break;
          case 'no-target-directory': noTargetDir = true; break;
          case 'target-directory': targetDir = val ?? args[++i] ?? null; if (targetDir === null) return usage(`option '--target-directory' requires an argument`); break;
          case 'verbose': verbose = true; break;
          case 'relative': relative = true; break;
          case 'backup': backup = true; break;
          case 'suffix': suffix = val ?? args[++i] ?? '~'; backup = true; break;
          case 'interactive': interactive = true; break;
          case 'logical': logical = true; break;
          case 'physical': logical = false; break;
          default: return usage(`unrecognized option '${a}'`);
        }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        switch (c) {
          case 's': symbolic = true; break;
          case 'f': force = true; interactive = false; break;
          case 'i': interactive = true; force = false; break;
          case 'n': noDeref = true; break;
          case 'T': noTargetDir = true; break;
          case 'v': verbose = true; break;
          case 'r': relative = true; break;
          case 'b': backup = true; break;
          case 'L': logical = true; break;
          case 'P': logical = false; break;
          case 'd': case 'F': break;
          case 'S': case 't': {
            const v = a.slice(j + 1) || args[++i];
            if (v === undefined) return usage(`option requires an argument -- '${c}'`);
            if (c === 't') targetDir = v; else { suffix = v; backup = true; }
            j = a.length;
            break;
          }
          default: return usage(`invalid option -- '${c}'`);
        }
      }
    }
    if (relative && !symbolic) return usage('cannot do --relative without --symbolic');
    const fs = ctx.fs;
    const lst = async (p: string) => { try { return await fs.lstat(p); } catch { return null; } };
    const stt = async (p: string) => { try { return await fs.stat(p); } catch { return null; } };
    const baseName = (p: string) => { const s = p.replace(/\/+$/, ''); return s === '' ? '/' : s.slice(s.lastIndexOf('/') + 1); };
    const join = (d: string, n: string) => (d.endsWith('/') ? d + n : `${d}/${n}`);

    let pairs: [string, string][];
    if (targetDir !== null) {
      if (noTargetDir) return usage('cannot combine --target-directory and --no-target-directory');
      const st = await stt(fs.resolvePath(targetDir, ctx.cwd));
      if (!st || !st.isDirectory()) { ctx.stderr += `ln: target directory ${q(targetDir)}: ${st ? 'Not a directory' : 'No such file or directory'}\n`; return 1; }
      if (!operands.length) return usage('missing file operand');
      pairs = operands.map((s) => [s, join(targetDir!, baseName(s))]);
    } else {
      if (!operands.length) return usage('missing file operand');
      if (operands.length === 1) {
        pairs = [[operands[0], join('.', baseName(operands[0]))]];
      } else {
        const dest = operands[operands.length - 1];
        const srcs = operands.slice(0, -1);
        const dAbs = fs.resolvePath(dest, ctx.cwd);
        const dl = await lst(dAbs);
        // -n: a symlink to a directory is treated as a file
        const dIsDir = !noTargetDir && !!dl && (dl.isDirectory() || (!noDeref && dl.isSymbolicLink() && !!(await stt(dAbs))?.isDirectory()));
        if (noTargetDir && srcs.length > 1) return usage(`extra operand ${q(operands[2])}`);
        if (srcs.length > 1 && !dIsDir) {
          ctx.stderr += dl ? `ln: target ${q(dest)} is not a directory\n` : `ln: target ${q(dest)}: No such file or directory\n`;
          return 1;
        }
        pairs = srcs.map((s) => [s, dIsDir ? join(dest, baseName(s)) : dest]);
      }
    }

    let status = 0;
    let stdinPos = 0;
    for (const [src, dst] of pairs) {
      const dstAbs = fs.resolvePath(dst, ctx.cwd);
      const srcAbs = fs.resolvePath(src, ctx.cwd);
      let srcSt: any = null;
      if (!symbolic) {
        srcSt = logical ? await stt(srcAbs) : await lst(srcAbs);
        if (!srcSt) { ctx.stderr += `ln: failed to access ${q(src)}: No such file or directory\n`; status = 1; continue; }
        if (srcSt.isDirectory()) { ctx.stderr += `ln: ${src}: hard link not allowed for directory\n`; status = 1; continue; }
      }
      const existing = await lst(dstAbs);
      if (existing) {
        if (!symbolic && (force || interactive || backup)) {
          const a = await fs.realpath(srcAbs).catch(() => srcAbs);
          const b = await fs.realpath(dstAbs).catch(() => dstAbs);
          if (a === b && !existing.isSymbolicLink()) {
            ctx.stderr += `ln: ${q(src)} and ${q(dst)} are the same file\n`; status = 1; continue;
          }
        }
        if (interactive) {
          ctx.stderr += `ln: replace ${q(dst)}? `;
          const rest = (ctx.stdin || '').slice(stdinPos);
          const nl = rest.indexOf('\n');
          const ans = nl < 0 ? rest : rest.slice(0, nl);
          stdinPos += nl < 0 ? rest.length : nl + 1;
          if (!/^\s*[yY]/.test(ans)) continue;
        } else if (!force && !backup) {
          ctx.stderr += `ln: failed to create ${symbolic ? 'symbolic' : 'hard'} link ${q(dst)}: File exists\n`;
          status = 1;
          continue;
        }
        if (existing.isDirectory()) {
          ctx.stderr += `ln: ${q(dst)}: cannot overwrite directory\n`;
          status = 1;
          continue;
        }
        try {
          if (backup) await fs.rename(dstAbs, dstAbs + suffix);
          else await fs.unlink(dstAbs);
        } catch (e: any) {
          ctx.stderr += `ln: cannot remove ${q(dst)}: ${e.message}\n`; status = 1; continue;
        }
      }
      const parent = dstAbs.slice(0, dstAbs.lastIndexOf('/')) || '/';
      const pst = await stt(parent);
      if (!pst || !pst.isDirectory()) {
        ctx.stderr += `ln: failed to create ${symbolic ? 'symbolic' : 'hard'} link ${q(dst)}: ${pst ? 'Not a directory' : 'No such file or directory'}\n`;
        status = 1;
        continue;
      }
      try {
        if (symbolic) {
          let target = src;
          if (relative) {
            // path from the link's directory to the target
            const from = (await fs.realpath(parent).catch(() => parent)).split('/').filter(Boolean);
            const tAbs = srcAbs.split('/').filter(Boolean);
            let k = 0;
            while (k < from.length && k < tAbs.length && from[k] === tAbs[k]) k++;
            target = [...from.slice(k).map(() => '..'), ...tAbs.slice(k)].join('/') || '.';
          }
          await fs.symlink(target, dstAbs);
          if (verbose) ctx.stdout += `${q(dst)} -> ${q(target)}\n`;
        } else {
          if (srcSt.isSymbolicLink()) {
            await fs.symlink(await fs.readlink(srcAbs), dstAbs);
          } else {
            const data = await fs.readFile(srcAbs);
            await fs.writeFile(dstAbs, data, { mode: srcSt.mode & 0o7777 });
            await fs.utimes(dstAbs, srcSt.mtime.getTime(), srcSt.mtime.getTime()).catch(() => {});
          }
          if (verbose) ctx.stdout += `${q(dst)} => ${q(src)}\n`;
        }
      } catch (e: any) {
        ctx.stderr += `ln: failed to create ${symbolic ? 'symbolic' : 'hard'} link ${q(dst)}: ${e.message}\n`;
        status = 1;
      }
    }
    return status;
  },
};

/**
 * hostname (net-tools style): the name, -s short, -f/--fqdn, -d domain,
 * -i/-I addresses, -a aliases, -y NIS domain. Setting it needs root.
 */
export const hostnameCmd: Command = {
  name: 'hostname',
  description: 'Show system hostname',
  async exec(ctx) {
    let name = 'shiro';
    try {
      const t = (await ctx.fs.readFile('/etc/hostname', 'utf8') as string).trim();
      if (t) name = t.split(/\s+/)[0];
    } catch {}
    let mode = 'name';
    const operands: string[] = [];
    for (const a of ctx.args) {
      if (a === '--') continue;
      if (a.startsWith('--')) {
        const map: Record<string, string> = {
          '--short': 's', '--fqdn': 'f', '--long': 'f', '--domain': 'd', '--ip-address': 'i',
          '--all-ip-addresses': 'I', '--alias': 'a', '--all-fqdns': 'A', '--yp': 'y', '--nis': 'y',
          '--file': 'F', '--boot': 'b', '--version': 'V', '--help': 'h',
        };
        if (!map[a]) { ctx.stderr += `hostname: unrecognized option '${a}'\n`; return 255; }
        mode = map[a];
        continue;
      }
      if (a.startsWith('-') && a.length > 1) {
        for (const c of a.slice(1)) {
          if (!'sfdiIaAyFbVh'.includes(c)) { ctx.stderr += `hostname: invalid option -- '${c}'\n`; return 255; }
          mode = c;
        }
        continue;
      }
      operands.push(a);
    }
    const short = name.split('.')[0];
    const domain = name.includes('.') ? name.slice(name.indexOf('.') + 1) : '';
    switch (mode) {
      case 'V': ctx.stdout += 'hostname 3.23\n'; return 0;
      case 'h': ctx.stdout += 'Usage: hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name\n'; return 0;
      case 'F': case 'b':
        ctx.stderr += 'hostname: you must be root to change the host name\n';
        return 1;
    }
    if (operands.length) {
      ctx.stderr += 'hostname: you must be root to change the host name\n';
      return 1;
    }
    switch (mode) {
      case 's': ctx.stdout += short + '\n'; break;
      case 'f': case 'A': ctx.stdout += name + (mode === 'A' ? ' ' : '') + '\n'; break;
      case 'd': ctx.stdout += domain + '\n'; break;
      case 'i': ctx.stdout += '127.0.0.1\n'; break;
      case 'I': ctx.stdout += '127.0.0.1 \n'; break;
      case 'a': ctx.stdout += '\n'; break;
      case 'y': ctx.stderr += 'hostname: Local domain name not set\n'; return 1;
      default: ctx.stdout += name + '\n';
    }
    return 0;
  },
};

export const unameCmd: Command = {
  name: 'uname',
  description: 'Print system information',
  async exec(ctx) {
    const flags = ctx.args.filter(a => a.startsWith('-')).join('');
    const hasAll = flags.includes('a');
    const hasS = flags.includes('s') || (!flags && ctx.args.length === 0);
    const hasM = flags.includes('m');
    const hasN = flags.includes('n');
    const hasR = flags.includes('r');
    const hasV = flags.includes('v');

    if (hasAll) {
      ctx.stdout = 'Shiro shiro 0.1.0 Shiro/WASM browser wasm\n';
      return 0;
    }

    const parts: string[] = [];
    if (hasS) parts.push('Shiro');
    if (hasN) parts.push('shiro');
    if (hasR) parts.push('0.1.0');
    if (hasV) parts.push('Shiro/WASM');
    if (hasM) parts.push('wasm');

    ctx.stdout = (parts.length > 0 ? parts.join(' ') : 'Shiro') + '\n';
    return 0;
  },
};

export const whichCmd: Command = {
  name: 'which',
  description: 'Locate a command',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'which: missing argument\n';
      return 1;
    }
    const name = ctx.args[0];
    const execPath = await ctx.shell.findExecutableInPath(name);
    if (execPath) {
      ctx.stdout = `${execPath}\n`;
      return 0;
    }
    const cmd = ctx.shell.commands.get(name);
    if (cmd) {
      ctx.stdout = `${name}\n`;
      return 0;
    }
    if (ctx.shell.functions?.[name]) {
      ctx.stdout = `${name}: shell function\n`;
      return 0;
    }
    ctx.stderr = `${name} not found\n`;
    return 1;
  },
};

export const typeCmd: Command = {
  name: 'type',
  description: 'Describe a command',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'type: missing argument\n';
      return 1;
    }
    const name = ctx.args[0];
    const cmd = ctx.shell.commands.get(name);
    if (cmd) {
      ctx.stdout = `${name} is a shell builtin\n`;
      return 0;
    }
    if (ctx.shell.functions?.[name]) {
      ctx.stdout = `${name} is a shell function\n`;
      return 0;
    }
    const execPath = await ctx.shell.findExecutableInPath(name);
    if (execPath) {
      ctx.stdout = `${name} is ${execPath}\n`;
      return 0;
    }
    ctx.stderr = `type: ${name}: not found\n`;
    return 1;
  },
};

export const rmdirCmd: Command = {
  name: 'rmdir',
  description: 'Remove empty directories',
  async exec(ctx) {
    for (const arg of ctx.args) {
      const resolved = ctx.fs.resolvePath(arg, ctx.cwd);
      try { await ctx.fs.rmdir(resolved); }
      catch (e: any) { ctx.stderr += `rmdir: ${e.message}\n`; return 1; }
    }
    return 0;
  },
};

export const revCmd: Command = {
  name: 'rev',
  description: 'Reverse lines character-wise',
  async exec(ctx) {
    const input = ctx.stdin || (ctx.args.length ? await ctx.fs.readFile(
      ctx.fs.resolvePath(ctx.args[0], ctx.cwd), 'utf8') as string : '');
    ctx.stdout = input.split('\n').map(l => l.split('').reverse().join('')).join('\n');
    return 0;
  },
};

export const cutCmd: Command = {
  name: 'cut',
  description: 'Remove sections from each line',
  async exec(ctx) {
    let delimiter = '\t';
    let fields: number[] = [];
    let bytes: number[] = [];
    let chars: number[] = [];
    const files: string[] = [];

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-d' && ctx.args[i + 1]) {
        delimiter = ctx.args[++i];
        if (delimiter.length === 0) delimiter = ' ';
      } else if (arg.startsWith('-d')) {
        delimiter = arg.slice(2) || ' ';
      } else if (arg === '-f' && ctx.args[i + 1]) {
        fields = parseRange(ctx.args[++i]);
      } else if (arg.startsWith('-f')) {
        fields = parseRange(arg.slice(2));
      } else if (arg === '-b' && ctx.args[i + 1]) {
        bytes = parseRange(ctx.args[++i]);
      } else if (arg.startsWith('-b')) {
        bytes = parseRange(arg.slice(2));
      } else if (arg === '-c' && ctx.args[i + 1]) {
        chars = parseRange(ctx.args[++i]);
      } else if (arg.startsWith('-c')) {
        chars = parseRange(arg.slice(2));
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    let input = ctx.stdin;
    if (files.length > 0) {
      const parts: string[] = [];
      for (const f of files) {
        const path = ctx.fs.resolvePath(f, ctx.cwd);
        try {
          parts.push(await ctx.fs.readFile(path, 'utf8') as string);
        } catch (e: any) {
          ctx.stderr += `cut: ${f}: ${e.message}\n`;
          return 1;
        }
      }
      input = parts.join('');
    }

    input = input.replace(/\r\n/g, '\n');

    const lines = input.split('\n');
    const output: string[] = [];

    for (const line of lines) {
      if (!line && lines.indexOf(line) === lines.length - 1) continue;

      if (fields.length > 0) {
        const parts = line.split(delimiter);
        const selected = fields.map(f => parts[f - 1] || '').filter(Boolean);
        output.push(selected.join(delimiter));
      } else if (bytes.length > 0 || chars.length > 0) {
        const indices = bytes.length > 0 ? bytes : chars;
        const selected = indices.map(i => line[i - 1] || '').join('');
        output.push(selected);
      } else {
        output.push(line);
      }
    }

    ctx.stdout = output.join('\n') + '\n';
    return 0;
  },
};

function parseRange(spec: string): number[] {
  const result: number[] = [];
  for (const part of spec.split(',')) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= (end || start); i++) result.push(i);
    } else {
      result.push(Number(part));
    }
  }
  return result.filter(n => !isNaN(n) && n > 0);
}

export const shasumCmd: Command = {
  name: 'shasum',
  description: 'Compute SHA checksums',
  async exec(ctx) {
    let algorithm = '1';
    const files: string[] = [];

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-a' && ctx.args[i + 1]) {
        algorithm = ctx.args[++i];
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    const algoMap: Record<string, string> = {
      '1': 'SHA-1',
      '256': 'SHA-256',
      '384': 'SHA-384',
      '512': 'SHA-512',
    };

    const cryptoAlgo = algoMap[algorithm];
    if (!cryptoAlgo) {
      ctx.stderr = `shasum: unrecognized algorithm: ${algorithm}\n`;
      return 1;
    }

    const processData = async (data: Uint8Array, name: string) => {
      const hashBuffer = await crypto.subtle.digest(cryptoAlgo, data as BufferSource);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      ctx.stdout += `${hashHex}  ${name}\n`;
    };

    if (files.length === 0 || files.includes('-')) {
      const data = new TextEncoder().encode(ctx.stdin);
      await processData(data, '-');
    }

    for (const file of files) {
      if (file === '-') continue;
      const resolved = ctx.fs.resolvePath(file, ctx.cwd);
      try {
        const content = await ctx.fs.readFile(resolved);
        const data = typeof content === 'string'
          ? new TextEncoder().encode(content)
          : (content instanceof Uint8Array ? content : new Uint8Array(content));
        await processData(data, file);
      } catch (e: any) {
        ctx.stderr += `shasum: ${file}: ${e.message}\n`;
        return 1;
      }
    }

    return 0;
  },
};

export const sha256sumCmd: Command = {
  name: 'sha256sum',
  description: 'Compute SHA-256 checksums',
  async exec(ctx) {
    const newCtx = { ...ctx, args: ['-a', '256', ...ctx.args] };
    return shasumCmd.exec(newCtx);
  },
};

export const openCmd: Command = {
  name: 'open',
  description: 'Open files, directories, or URLs',
  async exec(ctx) {
    let app: string | null = null;
    const targets: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      if (ctx.args[i] === '-a' && ctx.args[i + 1]) { app = ctx.args[++i]; continue; }
      targets.push(ctx.args[i]);
    }
    if (targets.length === 0) {
      ctx.stderr = 'Usage: open [-a app] <file|url>\n';
      return 1;
    }

    for (const target of targets) {
      // URL?
      if (/^https?:\/\//.test(target)) {
        // Intercept OAuth URLs — rewrite redirect_uri for manual code flow
        // and show clickable links instead of opening a window that won't work
        if (target.includes('claude.ai/oauth/')) {
          const fixedUrl = target.replace(
            /redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2F[^&]*/,
            'redirect_uri=' + encodeURIComponent('https://platform.claude.com/oauth/code/callback')
          );
          if (ctx.terminal) {
            const openBtn = `\x1b]8;;${fixedUrl}\x07\x1b[1;36m[ Open in Browser ]\x1b[0m\x1b]8;;\x07`;
            ctx.terminal.writeOutput(`\r\n  ${openBtn}\r\n`);
          } else {
            if (typeof window !== 'undefined') window.open(fixedUrl, '_blank');
          }
          continue;
        }
        if (typeof window !== 'undefined') window.open(target, '_blank');
        continue;
      }
      // File or directory
      const resolved = ctx.fs.resolvePath(target, ctx.cwd);
      const stat = await ctx.fs.stat(resolved).catch(() => null);
      if (!stat) {
        ctx.stderr += `open: ${target}: No such file or directory\n`;
        return 1;
      }

      const cmd = app || (stat.type === 'dir' ? 'code' : getAssociation(target)) || 'code';
      const escaped = resolved.replace(/"/g, '\\"');
      await ctx.shell.execute(
        `${cmd} "${escaped}"`,
        (d: string) => { ctx.stdout += d; },
        (d: string) => { ctx.stderr += d; },
      );
    }
    return 0;
  },
};

/**
 * Shiro-specific commands. Registered AFTER unix commands so they
 * take precedence where needed (rm, find, ln, etc.).
 */
export const shiroCmds: Command[] = [
  rmCmd, lnCmd,
  hostnameCmd, unameCmd,
  whichCmd, typeCmd,
  rmdirCmd, revCmd,
  // cut: src/commands/cut.ts (GNU-compatible) is the registered one
  // sha256sum: src/commands/checksum.ts (registered from unix.ts)
  shasumCmd,
  openCmd, { name: 'xdg-open', description: 'Open a URL in the browser', exec: (ctx) => openCmd.exec(ctx) },
];
