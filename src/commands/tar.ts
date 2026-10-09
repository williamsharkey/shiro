import type { Command, CommandContext } from './index';
import { decodeBytes, encodeText } from '../utils/byte-text';

/**
 * tar — GNU tar-compatible (GNU format archives: ustar headers with
 * ././@LongLink entries for long names).
 *
 *   tar -c|-x|-t|-r [OPTIONS] [-f ARCHIVE] [FILE...]
 *
 * Old-style bundled options (`tar czf a.tgz dir`, `tar Ox`) are accepted.
 * -f - (the default) is stdin/stdout. Options: -C DIR, -v, -z -j -J --zstd
 * -a, -O, -k, --overwrite, -m, -p, -h, -P, -X FILE, --exclude=PAT, -T FILE,
 * --strip-components=N, --no-recursion, --wildcards. Regular files,
 * directories, symlinks and hard links (extracted as copies; the filesystem
 * has none) are supported. Errors follow GNU: exit 2 with "Exiting with
 * failure status due to previous errors".
 */

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Header {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number; // seconds
  type: string; // '0' file, '1' hard link, '2' symlink, '5' dir, ...
  linkname: string;
  uname: string;
  gname: string;
}

function octal(n: number, width: number): string {
  return Math.max(0, Math.floor(n)).toString(8).padStart(width - 1, '0') + '\0';
}

function rawHeader(h: Header): Uint8Array {
  const b = new Uint8Array(BLOCK);
  const put = (s: string | Uint8Array, off: number, len: number) => b.set((typeof s === 'string' ? enc.encode(s) : s).slice(0, len), off);
  put(h.name, 0, 100);
  put(octal(h.mode & 0o7777, 8), 100, 8);
  put(octal(h.uid, 8), 108, 8);
  put(octal(h.gid, 8), 116, 8);
  put(octal(h.size, 12), 124, 12);
  put(octal(h.mtime, 12), 136, 12);
  b.fill(0x20, 148, 156);
  b[156] = h.type.charCodeAt(0);
  put(h.linkname, 157, 100);
  put('ustar  \0', 257, 8); // GNU magic + version
  put(h.uname, 265, 32);
  put(h.gname, 297, 32);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return b;
}

/** Header blocks for an entry, with GNU long name/link records when needed */
function headerBlocks(h: Header): Uint8Array[] {
  const out: Uint8Array[] = [];
  const long = (type: 'L' | 'K', text: string) => {
    const data = enc.encode(text + '\0');
    out.push(rawHeader({ name: '././@LongLink', mode: 0o644, uid: 0, gid: 0, size: data.length, mtime: 0, type, linkname: '', uname: 'root', gname: 'root' }));
    out.push(...dataBlocks(data));
  };
  if (enc.encode(h.linkname).length > 100) long('K', h.linkname);
  if (enc.encode(h.name).length > 100) long('L', h.name);
  out.push(rawHeader(h));
  return out;
}

function dataBlocks(data: Uint8Array): Uint8Array[] {
  if (!data.length) return [];
  const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  padded.set(data);
  return [padded];
}

function field(b: Uint8Array, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return dec.decode(z >= 0 ? s.subarray(0, z) : s);
}

function parseOctal(b: Uint8Array, off: number, len: number): number {
  // base-256 (GNU) for large values
  if (b[off] & 0x80) {
    let n = b[off] & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + b[off + i];
    return n;
  }
  const s = field(b, off, len).trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

function checksumOk(b: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : b[i];
  const stored = parseOctal(b, 148, 8);
  return stored === sum;
}

function isZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i]) return false;
  return true;
}

class TarFatal extends Error {}

async function streamTransform(data: Uint8Array, stream: any): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  writer.write(data as any).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

type Compression = 'gzip' | 'bzip2' | 'xz' | 'zstd' | null;

function sniff(d: Uint8Array): Compression {
  if (d[0] === 0x1f && d[1] === 0x8b) return 'gzip';
  if (d[0] === 0x42 && d[1] === 0x5a && d[2] === 0x68) return 'bzip2';
  if (d[0] === 0xfd && d[1] === 0x37 && d[2] === 0x7a && d[3] === 0x58) return 'xz';
  if (d[0] === 0x28 && d[1] === 0xb5 && d[2] === 0x2f && d[3] === 0xfd) return 'zstd';
  return null;
}

async function decompress(d: Uint8Array, c: Compression): Promise<Uint8Array> {
  switch (c) {
    case 'gzip': return (await import('./compress/gzip-codec')).gunzip(d); // multi-member .tgz too
    case 'bzip2': return (await import('./bzip2')).bzip2Decompress(d);
    case 'xz': return (await import('./xz')).xzDecompress(d);
    case 'zstd': return (await import('./zstd')).zstdDecompress(d);
    default: return d;
  }
}

async function compress(d: Uint8Array, c: Compression): Promise<Uint8Array> {
  switch (c) {
    case 'gzip': return streamTransform(d, new (globalThis as any).CompressionStream('gzip'));
    case 'bzip2': return new Uint8Array((await import('./bzip2')).bzip2Compress(d));
    case 'xz': case 'zstd': throw new TarFatal(`${c} compression is not supported`);
    default: return d;
  }
}

/** Bytes of stdin text: latin1 when that makes an archive (binary piped from gzip), else UTF-8 */
function stdinBytes(s: string): Uint8Array {
  let latin = true;
  for (let i = 0; i < s.length && latin; i++) if (s.charCodeAt(i) > 0xff) latin = false;
  if (latin) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    if (sniff(b) || (b.length >= BLOCK && checksumOk(b.subarray(0, BLOCK)))) return b;
  }
  return encodeText(s);
}

/** Archive bytes for stdout: byte-exact (src/utils/byte-text.ts) */
const latin1 = decodeBytes;

/** fnmatch-style glob (with GNU tar's defaults: '*' matches '/') */
function globRe(p: string): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) { re += '\\' + p[++i]; continue; }
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end < 0) { re += '\\['; continue; }
      let body = p.slice(i + 1, end);
      if (body[0] === '!') body = '^' + body.slice(1);
      re += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += /[.+^${}()|\\/]/.test(c) ? '\\' + c : c;
  }
  return new RegExp(`^${re}$`);
}

const MODE_CHARS = (type: string, mode: number) => {
  const t = type === '5' ? 'd' : type === '2' ? 'l' : type === '1' ? 'h' : type === '3' ? 'c' : type === '4' ? 'b' : type === '6' ? 'p' : '-';
  const rwx = (b: number, s: boolean, sc: string) => `${b & 4 ? 'r' : '-'}${b & 2 ? 'w' : '-'}${s ? (b & 1 ? sc : sc.toUpperCase()) : b & 1 ? 'x' : '-'}`;
  return (t === 'h' ? '-' : t) + rwx((mode >> 6) & 7, !!(mode & 0o4000), 's') + rwx((mode >> 3) & 7, !!(mode & 0o2000), 's') + rwx(mode & 7, !!(mode & 0o1000), 't');
};

const p2 = (n: number) => String(n).padStart(2, '0');

export const tar: Command = {
  name: "tar",
  description: "Archive utility (GNU tar format)",
  async exec(ctx) {
    try {
      return await runTar(ctx);
    } catch (e: any) {
      if (e instanceof TarFatal) {
        ctx.stderr += `tar: ${e.message}\n`;
        return 2;
      }
      ctx.stderr += `tar: ${e?.message ?? e}\n`;
      return 2;
    }
  },
};

async function runTar(ctx: CommandContext): Promise<number> {
  let args = [...ctx.args];
  // Old-style bundled options: the first word without '-' holds letters whose
  // arguments follow in order (tar cvf out.tar dir)
  if (args.length && !args[0].startsWith('-') && /^[A-Za-z]+$/.test(args[0])) {
    const letters = args[0];
    const rest = args.slice(1);
    const expanded: string[] = [];
    for (const c of letters) {
      expanded.push('-' + c);
      if ('fCXTbgLNV'.includes(c)) {
        if (!rest.length) throw new TarFatal(`Old option '${c}' requires an argument.\nTry 'tar --help' or 'tar --usage' for more information.`);
        expanded.push(rest.shift()!);
      }
    }
    args = [...expanded, ...rest];
  }

  let mode: 'c' | 'x' | 't' | 'r' | null = null;
  let modeCount = 0;
  let file: string | null = null;
  let verbose = 0;
  let compression: Compression = null;
  let autoCompress = false;
  let toStdout = false;
  let keepOld = false;
  let noMtime = false;
  let derefLinks = false;
  let absoluteNames = false;
  let strip = 0;
  let noRecursion = false;
  let wildcards = false;
  let globalDir: string | null = null;
  let status = 0;
  const excludes: RegExp[] = [];
  // operands with the -C directory in effect when they were given
  const operands: { name: string; dir: string }[] = [];
  let curDir = ctx.cwd;
  const fs = ctx.fs;
  const warn = (msg: string) => { ctx.stderr += `tar: ${msg}\n`; };
  const setMode = (m: typeof mode) => { if (mode !== m) modeCount++; mode = m; };
  const readList = async (path: string): Promise<string[]> => {
    let text: string;
    if (path === '-') text = ctx.stdin || '';
    else {
      try { text = await fs.readFile(fs.resolvePath(path, ctx.cwd), 'utf8') as string; }
      catch { throw new TarFatal(`${path}: Cannot open: No such file or directory`); }
    }
    return text.split('\n').filter((l) => l !== '');
  };

  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!opts || a === '-' || !a.startsWith('-')) { operands.push({ name: a, dir: curDir }); continue; }
    if (a === '--') { opts = false; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const val = () => {
        if (eq >= 0) return a.slice(eq + 1);
        if (i + 1 >= args.length) throw new TarFatal(`option '--${name}' requires an argument`);
        return args[++i];
      };
      switch (name) {
        case 'create': setMode('c'); break;
        case 'extract': case 'get': setMode('x'); break;
        case 'list': setMode('t'); break;
        case 'append': setMode('r'); break;
        case 'file': file = val(); break;
        case 'directory': curDir = fs.resolvePath(val(), curDir); globalDir = curDir; break;
        case 'verbose': verbose++; break;
        case 'gzip': case 'gunzip': case 'ungzip': compression = 'gzip'; break;
        case 'bzip2': compression = 'bzip2'; break;
        case 'xz': compression = 'xz'; break;
        case 'zstd': compression = 'zstd'; break;
        case 'auto-compress': autoCompress = true; break;
        case 'to-stdout': toStdout = true; break;
        case 'keep-old-files': case 'skip-old-files': keepOld = true; break;
        case 'overwrite': case 'overwrite-dir': case 'unlink-first': case 'recursive-unlink': keepOld = false; break;
        case 'touch': noMtime = true; break;
        case 'dereference': derefLinks = true; break;
        case 'absolute-names': absoluteNames = true; break;
        case 'strip-components': strip = parseInt(val(), 10) || 0; break;
        case 'no-recursion': noRecursion = true; break;
        case 'recursion': noRecursion = false; break;
        case 'wildcards': wildcards = true; break;
        case 'no-wildcards': wildcards = false; break;
        case 'exclude': excludes.push(globRe(val())); break;
        case 'exclude-from': for (const l of await readList(val())) excludes.push(globRe(l)); break;
        case 'files-from': for (const l of await readList(val())) operands.push({ name: l, dir: curDir }); break;
        case 'preserve-permissions': case 'same-permissions': case 'same-owner': case 'no-same-owner':
        case 'no-same-permissions': case 'numeric-owner': case 'preserve-order': case 'same-order':
        case 'verify': case 'totals': case 'sparse': case 'ignore-zeros': case 'no-overwrite-dir':
        case 'format': case 'owner': case 'group': case 'mode': case 'mtime': case 'blocking-factor':
        case 'record-size': case 'checkpoint': case 'warning': case 'sort': case 'atime-preserve':
        case 'delay-directory-restore': case 'no-delay-directory-restore': case 'one-file-system':
          if (eq < 0 && ['format', 'owner', 'group', 'mode', 'mtime', 'blocking-factor', 'record-size'].includes(name)) val();
          break;
        default: throw new TarFatal(`unrecognized option '${a}'\nTry 'tar --help' or 'tar --usage' for more information.`);
      }
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      const need = () => {
        const rest = a.slice(j + 1);
        j = a.length;
        if (rest) return rest;
        if (i + 1 >= args.length) throw new TarFatal(`option requires an argument -- '${c}'\nTry 'tar --help' or 'tar --usage' for more information.`);
        return args[++i];
      };
      switch (c) {
        case 'c': setMode('c'); break;
        case 'x': setMode('x'); break;
        case 't': setMode('t'); break;
        case 'r': case 'u': setMode('r'); break;
        case 'f': file = need(); break;
        case 'C': curDir = fs.resolvePath(need(), curDir); globalDir = curDir; break;
        case 'v': verbose++; break;
        case 'z': compression = 'gzip'; break;
        case 'j': compression = 'bzip2'; break;
        case 'J': compression = 'xz'; break;
        case 'a': autoCompress = true; break;
        case 'O': toStdout = true; break;
        case 'k': keepOld = true; break;
        case 'm': noMtime = true; break;
        case 'h': derefLinks = true; break;
        case 'P': absoluteNames = true; break;
        case 'X': for (const l of await readList(need())) excludes.push(globRe(l)); break;
        case 'T': for (const l of await readList(need())) operands.push({ name: l, dir: curDir }); break;
        case 'b': need(); break;
        case 'p': case 'o': case 'W': case 'S': case 'U': case 's': case 'B': case 'w': case 'l': case 'M': break;
        default: throw new TarFatal(`invalid option -- '${c}'\nTry 'tar --help' or 'tar --usage' for more information.`);
      }
    }
  }

  if (modeCount === 0 || !mode) throw new TarFatal(`You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.`);
  if (modeCount > 1) throw new TarFatal(`You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option\nTry 'tar --help' or 'tar --usage' for more information.`);
  const archive = file ?? '-';
  if (autoCompress && archive !== '-' && !compression) {
    if (/\.(tgz|taz|tar\.gz|gz)$/.test(archive)) compression = 'gzip';
    else if (/\.(tbz2?|tar\.bz2|bz2)$/.test(archive)) compression = 'bzip2';
    else if (/\.(txz|tar\.xz|xz)$/.test(archive)) compression = 'xz';
    else if (/\.(tzst|tar\.zst|zst)$/.test(archive)) compression = 'zstd';
  }
  const excluded = (name: string) => {
    if (!excludes.length) return false;
    const parts = name.replace(/\/+$/, '').split('/');
    // GNU (unanchored): any run of whole path components matches
    for (let s = 0; s < parts.length; s++) {
      for (let e = s + 1; e <= parts.length; e++) {
        const sub = parts.slice(s, e).join('/');
        if (excludes.some((re) => re.test(sub))) return true;
      }
    }
    return false;
  };
  const fail = () => {
    if (status) warn('Exiting with failure status due to previous errors');
    return status;
  };

  // ── create / append ─────────────────────────────────────────────
  if (mode === 'c' || mode === 'r') {
    if (mode === 'c' && !operands.length) throw new TarFatal('Cowardly refusing to create an empty archive\nTry \'tar --help\' or \'tar --usage\' for more information.');
    const blocks: Uint8Array[] = [];
    // verbose listing goes to stderr when the archive is stdout
    const vout = (s: string) => { if (archive === '-') ctx.stderr += s; else ctx.stdout += s; };
    let warnedSlash = false;
    const user = ctx.env.USER || 'user';
    const addPath = async (shown: string, abs: string, _top: boolean) => {
      let st: any;
      try { st = derefLinks ? await fs.stat(abs) : await fs.lstat(abs); }
      catch {
        try { st = await fs.lstat(abs); } catch {
          warn(`${shown}: Cannot stat: No such file or directory`);
          status = 2;
          return;
        }
      }
      let name = shown;
      if (!absoluteNames && name.startsWith('/')) {
        name = name.replace(/^\/+/, '');
        if (!warnedSlash) { warn(`Removing leading \`/' from member names`); warnedSlash = true; }
      }
      name = name.replace(/^(\.\/)+(?=.)/, (m) => m); // keep ./ prefixes as given
      if (excluded(name)) return;
      const mtime = Math.floor((st.mtime?.getTime?.() ?? Date.now()) / 1000);
      const base: Header = { name, mode: st.mode & 0o7777, uid: st.uid ?? 1000, gid: st.gid ?? 1000, size: 0, mtime, type: '0', linkname: '', uname: user, gname: user };
      if (st.isSymbolicLink()) {
        const target = await fs.readlink(abs);
        blocks.push(...headerBlocks({ ...base, mode: 0o777, type: '2', linkname: target }));
        if (verbose) vout(verbose > 1 ? verboseLine({ ...base, mode: 0o777, type: '2', linkname: target }, verbose) : name + '\n');
        return;
      }
      if (st.isDirectory()) {
        const dname = name === '' ? '' : name.endsWith('/') ? name : name + '/';
        if (dname) {
          blocks.push(...headerBlocks({ ...base, name: dname, type: '5' }));
          if (verbose) vout(verbose > 1 ? verboseLine({ ...base, name: dname, type: '5' }, verbose) : dname + '\n');
        }
        if (noRecursion) return;
        let names: string[] = [];
        try { names = await fs.readdir(await fs.realpath(abs).catch(() => abs)); } catch { warn(`${shown}: Cannot open: Permission denied`); status = 2; return; }
        names.sort();
        for (const n of names) {
          const childShown = shown.endsWith('/') ? shown + n : `${shown}/${n}`;
          await addPath(childShown, abs === '/' ? `/${n}` : `${abs}/${n}`, false);
        }
        return;
      }
      if (!(st.mode & 0o400)) {
        warn(`${shown}: Cannot open: Permission denied`);
        status = 2;
        return;
      }
      let data: Uint8Array;
      try { data = await fs.readFile(abs) as Uint8Array; } catch { warn(`${shown}: Cannot open: No such file or directory`); status = 2; return; }
      if (typeof data === 'string') data = enc.encode(data);
      blocks.push(...headerBlocks({ ...base, size: data.length }), ...dataBlocks(data));
      if (verbose) vout(verbose > 1 ? verboseLine({ ...base, size: data.length }, verbose) : name + '\n');
    };

    for (const op of operands) {
      await addPath(op.name, fs.resolvePath(op.name, op.dir), true);
    }

    let existing = new Uint8Array(0);
    if (mode === 'r') {
      if (compression) throw new TarFatal('Cannot update compressed archives');
      if (archive !== '-') {
        try {
          const d = await fs.readFile(fs.resolvePath(archive, ctx.cwd)) as Uint8Array;
          // keep everything before the end-of-archive marker
          let pos = 0;
          while (pos + BLOCK <= d.length && !isZero(d.subarray(pos, pos + BLOCK))) {
            const h = d.subarray(pos, pos + BLOCK);
            const size = parseOctal(h, 124, 12);
            pos += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
          }
          existing = d.slice(0, pos);
        } catch { /* new archive */ }
      }
    }
    blocks.unshift(existing);
    blocks.push(new Uint8Array(BLOCK * 2));
    let total = blocks.reduce((n, b) => n + b.length, 0);
    // GNU pads to a whole record (20 blocks)
    const RECORD = BLOCK * 20;
    if (total % RECORD) blocks.push(new Uint8Array(RECORD - (total % RECORD)));
    total = blocks.reduce((n, b) => n + b.length, 0);
    let data: Uint8Array = new Uint8Array(total);
    let o = 0;
    for (const b of blocks) { data.set(b, o); o += b.length; }
    data = await compress(data, compression);
    if (archive === '-') {
      ctx.stdout += decodeBytes(data);
    } else {
      try { await fs.writeFile(fs.resolvePath(archive, ctx.cwd), data); }
      catch (e: any) { throw new TarFatal(`${archive}: Cannot open: ${/ENOENT/.test(e?.message) ? 'No such file or directory' : e?.message}`); }
    }
    return fail();
  }

  // ── list / extract ──────────────────────────────────────────────
  let raw: Uint8Array;
  if (archive === '-') raw = stdinBytes(ctx.stdin || '');
  else {
    try {
      const d = await fs.readFile(fs.resolvePath(archive, ctx.cwd));
      raw = typeof d === 'string' ? enc.encode(d) : d;
    } catch {
      warn(`${archive}: Cannot open: No such file or directory`);
      warn('Error is not recoverable: exiting now');
      return 2;
    }
  }
  const detected = sniff(raw);
  let data = raw;
  if (detected || compression) {
    try { data = await decompress(raw, detected ?? compression); }
    catch (e: any) { throw new TarFatal(`Child returned status 1\ntar: Error is not recoverable: exiting now`); }
  }

  // Legacy Shiro archives
  if (dec.decode(data.subarray(0, 13)) === 'FLUFFY-TAR-V1') {
    const text = dec.decode(data);
    return mode === 'x' ? extractOldFormat(text, ctx, globalDir ?? ctx.cwd, verbose > 0) : listOldFormat(text, ctx);
  }

  const outDir = globalDir ?? ctx.cwd;
  if (mode === 'x' && globalDir !== null && !toStdout) {
    const st = await fs.stat(globalDir).catch(() => null);
    if (!st || !st.isDirectory()) {
      const shown = args[args.findIndex((a, k) => k > 0 && (args[k - 1] === '-C' || args[k - 1] === '--directory'))] ?? globalDir;
      throw new TarFatal(`${shown}: Cannot open: ${st ? 'Not a directory' : 'No such file or directory'}\ntar: Error is not recoverable: exiting now`);
    }
  }
  const members = operands.map((o) => o.name.replace(/\/+$/, ''));
  const memberRes = wildcards ? members.map(globRe) : null;
  const found = new Set<number>();
  const selected = (name: string): boolean => {
    if (!members.length) return true;
    const n = name.replace(/\/+$/, '');
    for (let k = 0; k < members.length; k++) {
      const m = members[k];
      const hit = memberRes ? memberRes[k].test(n) || n.startsWith(m + '/') : n === m || n.startsWith(m + '/');
      if (hit) { found.add(k); return true; }
    }
    return false;
  };

  const delayedDirs: { path: string; mode: number; mtime: number }[] = [];
  let pos = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let entries = 0;
  if (data.length < BLOCK && data.length > 0) {
    warn('This does not look like a tar archive');
    status = 2;
    return fail();
  }
  if (data.length === 0) {
    warn('This does not look like a tar archive');
    status = 2;
    return fail();
  }
  while (pos + BLOCK <= data.length) {
    const hb = data.subarray(pos, pos + BLOCK);
    if (isZero(hb)) break;
    if (!checksumOk(hb)) {
      if (entries === 0) { warn('This does not look like a tar archive'); warn('Skipping to next header'); }
      else warn('Skipping to next header');
      status = 2;
      break;
    }
    entries++;
    pos += BLOCK;
    const size = parseOctal(hb, 124, 12);
    const type = String.fromCharCode(hb[156] || 0x30);
    const body = data.subarray(pos, pos + size);
    pos += Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') { longName = dec.decode(body).replace(/\0.*$/s, ''); continue; }
    if (type === 'K') { longLink = dec.decode(body).replace(/\0.*$/s, ''); continue; }
    if (type === 'x' || type === 'g') {
      // pax: honour path/linkpath
      const text = dec.decode(body);
      for (const rec of text.split('\n')) {
        const m = /^\d+ (path|linkpath)=(.*)$/.exec(rec);
        if (m && type === 'x') { if (m[1] === 'path') longName = m[2]; else longLink = m[2]; }
      }
      continue;
    }
    const magic = field(hb, 257, 6);
    const prefix = magic === 'ustar' ? field(hb, 345, 155) : '';
    const h: Header = {
      name: longName ?? ((prefix ? prefix + '/' : '') + field(hb, 0, 100)),
      mode: parseOctal(hb, 100, 8),
      uid: parseOctal(hb, 108, 8),
      gid: parseOctal(hb, 116, 8),
      size,
      mtime: parseOctal(hb, 136, 12),
      type: type === '\0' ? '0' : type,
      linkname: longLink ?? field(hb, 157, 100),
      uname: field(hb, 265, 32),
      gname: field(hb, 297, 32),
    };
    longName = longLink = null;
    if (h.type === '0' && h.name.endsWith('/')) h.type = '5';
    if (!selected(h.name) || excluded(h.name)) continue;

    if (mode === 't') {
      ctx.stdout += verbose ? verboseLine(h, verbose) : h.name + '\n';
      continue;
    }

    // extract
    if (toStdout) {
      if (h.type === '0' || h.type === '7') ctx.stdout += dec.decode(body);
      if (verbose) ctx.stderr += h.name + '\n';
      continue;
    }
    let name = h.name;
    if (strip) {
      const parts = name.split('/').filter((p, k, arr) => p !== '' || k === arr.length - 1);
      if (parts.length <= strip) continue;
      name = parts.slice(strip).join('/');
    }
    if (!absoluteNames) {
      if (name.startsWith('/')) name = name.replace(/^\/+/, '');
      if (name.split('/').includes('..')) {
        warn(`${h.name}: Member name contains '..'`);
        status = 2;
        continue;
      }
    }
    if (name === '' || name === '.' || name === './') {
      if (verbose) ctx.stdout += verbose > 1 ? verboseLine(h, verbose) : h.name + '\n';
      continue;
    }
    if (verbose) ctx.stdout += verbose > 1 ? verboseLine(h, verbose) : h.name + '\n';
    const target = fs.resolvePath(name, outDir);
    const parent = target.slice(0, target.lastIndexOf('/')) || '/';
    try {
      const pst = await fs.stat(parent).catch(() => null);
      if (!pst) await fs.mkdir(parent, { recursive: true });
    } catch (e: any) {
      warn(`${name}: Cannot open: No such file or directory`);
      status = 2;
      continue;
    }
    const existing = await fs.lstat(target).catch(() => null);
    if (h.type === '5') {
      if (existing && !existing.isDirectory()) {
        try { await fs.unlink(target); } catch {}
      }
      if (!existing || !existing.isDirectory()) {
        try { await fs.mkdir(target, { recursive: true }); } catch (e: any) { warn(`${name}: Cannot mkdir: ${e.message}`); status = 2; continue; }
      }
      // permissions and times are applied after the contents (a read-only dir must stay writable meanwhile)
      delayedDirs.push({ path: target, mode: h.mode & 0o7777, mtime: h.mtime });
      continue;
    }
    if (existing) {
      if (keepOld) {
        warn(`${name}: Cannot open: File exists`);
        status = 2;
        continue;
      }
      if (existing.isDirectory()) {
        if (h.type !== '5') {
          try { await fs.rmdir(target); } catch { warn(`${name}: Cannot open: Is a directory`); status = 2; continue; }
        }
      } else {
        try { await fs.unlink(target); } catch {}
      }
    }
    try {
      if (h.type === '2') {
        await fs.symlink(h.linkname, target);
      } else if (h.type === '1') {
        // hard link: a copy of the already extracted target
        const src = fs.resolvePath(h.linkname.replace(/^\/+/, ''), outDir);
        const sst = await fs.lstat(src).catch(() => null);
        if (!sst) { warn(`${name}: Cannot hard link to '${h.linkname}': No such file or directory`); status = 2; continue; }
        if (sst.isSymbolicLink()) await fs.symlink(await fs.readlink(src), target);
        else {
          await fs.writeFile(target, await fs.readFile(src) as Uint8Array, { mode: sst.mode & 0o7777 });
        }
      } else if (h.type === '0' || h.type === '7') {
        await fs.writeFile(target, body.slice(), { mode: h.mode & 0o7777 });
        await fs.chmod(target, h.mode & 0o7777).catch(() => {});
        if (!noMtime) await fs.utimes(target, h.mtime * 1000, h.mtime * 1000).catch(() => {});
      } else {
        warn(`${name}: Unknown file type '${h.type}', extracted as normal file`);
        await fs.writeFile(target, body.slice(), { mode: h.mode & 0o7777 });
      }
    } catch (e: any) {
      warn(`${name}: Cannot open: ${/ENOENT/.test(e?.message) ? 'No such file or directory' : e?.message}`);
      status = 2;
    }
  }
  if (mode === 'x') {
    for (const d of delayedDirs.reverse()) {
      await fs.chmod(d.path, d.mode).catch(() => {});
      if (!noMtime) await fs.utimes(d.path, d.mtime * 1000, d.mtime * 1000).catch(() => {});
    }
  }
  members.forEach((m, k) => {
    if (!found.has(k)) { warn(`${m}: Not found in archive`); status = 2; }
  });
  return fail();
}

function verboseLine(h: Header, verbose: number): string {
  const d = new Date(h.mtime * 1000);
  const when = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const owner = `${h.uname || h.uid}/${h.gname || h.gid}`;
  const size = String(h.type === '5' || h.type === '2' || h.type === '1' ? 0 : h.size);
  const pad = owner.length + 1 + size.length;
  const width = Math.max(19, pad);
  let line = `${MODE_CHARS(h.type, h.mode)} ${owner} ${size.padStart(width - pad + size.length)} ${when} ${h.name}`;
  if (h.type === '2') line += ` -> ${h.linkname}`;
  if (h.type === '1') line += ` link to ${h.linkname}`;
  return line + '\n';
}

// Backward compatibility: old FLUFFY-TAR-V1 format
async function extractOldFormat(content: string, ctx: CommandContext, workingDir: string, verbose: boolean): Promise<number> {
  const lines = content.split('\n');
  let i = 1;
  const extracted: string[] = [];
  while (i < lines.length) {
    if (!lines[i].startsWith('FILE:')) break;
    const filePath = lines[i].slice(5);
    const type = lines[i + 2].slice(5);
    i += 4; // Skip FILE:, SIZE:, TYPE:, DATA-START
    const contentLines: string[] = [];
    while (i < lines.length && lines[i] !== 'DATA-END') {
      contentLines.push(lines[i]);
      i++;
    }
    const fileContent = contentLines.join('\n');
    i++; // Skip DATA-END
    const targetPath = ctx.fs.resolvePath(filePath, workingDir);
    if (type === 'dir') {
      await ctx.fs.mkdir(targetPath, { recursive: true });
    } else {
      const lastSlash = targetPath.lastIndexOf('/');
      if (lastSlash > 0) {
        try { await ctx.fs.mkdir(targetPath.slice(0, lastSlash), { recursive: true }); } catch {}
      }
      await ctx.fs.writeFile(targetPath, fileContent);
    }
    extracted.push(filePath);
  }
  if (verbose) ctx.stdout += extracted.join('\n') + '\n';
  return 0;
}

function listOldFormat(content: string, ctx: CommandContext): number {
  const lines = content.split('\n');
  const fileList: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('FILE:')) fileList.push(lines[i].slice(5));
  }
  ctx.stdout += fileList.join('\n') + '\n';
  return 0;
}
