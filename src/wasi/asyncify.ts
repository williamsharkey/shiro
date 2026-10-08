/**
 * asyncify.ts — capture and rewind the WASM call stack of an asyncified
 * module, for WASIX setjmp/longjmp (stack_checkpoint / stack_restore) and
 * fork (proc_fork).
 *
 * WASIX toolchains run binaryen's asyncify pass over their output (bash,
 * dash, php, ... export asyncify_start_unwind & co.), with the stack
 * imports in its list. An import that wants to capture the stack calls
 * `startUnwind`; every frame then saves its locals into a buffer and
 * returns, until the entry export (`_start`) returns to the driver
 * (guest-worker.ts). The driver handles the action and calls
 * `startRewind`, then the entry export again: the frames restore their
 * locals and call the same import, which sees `rewinding` and returns the
 * value the action left (0 for a fresh setjmp, the longjmp value, the
 * child pid or 0 after fork).
 *
 * Like Wasmer, the asyncify buffer lives at the bottom of the main thread's
 * shadow stack (`__data_end` up to the current stack pointer), which is
 * unused memory below the live frames. Only the asyncify data (wasm locals)
 * and the exported mutable globals (`__stack_pointer`, `__tls_base`) are
 * saved: linear memory is left alone, so after a longjmp the frames above
 * the setjmp caller see their current contents, as in C.
 */

export const ASYNCIFY_NORMAL = 0, ASYNCIFY_UNWINDING = 1, ASYNCIFY_REWINDING = 2;

/** A captured stack: asyncify data plus the mutable globals at the time. */
export interface StackCapture {
  /** Asyncify data (saved locals), as written by the unwind. */
  data: Uint8Array;
  /** Exported mutable i32 globals by name. */
  globals: Record<string, number>;
}

type Exports = Record<string, any>;

export class Asyncify {
  /** What the import that started the unwind wants done (read by the driver). */
  pending: unknown = null;
  /** Value the rewound import returns. */
  private resumeValue: unknown = undefined;
  private readonly buf: number;
  private readonly stackUpper: number;

  private constructor(private exp: Exports, private memory: () => WebAssembly.Memory, lower: number, upper: number) {
    this.buf = (lower + 15) & ~15;
    this.stackUpper = upper;
  }

  /**
   * For an asyncified module's main thread, or null (not asyncified, or no
   * `__data_end` / initial stack pointer to place the buffer).
   */
  static attach(exp: Exports, memory: () => WebAssembly.Memory, initialSp?: number): Asyncify | null {
    for (const f of ['asyncify_start_unwind', 'asyncify_stop_unwind', 'asyncify_start_rewind', 'asyncify_stop_rewind', 'asyncify_get_state']) {
      if (typeof exp[f] !== 'function') return null;
    }
    const lower = globalValue(exp.__data_end);
    const upper = initialSp ?? globalValue(exp.__stack_pointer);
    if (lower === undefined || upper === undefined || upper <= lower + 1024) return null;
    return new Asyncify(exp, memory, lower, upper);
  }

  get state(): number { return this.exp.asyncify_get_state(); }
  get rewinding(): boolean { return this.state === ASYNCIFY_REWINDING; }
  get unwinding(): boolean { return this.state === ASYNCIFY_UNWINDING; }

  /** Ask every frame to save itself and return; `action` is for the driver. */
  startUnwind(action: unknown): void {
    const sp = globalValue(this.exp.__stack_pointer) ?? this.stackUpper;
    const end = (sp & ~15) - 16; // leave the live frames alone
    if (end <= this.buf + 64) throw new Error('asyncify: no stack room to unwind');
    const v = new DataView(this.memory().buffer);
    v.setUint32(this.buf, this.buf + 8, true);
    v.setUint32(this.buf + 4, end, true);
    this.pending = action;
    this.exp.asyncify_start_unwind(this.buf);
  }

  /** After the entry export returned mid-unwind: stop and take the capture. */
  stopUnwind(): StackCapture {
    this.exp.asyncify_stop_unwind();
    const v = new DataView(this.memory().buffer);
    const pos = v.getUint32(this.buf, true);
    const data = new Uint8Array(this.memory().buffer).slice(this.buf + 8, pos);
    return { data, globals: this.captureGlobals() };
  }

  /** Arrange for the next call of the entry export to rewind `cap`; the import then returns `value`. */
  startRewind(cap: StackCapture, value: unknown): void {
    const start = this.buf + 8;
    const sp = cap.globals.__stack_pointer ?? this.stackUpper;
    if (start + cap.data.length > (sp & ~15) - 16) throw new Error('asyncify: stack capture does not fit');
    new Uint8Array(this.memory().buffer).set(cap.data, start);
    const v = new DataView(this.memory().buffer);
    v.setUint32(this.buf, start + cap.data.length, true);
    v.setUint32(this.buf + 4, (sp & ~15) - 16, true);
    for (const [name, val] of Object.entries(cap.globals)) {
      const g = this.exp[name];
      if (g instanceof WebAssembly.Global) g.value = val;
    }
    this.resumeValue = value;
    this.pending = null;
    this.exp.asyncify_start_rewind(this.buf);
  }

  /** Called by the rewound import: back to normal execution; returns the value to hand back. */
  finishRewind<T>(): T {
    this.exp.asyncify_stop_rewind();
    const v = this.resumeValue as T;
    this.resumeValue = undefined;
    return v;
  }

  private captureGlobals(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, g] of Object.entries(this.exp)) {
      if (!(g instanceof WebAssembly.Global)) continue;
      try {
        const val = g.value;
        if (typeof val !== 'number') continue;
        g.value = val; // throws for immutable globals
        out[name] = val;
      } catch { /* immutable */ }
    }
    return out;
  }
}

function globalValue(g: unknown): number | undefined {
  return g instanceof WebAssembly.Global && typeof g.value === 'number' ? g.value : undefined;
}

/** FNV-1a over bytes and numbers: snapshot keys for setjmp (equal stacks share one entry). */
export function hashCapture(cap: StackCapture): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ cap.data.length;
  for (let i = 0; i < cap.data.length; i++) {
    h1 = Math.imul(h1 ^ cap.data[i], 0x01000193);
    h2 = Math.imul(h2 ^ cap.data[i], 0x5bd1e995) ^ (h2 >>> 15);
  }
  for (const k of Object.keys(cap.globals).sort()) {
    h1 = Math.imul(h1 ^ cap.globals[k], 0x01000193);
    h2 = Math.imul(h2 ^ cap.globals[k], 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
