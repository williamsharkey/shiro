import { Command, CommandContext } from './index';

/**
 * cc/gcc: Real C compiler using xcc/wcc (C → WebAssembly)
 *
 * Downloads the xcc compiler toolchain (139 KB zip) on first use,
 * caches in IndexedDB. Compiles C source to WASM and produces
 * executable shell wrappers that run via a built-in WASI runtime.
 *
 * Usage:
 *   cc hello.c                  # compile to a.out
 *   cc hello.c -o hello         # compile to hello
 *   cc -c hello.c               # compile only (hello.o)
 *   ./hello                     # run compiled program
 */

const WCCFILES_URL = '/wccfiles.zip';
const FALLBACK_URL = 'https://tyfkda.github.io/xcc/wccfiles.zip';
const CACHE_DB = 'shiro-cc-cache';
const CACHE_STORE = 'binaries';
const CACHE_KEY = 'wccfiles-v1';
const CC_PATH = '/usr/bin/cc';

// WASI constants
const E = { OK: 0, BADF: 8, NOENT: 44, NOSYS: 52 } as const;
const FT = { DIR: 3, REG: 4, CHR: 2 } as const;

// ===== Module State =====
const toolchain = { files: new Map<string, Uint8Array>(), dirs: new Set<string>() };
let ccModule: WebAssembly.Module | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;

// ===== IndexedDB Cache (same pattern as build.ts) =====

function openCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(CACHE_STORE))
        req.result.createObjectStore(CACHE_STORE);
    };
  });
}

async function cacheGet(): Promise<ArrayBuffer | null> {
  try {
    const db = await openCacheDB();
    return new Promise(resolve => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const req = tx.objectStore(CACHE_STORE).get(CACHE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch { return null; }
}

async function cacheSet(data: ArrayBuffer): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).put(data, CACHE_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch { /* non-fatal */ }
}

// ===== ZIP Extraction =====

async function unzipFiles(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buf);
  const files = new Map<string, Uint8Array>();
  let off = 0;
  while (off + 30 <= buf.byteLength) {
    if (view.getUint32(off, true) !== 0x04034b50) break;
    const method = view.getUint16(off + 8, true);
    const cSize = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, off + 30, nameLen));
    const dataOff = off + 30 + nameLen + extraLen;
    if (cSize > 0 && !name.endsWith('/')) {
      const raw = new Uint8Array(buf, dataOff, cSize);
      if (method === 0) {
        files.set(name, raw.slice());
      } else if (method === 8) {
        const blob = new Blob([raw]);
        const ds = new DecompressionStream('deflate-raw');
        const result = await new Response(blob.stream().pipeThrough(ds)).arrayBuffer();
        files.set(name, new Uint8Array(result));
      }
    }
    off = dataOff + cSize;
  }
  return files;
}

// ===== Path Helpers =====

export function normPath(p: string): string {
  const parts = p.split('/').filter(s => s && s !== '.');
  const out: string[] = [];
  for (const s of parts) { if (s === '..') out.pop(); else out.push(s); }
  return '/' + out.join('/');
}

// ===== WASI Runtime =====

class WasiExit extends Error {
  constructor(public code: number) { super(`exit(${code})`); }
}

interface FD {
  path: string;
  dir: boolean;
  pos: number;
  data: Uint8Array | null;
}

export interface SimpleFS {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
}

export class WasiRT {
  private memory!: WebAssembly.Memory;
  private dv!: DataView;
  private u8!: Uint8Array;
  private fds = new Map<number, FD>();
  private nfd = 4;
  stdout = '';
  stderr = '';
  exitCode = 0;

  constructor(
    private fs: SimpleFS,
    private args: string[],
    private env: Record<string, string>,
    private stdinData = '',
  ) {
    // fd 3 = preopen for "/"
    this.fds.set(3, { path: '/', dir: true, pos: 0, data: null });
  }

  private setMem(m: WebAssembly.Memory) {
    this.memory = m;
    this.dv = new DataView(m.buffer);
    this.u8 = new Uint8Array(m.buffer);
  }

  private sync() {
    if (this.u8.buffer !== this.memory.buffer) {
      this.dv = new DataView(this.memory.buffer);
      this.u8 = new Uint8Array(this.memory.buffer);
    }
  }

  private str(ptr: number, len: number): string {
    return new TextDecoder().decode(this.u8.slice(ptr, ptr + len));
  }

  private resolve(dirfd: number, ptr: number, len: number): string {
    const rel = this.str(ptr, len);
    if (rel.startsWith('/')) return normPath(rel);
    const base = this.fds.get(dirfd)?.path || '/';
    return normPath(base === '/' ? '/' + rel : base + '/' + rel);
  }

  getImports(): WebAssembly.Imports {
    const w = this;
    return { wasi_snapshot_preview1: {
      args_sizes_get(ac: number, bs: number) {
        w.sync();
        w.dv.setUint32(ac, w.args.length, true);
        let s = 0;
        for (const a of w.args) s += new TextEncoder().encode(a + '\0').length;
        w.dv.setUint32(bs, s, true);
        return E.OK;
      },
      args_get(argv: number, buf: number) {
        w.sync();
        let off = buf;
        for (let i = 0; i < w.args.length; i++) {
          w.dv.setUint32(argv + i * 4, off, true);
          const enc = new TextEncoder().encode(w.args[i] + '\0');
          w.u8.set(enc, off);
          off += enc.length;
        }
        return E.OK;
      },
      environ_sizes_get(ec: number, bs: number) {
        w.sync();
        const entries = Object.entries(w.env);
        w.dv.setUint32(ec, entries.length, true);
        let s = 0;
        for (const [k, v] of entries) s += new TextEncoder().encode(`${k}=${v}\0`).length;
        w.dv.setUint32(bs, s, true);
        return E.OK;
      },
      environ_get(envp: number, buf: number) {
        w.sync();
        const entries = Object.entries(w.env);
        let off = buf;
        for (let i = 0; i < entries.length; i++) {
          w.dv.setUint32(envp + i * 4, off, true);
          const enc = new TextEncoder().encode(`${entries[i][0]}=${entries[i][1]}\0`);
          w.u8.set(enc, off);
          off += enc.length;
        }
        return E.OK;
      },
      fd_write(fd: number, iovs: number, iovsLen: number, nw: number) {
        w.sync();
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = w.dv.getUint32(iovs + i * 8, true);
          const len = w.dv.getUint32(iovs + i * 8 + 4, true);
          if (len === 0) continue;
          const chunk = w.u8.slice(ptr, ptr + len);
          if (fd === 1) { w.stdout += new TextDecoder().decode(chunk); }
          else if (fd === 2) { w.stderr += new TextDecoder().decode(chunk); }
          else {
            const f = w.fds.get(fd);
            if (!f || f.dir) return E.BADF;
            if (!f.data) f.data = new Uint8Array(0);
            const need = f.pos + len;
            if (need > f.data.length) {
              const grown = new Uint8Array(need);
              grown.set(f.data);
              f.data = grown;
            }
            f.data.set(chunk, f.pos);
            f.pos += len;
          }
          total += len;
        }
        w.dv.setUint32(nw, total, true);
        return E.OK;
      },
      fd_read(fd: number, iovs: number, iovsLen: number, nr: number) {
        w.sync();
        if (fd === 0) {
          // stdin
          const stdinBytes = new TextEncoder().encode(w.stdinData);
          let total = 0;
          for (let i = 0; i < iovsLen; i++) {
            const ptr = w.dv.getUint32(iovs + i * 8, true);
            const len = w.dv.getUint32(iovs + i * 8 + 4, true);
            const n = Math.min(len, stdinBytes.length - total);
            if (n > 0) { w.u8.set(stdinBytes.subarray(total, total + n), ptr); total += n; }
            if (n < len) break;
          }
          w.stdinData = '';
          w.dv.setUint32(nr, total, true);
          return E.OK;
        }
        const f = w.fds.get(fd);
        if (!f || !f.data) return E.BADF;
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = w.dv.getUint32(iovs + i * 8, true);
          const len = w.dv.getUint32(iovs + i * 8 + 4, true);
          const avail = f.data.length - f.pos;
          const n = Math.min(len, avail);
          if (n > 0) { w.u8.set(f.data.subarray(f.pos, f.pos + n), ptr); f.pos += n; total += n; }
          if (n < len) break;
        }
        w.dv.setUint32(nr, total, true);
        return E.OK;
      },
      fd_close(fd: number) {
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        if (f.data && !f.dir) w.fs.files.set(f.path, f.data);
        w.fds.delete(fd);
        return E.OK;
      },
      fd_seek(fd: number, offset: bigint, whence: number, newOff: number) {
        w.sync();
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        const off = Number(offset);
        const size = f.data ? f.data.length : 0;
        if (whence === 0) f.pos = off;
        else if (whence === 1) f.pos += off;
        else if (whence === 2) f.pos = size + off;
        w.dv.setBigUint64(newOff, BigInt(f.pos), true);
        return E.OK;
      },
      fd_fdstat_get(fd: number, buf: number) {
        w.sync();
        let ft: number = FT.REG;
        if (fd <= 2) ft = FT.CHR;
        else { const f = w.fds.get(fd); if (!f) return E.BADF; ft = f.dir ? FT.DIR : FT.REG; }
        w.dv.setUint8(buf, ft);
        w.dv.setUint16(buf + 2, 0, true);
        w.dv.setBigUint64(buf + 8, 0x1FFFFFFFFn, true);
        w.dv.setBigUint64(buf + 16, 0x1FFFFFFFFn, true);
        return E.OK;
      },
      fd_prestat_get(fd: number, buf: number) {
        w.sync();
        if (fd !== 3) return E.BADF;
        w.dv.setUint32(buf, 0, true); // type = dir
        w.dv.setUint32(buf + 4, 1, true); // name length = 1 ("/")
        return E.OK;
      },
      fd_prestat_dir_name(fd: number, p: number, len: number) {
        w.sync();
        if (fd !== 3) return E.BADF;
        w.u8.set(new TextEncoder().encode('/').slice(0, len), p);
        return E.OK;
      },
      path_open(dirfd: number, _df: number, pathP: number, pathL: number,
                oflags: number, _rb: bigint, _ri: bigint, fdflags: number, fdP: number) {
        w.sync();
        const path = w.resolve(dirfd, pathP, pathL);
        const creat = (oflags & 1) !== 0;
        const trunc = (oflags & 8) !== 0;
        const isDir = (oflags & 2) !== 0;
        if (isDir) {
          if (!w.fs.dirs.has(path)) return E.NOENT;
          const fd = w.nfd++;
          w.fds.set(fd, { path, dir: true, pos: 0, data: null });
          w.dv.setUint32(fdP, fd, true);
          return E.OK;
        }
        let data = w.fs.files.get(path) || null;
        if (!data && !creat) return E.NOENT;
        if (!data || trunc) data = new Uint8Array(0);
        else data = new Uint8Array(data); // copy for mutation
        const fd = w.nfd++;
        w.fds.set(fd, { path, dir: false, pos: (fdflags & 1) ? data.length : 0, data });
        w.dv.setUint32(fdP, fd, true);
        return E.OK;
      },
      path_filestat_get(fd: number, _f: number, pathP: number, pathL: number, buf: number) {
        w.sync();
        const path = w.resolve(fd, pathP, pathL);
        const isDir = w.fs.dirs.has(path);
        const file = w.fs.files.get(path);
        if (!isDir && !file) return E.NOENT;
        const size = file ? file.length : 0;
        w.dv.setBigUint64(buf, 0n, true);      // dev
        w.dv.setBigUint64(buf + 8, 0n, true);  // ino
        w.dv.setUint8(buf + 16, isDir ? FT.DIR : FT.REG);
        w.dv.setBigUint64(buf + 24, 1n, true); // nlink
        w.dv.setBigUint64(buf + 32, BigInt(size), true);
        w.dv.setBigUint64(buf + 40, 0n, true); // atim
        w.dv.setBigUint64(buf + 48, 0n, true); // mtim
        w.dv.setBigUint64(buf + 56, 0n, true); // ctim
        return E.OK;
      },
      fd_filestat_get(fd: number, buf: number) {
        w.sync();
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        const size = f.data ? f.data.length : 0;
        w.dv.setBigUint64(buf, 0n, true);
        w.dv.setBigUint64(buf + 8, 0n, true);
        w.dv.setUint8(buf + 16, f.dir ? FT.DIR : FT.REG);
        w.dv.setBigUint64(buf + 24, 1n, true);
        w.dv.setBigUint64(buf + 32, BigInt(size), true);
        w.dv.setBigUint64(buf + 40, 0n, true);
        w.dv.setBigUint64(buf + 48, 0n, true);
        w.dv.setBigUint64(buf + 56, 0n, true);
        return E.OK;
      },
      fd_tell(fd: number, off: number) {
        w.sync();
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        w.dv.setBigUint64(off, BigInt(f.pos), true);
        return E.OK;
      },
      path_unlink_file(fd: number, pathP: number, pathL: number) {
        w.sync();
        w.fs.files.delete(w.resolve(fd, pathP, pathL));
        return E.OK;
      },
      path_create_directory(fd: number, pathP: number, pathL: number) {
        w.sync();
        w.fs.dirs.add(w.resolve(fd, pathP, pathL));
        return E.OK;
      },
      proc_exit(code: number) { w.exitCode = code; throw new WasiExit(code); },
      clock_time_get(_id: number, _prec: bigint, t: number) {
        w.sync();
        w.dv.setBigUint64(t, BigInt(Math.round(performance.now() * 1e6)), true);
        return E.OK;
      },
      random_get(buf: number, len: number) {
        w.sync();
        crypto.getRandomValues(new Uint8Array(w.memory.buffer, buf, len));
        return E.OK;
      },
      // Stubs for unused WASI syscalls
      fd_advise: () => E.OK, fd_allocate: () => E.OK,
      fd_datasync: () => E.OK, fd_sync: () => E.OK,
      fd_filestat_set_times: () => E.OK, fd_filestat_set_size: () => E.OK,
      fd_fdstat_set_flags: () => E.OK, path_filestat_set_times: () => E.OK,
      sched_yield: () => E.OK,
      fd_renumber: () => E.NOSYS, fd_readdir: () => E.NOSYS,
      fd_pread: () => E.NOSYS, fd_pwrite: () => E.NOSYS,
      path_readlink: () => E.NOSYS, path_symlink: () => E.NOSYS,
      path_link: () => E.NOSYS, path_rename: () => E.NOSYS,
      path_remove_directory: () => E.NOSYS,
      poll_oneoff: () => E.NOSYS, clock_res_get: () => E.NOSYS,
      sock_accept: () => E.NOSYS, sock_recv: () => E.NOSYS,
      sock_send: () => E.NOSYS, sock_shutdown: () => E.NOSYS,
      proc_raise: () => E.NOSYS,
    }};
  }

  async run(module: WebAssembly.Module) {
    const imports = this.getImports();
    const instance = await WebAssembly.instantiate(module, imports);
    this.setMem(instance.exports.memory as WebAssembly.Memory);
    try {
      (instance.exports._start as Function)();
    } catch (e) {
      if (!(e instanceof WasiExit)) throw e;
    }
  }
}

// ===== Initialization =====

async function ensureInit(): Promise<void> {
  if (initialized) return;
  if (initPromise) { await initPromise; return; }

  initPromise = (async () => {
    try {
      let zipData = await cacheGet();
      if (!zipData) {
        // Try same-origin first, then CDN fallback
        try {
          const resp = await fetch(WCCFILES_URL);
          if (!resp.ok) throw new Error(resp.statusText);
          zipData = await resp.arrayBuffer();
        } catch {
          const resp = await fetch(FALLBACK_URL);
          if (!resp.ok) throw new Error(`Failed to download compiler: ${resp.statusText}`);
          zipData = await resp.arrayBuffer();
        }
        cacheSet(zipData); // fire and forget
      }

      // Extract zip into toolchain
      const files = await unzipFiles(zipData);
      for (const [name, data] of files) {
        const path = '/' + name;
        toolchain.files.set(normPath(path), data);
        // Ensure parent dirs exist
        const parts = normPath(path).split('/');
        for (let i = 1; i < parts.length; i++) {
          toolchain.dirs.add(parts.slice(0, i).join('/') || '/');
        }
      }
      toolchain.dirs.add('/');
      toolchain.dirs.add('/tmp');
      toolchain.dirs.add('/home');

      // Compile the C compiler WASM
      const ccWasm = toolchain.files.get(CC_PATH);
      if (!ccWasm) throw new Error('C compiler binary not found in archive');
      ccModule = await WebAssembly.compile(ccWasm.buffer as ArrayBuffer);

      initialized = true;
    } catch (e: any) {
      initPromise = null;
      throw e;
    }
  })();

  await initPromise;
}

// ===== Run compiled WASM =====

async function runWasm(ctx: CommandContext, wasmPath: string, args: string[]): Promise<number> {
  const resolved = ctx.fs.resolvePath(wasmPath, ctx.cwd);
  let wasmData: Uint8Array;
  try {
    const content = await ctx.fs.readFile(resolved);
    wasmData = content instanceof Uint8Array ? content : new TextEncoder().encode(content as string);
  } catch {
    ctx.stderr += `cc: cannot run ${wasmPath}: No such file\n`;
    return 1;
  }

  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(wasmData.buffer as ArrayBuffer);
  } catch (e: any) {
    ctx.stderr += `cc: invalid wasm: ${e.message}\n`;
    return 1;
  }

  const fs: SimpleFS = { files: new Map(), dirs: new Set(['/', '/tmp']) };
  const rt = new WasiRT(fs, [wasmPath, ...args], {}, ctx.stdin);
  try {
    await rt.run(module);
  } catch (e: any) {
    if (!(e instanceof WasiExit)) {
      ctx.stderr += `cc: runtime error: ${e.message}\n`;
      return 1;
    }
  }
  ctx.stdout += rt.stdout;
  if (rt.stderr) ctx.stderr += rt.stderr;
  return rt.exitCode;
}

// ===== Commands =====

export const ccCmd: Command = {
  name: 'cc',
  description: 'C compiler (xcc/wcc — compiles C to WebAssembly)',

  async exec(ctx) {
    const args = ctx.args;

    // Hidden: run compiled WASM binary
    if (args[0] === '--run' && args[1]) {
      return runWasm(ctx, args[1], args.slice(2));
    }

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      ctx.stdout += 'Usage: cc [options] <source.c>\n\n';
      ctx.stdout += 'Options:\n';
      ctx.stdout += '  -o FILE      Output file (default: a.out)\n';
      ctx.stdout += '  -c           Compile only, produce .wasm object\n';
      ctx.stdout += '  -I DIR       Add include search path\n';
      ctx.stdout += '  --version    Show version info\n';
      ctx.stdout += '  --run FILE   Run a compiled .wasm binary\n';
      ctx.stdout += '\nCompiles C source to WebAssembly using xcc.\n';
      ctx.stdout += 'Compiled programs run via built-in WASI runtime.\n';
      return 0;
    }

    if (args[0] === '--version' || args[0] === '-v') {
      ctx.stdout += 'cc (xcc/wcc) — C to WebAssembly compiler\n';
      ctx.stdout += 'Running in Shiro browser OS\n';
      ctx.stdout += 'https://github.com/tyfkda/xcc\n';
      return 0;
    }

    // Parse arguments
    let outputFile = '';
    let compileOnly = false;
    const sourceFiles: string[] = [];
    const extraFlags: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-o' && i + 1 < args.length) { outputFile = args[++i]; }
      else if (a === '-c') { compileOnly = true; }
      else if (a === '-E' || a === '-S') {
        ctx.stderr += `cc: ${a} not supported (compile to WASM only)\n`;
        return 1;
      }
      else if (a.startsWith('-W') || a.startsWith('-O') || a === '-g') { /* ignore */ }
      else if (a.startsWith('-')) { extraFlags.push(a); }
      else { sourceFiles.push(a); }
    }

    if (sourceFiles.length === 0) {
      ctx.stderr += 'cc: fatal error: no input files\ncompilation terminated.\n';
      return 1;
    }

    // Initialize compiler on first use
    try {
      if (!initialized) ctx.stderr += 'cc: downloading compiler (first use)...\n';
      await ensureInit();
    } catch (e: any) {
      ctx.stderr += `cc: ${e.message}\n`;
      return 1;
    }

    // Read source files from Shiro VFS
    const sources: { name: string; content: string }[] = [];
    for (const file of sourceFiles) {
      const path = ctx.fs.resolvePath(file, ctx.cwd);
      try {
        const content = await ctx.fs.readFile(path, 'utf8');
        sources.push({ name: file.split('/').pop()!, content: content as string });
      } catch {
        ctx.stderr += `cc: error: ${file}: No such file or directory\n`;
        return 1;
      }
    }

    // Build compiler filesystem (toolchain + source files at root)
    const cfs: SimpleFS = {
      files: new Map(toolchain.files),
      dirs: new Set(toolchain.dirs),
    };
    for (const src of sources) {
      cfs.files.set('/' + src.name, new TextEncoder().encode(src.content));
    }

    // Build compiler arguments
    const ccArgs = [CC_PATH];
    if (compileOnly) ccArgs.push('-c');
    ccArgs.push(...extraFlags);
    for (const src of sources) ccArgs.push(src.name);

    // Run compiler
    const rt = new WasiRT(cfs, ccArgs, {
      HOME: '/work',
      INCLUDE: '/usr/include',
      LIB: '/usr/lib',
      PATH: '/usr/bin',
      PWD: '/work',
    });

    try {
      await rt.run(ccModule!);
    } catch (e: any) {
      if (!(e instanceof WasiExit)) {
        ctx.stderr += `cc: internal error: ${e.message}\n`;
        return 1;
      }
    }

    if (rt.stderr) ctx.stderr += rt.stderr;
    if (rt.stdout) ctx.stdout += rt.stdout;
    if (rt.exitCode !== 0) return rt.exitCode;

    // Handle output
    if (compileOnly) {
      for (const src of sources) {
        const oName = src.name.replace(/\.c$/, '.o');
        const oData = cfs.files.get('/' + oName);
        if (oData) {
          const outPath = ctx.fs.resolvePath(outputFile || oName, ctx.cwd);
          await ctx.fs.writeFile(outPath, oData);
        }
      }
      return 0;
    }

    // Full compile: read a.wasm output
    const wasmData = cfs.files.get('/a.wasm');
    if (!wasmData) {
      ctx.stderr += 'cc: error: compilation produced no output\n';
      return 1;
    }

    const outName = outputFile || 'a.out';
    const outPath = ctx.fs.resolvePath(outName, ctx.cwd);
    const wasmPath = outPath + '.wasm';

    // Write the WASM binary
    await ctx.fs.writeFile(wasmPath, wasmData);
    // Write a shell wrapper that invokes the WASI runtime
    await ctx.fs.writeFile(outPath, `#!/bin/sh\ncc --run "${wasmPath}" "$@"\n`);

    return 0;
  },
};

export const gccCmd: Command = {
  name: 'gcc',
  description: 'C compiler (alias for cc)',
  async exec(ctx) { return ccCmd.exec(ctx); },
};
