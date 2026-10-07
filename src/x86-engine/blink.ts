/**
 * Page side of the Blink x86-64 engine (jart/blink compiled to WebAssembly,
 * see docs/X86_ENGINES.md and vendor/blink/).
 *
 * Each run starts a Worker on public/engines/blink/host.mjs, which loads
 * blink.mjs/blink.wasm and runs the guest with real threads (emscripten
 * pthreads). That needs SharedArrayBuffer, so the engine is only available
 * when the page is cross-origin isolated (or in Node); callers fall back to
 * src/x86 otherwise.
 *
 * Interim wiring until src/kernel lands: the worker's filesystem requests
 * (stat/readdir/read/write/...) arrive over a SharedArrayBuffer channel with
 * the kernel ABI layout and are served here from the Shiro FileSystem;
 * stdout/stderr stream back as messages; stdin is the command's buffered
 * stdin string.
 */

import type { FileSystem } from '../filesystem';

export interface BlinkRunOptions {
  fs: FileSystem;
  cwd: string;
  env: Record<string, string>;
  stdin?: string | Uint8Array;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  /** Abort the guest (worker.terminate()); resolves with 128+9. */
  signal?: AbortSignal;
}

// Channel layout shared with host.mjs (Int32 indices; data at byte 64).
const ST = 0, OP = 1, RES = 2, LEN = 4, JLEN = 5, DATA = 64;
const CHANNEL_BYTES = 64 + (1 << 20);
const OPS = { STAT: 1, READDIR: 2, READ: 3, WRITE: 4, MKDIR: 5, UNLINK: 6, RMDIR: 7, RENAME: 8, SYMLINK: 9, READLINK: 10, CHMOD: 11 };

const ERRNO: Record<string, number> = {
  EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EACCES: 13, EEXIST: 17, ENOTDIR: 20,
  EISDIR: 21, EINVAL: 22, ENOSPC: 28, EROFS: 30, ENOTEMPTY: 39, ELOOP: 40,
};

let assetBase: string | null = null;

/** Node's process object when running under Node (vitest), else undefined. */
const nodeProcess = (): any => (globalThis as any).process;

/** Where host.mjs/blink.mjs/blink.wasm are served from (a directory URL). */
export function setBlinkAssetBase(url: string | null): void {
  assetBase = url && !url.endsWith('/') ? url + '/' : url;
}

function isNode(): boolean {
  // Real Node (vitest), even when a DOM shim defines window; the browser's
  // process polyfill has no getBuiltinModule.
  return typeof nodeProcess()?.getBuiltinModule === 'function';
}

function defaultAssetBase(): string {
  if (assetBase) return assetBase;
  if (isNode()) {
    // vitest/Node: the repo's public/ dir, found from the working directory.
    const p = nodeProcess();
    const nodeFs = p.getBuiltinModule?.('fs');
    const nodePath = p.getBuiltinModule?.('path');
    const nodeUrl = p.getBuiltinModule?.('url');
    if (nodeFs && nodePath && nodeUrl) {
      const candidates = [p.env.SHIRO_BLINK_ASSETS, 'public/engines/blink', '../public/engines/blink'].filter(Boolean);
      for (const c of candidates) {
        const dir = nodePath.resolve(p.cwd(), c);
        if (nodeFs.existsSync(nodePath.join(dir, 'host.mjs'))) return nodeUrl.pathToFileURL(dir).href + '/';
      }
    }
  }
  const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : (globalThis as any).location?.href;
  return new URL('engines/blink/', base || 'http://localhost/').href;
}

/** True when this environment can run the Blink engine at all. */
export function blinkSupported(): boolean {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return false;
  if (isNode()) return true;
  return typeof Worker !== 'undefined' && (globalThis as any).crossOriginIsolated === true;
}

interface HostWorker {
  post(msg: any): void;
  onMessage(fn: (msg: any) => void): void;
  onError(fn: (err: any) => void): void;
  terminate(): void;
}

async function startHost(): Promise<HostWorker> {
  const url = defaultAssetBase() + 'host.mjs';
  if (isNode()) {
    const wtName = 'node:worker_threads';
    const wt: any = await import(/* @vite-ignore */ wtName);
    const w = new wt.Worker(new URL(url));
    return {
      post: (m) => w.postMessage(m),
      onMessage: (fn) => w.on('message', fn),
      onError: (fn) => w.on('error', fn),
      terminate: () => { void w.terminate(); },
    };
  }
  const w = new Worker(url, { type: 'module', name: 'blink' });
  return {
    post: (m) => w.postMessage(m),
    onMessage: (fn) => w.addEventListener('message', (e: MessageEvent) => fn(e.data)),
    onError: (fn) => w.addEventListener('error', (e: ErrorEvent) => fn(e.error || new Error(e.message))),
    terminate: () => w.terminate(),
  };
}

function errnoOf(e: any): number {
  const code = e?.code;
  if (typeof code === 'string' && ERRNO[code]) return -ERRNO[code];
  const m = /^(E[A-Z]+)\b/.exec(String(e?.message || ''));
  if (m && ERRNO[m[1]]) return -ERRNO[m[1]];
  return -ERRNO.EIO;
}

/** Serves the worker's filesystem requests from a Shiro FileSystem. */
class FsServer {
  private readCache = new Map<string, Uint8Array>();
  private writes = new Map<string, Uint8Array[]>();
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  private i32: Int32Array;
  private u8: Uint8Array;
  private busy = false;

  constructor(private fs: FileSystem, chan: SharedArrayBuffer) {
    this.i32 = new Int32Array(chan);
    this.u8 = new Uint8Array(chan);
  }

  async service(): Promise<void> {
    if (this.busy || Atomics.load(this.i32, ST) !== 1) return;
    this.busy = true;
    try {
      const op = Atomics.load(this.i32, OP);
      const jlen = Atomics.load(this.i32, JLEN);
      const len = Atomics.load(this.i32, LEN);
      const req = JSON.parse(this.dec.decode(this.u8.slice(DATA, DATA + jlen)));
      const payload = this.u8.slice(DATA + jlen, DATA + len);
      let res = 0;
      let out: Uint8Array = new Uint8Array(0);
      try {
        [res, out] = await this.handle(op, req, payload);
      } catch (e) {
        res = errnoOf(e);
      }
      this.u8.set(out, DATA);
      Atomics.store(this.i32, RES, res);
      Atomics.store(this.i32, LEN, out.length);
      Atomics.store(this.i32, ST, 2);
      Atomics.notify(this.i32, ST);
    } finally {
      this.busy = false;
    }
  }

  private json(v: unknown): Uint8Array { return this.enc.encode(JSON.stringify(v)); }

  private async handle(op: number, req: any, payload: Uint8Array): Promise<[number, Uint8Array]> {
    const fs = this.fs;
    const none = new Uint8Array(0);
    switch (op) {
      case OPS.STAT: {
        const st = await fs.lstat(req.path);
        const info: any = { type: st.type, mode: st.mode, size: st.size, mtime: st.mtime.getTime() };
        if (st.type === 'symlink') info.target = await fs.readlink(req.path);
        return [0, this.json(info)];
      }
      case OPS.READDIR:
        return [0, this.json(await fs.readdir(req.path))];
      case OPS.READ: {
        let data = this.readCache.get(req.path);
        if (!data || req.offset === 0) {
          const raw = await fs.readFile(req.path);
          data = typeof raw === 'string' ? this.enc.encode(raw) : raw;
          this.readCache.set(req.path, data);
        }
        const chunk = data.subarray(req.offset, req.offset + (CHANNEL_BYTES - DATA));
        if (req.offset + chunk.length >= data.length) this.readCache.delete(req.path);
        return [data.length, chunk];
      }
      case OPS.WRITE: {
        const parts = req.offset === 0 ? [] : (this.writes.get(req.path) || []);
        parts.push(payload);
        if (!req.final) { this.writes.set(req.path, parts); return [0, none]; }
        this.writes.delete(req.path);
        const total = parts.reduce((n, p) => n + p.length, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { buf.set(p, off); off += p.length; }
        await fs.writeFile(req.path, buf, { mode: req.mode });
        return [0, none];
      }
      case OPS.MKDIR: await fs.mkdir(req.path); return [0, none];
      case OPS.UNLINK: await fs.unlink(req.path); return [0, none];
      case OPS.RMDIR: await fs.rmdir(req.path); return [0, none];
      case OPS.RENAME: await fs.rename(req.from, req.to); return [0, none];
      case OPS.SYMLINK: await fs.symlink(req.target, req.path); return [0, none];
      case OPS.READLINK: return [0, this.enc.encode(await fs.readlink(req.path))];
      case OPS.CHMOD: await fs.chmod(req.path, req.mode); return [0, none];
      default: return [-ERRNO.EINVAL, none];
    }
  }
}

/**
 * Run an x86-64 Linux ELF in Blink. `path` is the Shiro path of the binary
 * (the guest sees the Shiro filesystem, so it is loaded from there).
 * Resolves with the exit status.
 */
export async function runElfWithBlink(path: string, args: string[], opts: BlinkRunOptions): Promise<number> {
  const chan = new SharedArrayBuffer(CHANNEL_BYTES);
  const server = new FsServer(opts.fs, chan);
  const mounts = (await opts.fs.readdir('/')).map((n) => '/' + n);
  const stdin = typeof opts.stdin === 'string' ? new TextEncoder().encode(opts.stdin) : (opts.stdin || new Uint8Array(0));
  const host = await startHost();
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() } as Record<number, TextDecoder>;

  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      host.terminate();
      resolve(code);
    };
    opts.signal?.addEventListener('abort', () => finish(128 + 9));
    host.onError((e) => {
      opts.writeStderr(`blink: ${e?.message || e}\n`);
      finish(126);
    });
    host.onMessage((msg) => {
      if (!msg || finished) return;
      switch (msg.type) {
        case 'fs': void server.service(); break;
        case 'out': {
          const text = decoders[msg.fd].decode(msg.data, { stream: true });
          if (text) (msg.fd === 2 ? opts.writeStderr : opts.writeStdout)(text);
          break;
        }
        case 'exit': finish(msg.code); break;
        case 'error':
          opts.writeStderr(`blink: ${msg.message}\n`);
          finish(134);
          break;
      }
    });
    host.post({
      type: 'run',
      argv: [path, ...args],
      env: opts.env,
      cwd: opts.cwd,
      stdin,
      mounts,
      chan,
      moduleUrl: defaultAssetBase() + 'blink.mjs',
    });
  });
}
