/**
 * node:wasi — node's WASI class (preview1) on src/wasi's WasiGuest.
 *
 * As a kernel guest (node in a Worker, the default) the imports are the
 * same preview1 code WASM processes run: each call is a blocking syscall on
 * this node's channel, so files, pipes and the terminal are the process's
 * own fds, and a preopen is a directory fd opened in the kernel. A
 * worker_threads thread has a channel of its own, so a threaded module
 * (wasm32-wasip1-threads, napi-rs/emnapi: rolldown's binding) instantiates
 * WASI in each thread as on node.
 *
 * In the page (TABCOMPUTER_NODE_WORKER=0, or no SharedArrayBuffer) there is
 * no blocking channel: constructing a WASI throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM.
 */
import * as A from '../../kernel/abi';
import type { SysReply, SysRequest } from '../../wasi/abi';
import type { WasiGuest, GuestOptions, Preopen, runSync as RunSync } from '../../wasi/wasi-guest';
import type { NodeGuestHooks } from '../../node-worker/hooks';

/**
 * What node:wasi needs of a guest: blocking syscalls, directory fds for
 * preopens, and src/wasi's preview1 code (the guest bundle has it; the page
 * never loads it for node, where node:wasi can't run).
 */
export interface WasiSys {
  call(req: SysRequest): SysReply;
  dataSize: number;
  /** Open a directory for a preopen: a kernel fd, or -errno */
  openDir(path: string): number;
  newGuest(opts: GuestOptions): WasiGuest;
  runSync: typeof RunSync;
  /** wasi-guest.ts's ProcExit, for instanceof */
  ProcExit: new (status: number) => Error & { status: number };
}

/** proc_exit: unwinds the program's stack to start() */
class WasiExit extends Error {
  constructor(readonly code: number) { super(`WASI exit ${code}`); this.name = 'WASIExit'; }
}

const nodeError = (code: string, message: string, Ctor: ErrorConstructor = Error) => Object.assign(new Ctor(message), { code });

export function createWasiModule(deps: { guest?: NodeGuestHooks; exit: (code: number) => never }) {
  // node keeps these as symbols on the instance; emnapi's wasi-threads reads them by description
  const kInstance = Symbol('kInstance');
  const kSetMemory = Symbol('kSetMemory');
  const kStarted = Symbol('kStarted');

  class WASI {
    readonly wasiImport: Record<string, (...a: any[]) => any>;
    private readonly version: 'preview1' | 'unstable';
    private readonly returnOnExit: boolean;
    private readonly guest: WasiGuest;
    private readonly preopenFds: number[] = [];
    private procExit!: WasiSys['ProcExit'];
    [kInstance]: WebAssembly.Instance | null = null;
    [kStarted] = false;
    [kSetMemory]: (memory: WebAssembly.Memory) => void;

    constructor(options: {
      version?: string; args?: string[]; env?: Record<string, unknown>;
      preopens?: Record<string, string>; returnOnExit?: boolean;
      stdin?: number; stdout?: number; stderr?: number;
    } = {}) {
      if (options === null || typeof options !== 'object') throw nodeError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object.', TypeError as any);
      if (options.version !== 'preview1' && options.version !== 'unstable') {
        throw nodeError('ERR_INVALID_ARG_VALUE', `The property 'options.version' must be one of: 'unstable', 'preview1'. Received ${JSON.stringify(options.version)}`, TypeError as any);
      }
      const sys = (deps.guest as { wasi?: WasiSys } | undefined)?.wasi;
      if (!sys) throw nodeError('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'node:wasi needs node to run as a kernel guest in a Worker (unset TABCOMPUTER_NODE_WORKER=0; the page must be cross-origin isolated)');
      for (const fd of [options.stdin, options.stdout, options.stderr]) {
        if (fd !== undefined && fd !== 0 && fd !== 1 && fd !== 2) throw nodeError('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'node:wasi: stdin/stdout/stderr other than this process\'s 0, 1 and 2');
      }
      this.version = options.version;
      this.returnOnExit = options.returnOnExit ?? true;
      const args = (options.args ?? []).map(String);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.env ?? {})) if (v !== undefined) env[k] = String(v);
      const preopens: Preopen[] = [];
      for (const [name, path] of Object.entries(options.preopens ?? {})) {
        const fd = sys.openDir(String(path));
        if (fd < 0) throw Object.assign(new Error(`node:wasi: preopen ${path}: errno ${-fd}`), { code: fd === -A.ENOTDIR ? 'ENOTDIR' : 'ENOENT', errno: fd });
        this.preopenFds.push(fd);
        preopens.push({ fd, name, path: String(path) });
      }
      const guest = this.guest = sys.newGuest({ args, env, preopens, dataSize: sys.dataSize });
      this.procExit = sys.ProcExit;
      this[kSetMemory] = (memory) => { guest.memory = memory; };
      const call = sys.call;
      const imports: Record<string, (...a: any[]) => any> = {};
      for (const [name, impl] of Object.entries(guest.functions().wasi_snapshot_preview1)) {
        imports[name] = (...a: any[]) => {
          const out = impl(...a);
          return out && typeof out.next === 'function' ? sys.runSync(out, call) : out;
        };
      }
      // proc_exit ends the program, not the node running it
      imports.proc_exit = (code: number) => { throw new WasiExit(code >>> 0); };
      this.wasiImport = imports;
    }

    getImportObject(): Record<string, Record<string, (...a: any[]) => any>> {
      return { [this.version === 'unstable' ? 'wasi_unstable' : 'wasi_snapshot_preview1']: this.wasiImport };
    }

    private attach(instance: WebAssembly.Instance, want: '_start' | '_initialize'): Record<string, any> {
      if (instance === null || typeof instance !== 'object' || !('exports' in instance)) {
        throw nodeError('ERR_INVALID_ARG_TYPE', 'The "instance" argument must be an instance of WebAssembly.Instance.', TypeError as any);
      }
      const exp = instance.exports as Record<string, any>;
      if (!(exp.memory instanceof WebAssembly.Memory)) throw nodeError('ERR_INVALID_ARG_TYPE', 'The "instance.exports.memory" property must be a WebAssembly.Memory object.', TypeError as any);
      if (this[kStarted]) throw nodeError('ERR_WASI_ALREADY_STARTED', 'WASI instance has already started');
      if (want === '_start' && typeof exp._start !== 'function') throw nodeError('ERR_INVALID_ARG_TYPE', 'The "instance.exports._start" property must be of type function.', TypeError as any);
      if (want === '_initialize' && '_start' in exp && exp._start !== undefined) throw nodeError('ERR_INVALID_ARG_TYPE', 'The "instance.exports._start" property must be undefined.', TypeError as any);
      this[kStarted] = true;
      this[kInstance] = instance;
      this[kSetMemory](exp.memory);
      this.guest.exports = exp;
      return exp;
    }

    /** Run a command module's _start; its proc_exit code (returnOnExit) or 0 */
    start(instance: WebAssembly.Instance): number {
      const exp = this.attach(instance, '_start');
      try {
        exp._start();
      } catch (e) {
        if (!(e instanceof WasiExit) && !(e instanceof this.procExit)) throw e;
        const code = e instanceof WasiExit ? e.code : A.WEXITSTATUS((e as { status: number }).status);
        if (!this.returnOnExit) deps.exit(code);
        return code;
      }
      return 0;
    }

    /** Set up a reactor module: its _initialize, if it has one */
    initialize(instance: WebAssembly.Instance): void {
      const exp = this.attach(instance, '_initialize');
      if (typeof exp._initialize === 'function') exp._initialize();
    }

    /** node 22: bind to a module that won't be started through this object */
    finalizeBindings(instance: WebAssembly.Instance, { memory }: { memory?: WebAssembly.Memory } = {}): void {
      if (this[kStarted]) throw nodeError('ERR_WASI_ALREADY_STARTED', 'WASI instance has already started');
      this[kStarted] = true;
      this[kInstance] = instance;
      this[kSetMemory](memory ?? (instance.exports as any).memory);
    }
  }

  return { WASI };
}
