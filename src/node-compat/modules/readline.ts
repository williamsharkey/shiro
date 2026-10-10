/**
 * readline.createInterface: lines from an input stream (process.stdin, a
 * file stream, anything with 'data'/'end'). 'line' per line, rl.question
 * takes the next line, `for await (const line of rl)`, and 'close' at the
 * input's end or rl.close(). process.stdin is read lazily (node-compat/
 * process.ts): the interface's 'data' listener is what starts it.
 *
 * On a terminal (input.isTTY, terminal not false) keys arrive one by one:
 * the line is echoed and edited here (backspace, Ctrl-U), Enter ends it,
 * Ctrl-C is 'SIGINT' (or closes), Ctrl-D on an empty line closes.
 */

type Fn = (...a: any[]) => void;

/** EventEmitter methods on `obj` (a listener's exception propagates, as in node) */
function makeEmitter(obj: any) {
  const events: Record<string, Fn[]> = {};
  obj.on = obj.addListener = (ev: string, fn: Fn) => { (events[ev] ??= []).push(fn); return obj; };
  obj.once = (ev: string, fn: Fn) => { const w = (...a: any[]) => { obj.off(ev, w); fn(...a); }; return obj.on(ev, w); };
  obj.off = obj.removeListener = (ev: string, fn: Fn) => { events[ev] = (events[ev] || []).filter((f) => f !== fn); return obj; };
  obj.removeAllListeners = (ev?: string) => { if (ev) delete events[ev]; else for (const k of Object.keys(events)) delete events[k]; return obj; };
  obj.emit = (ev: string, ...a: any[]) => { const l = [...(events[ev] || [])]; for (const f of l) f(...a); return l.length > 0; };
  obj.listenerCount = (ev: string) => (events[ev] || []).length;
  obj.listeners = (ev: string) => [...(events[ev] || [])];
  return obj;
}

export function createReadline(promises: boolean) {
  class Interface {
    terminal: boolean;
    line = '';
    cursor = 0;
    history: string[] = [];
    closed = false;
    input: any;
    output: any;
    private promptText = '> ';
    private partial = '';
    private sawCR = false;
    /** keys one by one (the input went raw): echoed and edited here; else whole lines, as a cooked tty or a pipe sends them */
    private rawKeys = false;
    private paused = false;
    private pending: string[] = [];
    private questions: ((line: string) => void)[] = [];
    private onData: Fn;
    private onEnd: Fn;
    // EventEmitter methods added by makeEmitter
    on!: (ev: string, fn: Fn) => this;
    once!: (ev: string, fn: Fn) => this;
    off!: (ev: string, fn: Fn) => this;
    emit!: (ev: string, ...args: any[]) => boolean;
    listenerCount!: (ev: string) => number;
    removeListener!: (ev: string, fn: Fn) => this;
    removeAllListeners!: (ev?: string) => this;

    constructor(input: any, output?: any, _completer?: any, terminal?: boolean) {
      makeEmitter(this);
      // createInterface({ input, output, ... }) or createInterface(input, output, completer, terminal)
      const opts: any = input && typeof input === 'object' && 'input' in input && typeof input.on !== 'function'
        ? input : { input, output, terminal };
      this.input = opts.input;
      this.output = opts.output;
      if (opts.prompt !== undefined) this.promptText = String(opts.prompt);
      this.terminal = opts.terminal ?? !!(this.output?.isTTY && this.input?.isTTY);
      this.onData = (chunk: any) => this.feed(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      this.onEnd = () => this.finish();
      if (this.input?.on) {
        this.input.on('data', this.onData);
        this.input.on('end', this.onEnd);
        // a terminal sends keys once something reads it
        if (this.input.isTTY) {
          if (this.terminal) this.input.setRawMode?.(true);
          this.rawKeys = this.terminal && !!this.input.isRaw;
          this.input.resume?.();
        }
      }
    }

    private out(s: string) { if (this.output?.write) this.output.write(s); }

    private feed(text: string) {
      if (this.closed) return;
      if (this.rawKeys) return this.keys(text);
      for (const ch of text) {
        if (ch === '\n') {
          if (this.sawCR) { this.sawCR = false; continue; } // \r\n is one end of line
          this.deliver(this.partial); this.partial = '';
        } else if (ch === '\r') {
          this.sawCR = true;
          this.deliver(this.partial); this.partial = '';
        } else {
          this.sawCR = false;
          this.partial += ch;
        }
      }
    }

    /** Keys from a terminal: echo and edit the line */
    private keys(text: string) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\r' || ch === '\n') {
          this.out('\r\n');
          const line = this.line;
          this.line = ''; this.cursor = 0;
          if (line) this.history.unshift(line);
          this.deliver(line);
        } else if (ch === '\x7f' || ch === '\b') {
          if (this.line) { this.line = this.line.slice(0, -1); this.cursor = this.line.length; this.out('\b \b'); }
        } else if (ch === '\x15') { // Ctrl-U
          this.out('\b \b'.repeat(this.line.length)); this.line = ''; this.cursor = 0;
        } else if (ch === '\x03') { // Ctrl-C
          if (this.listenerCount('SIGINT') > 0) this.emit('SIGINT');
          else { this.out('^C\r\n'); this.close(); }
          return;
        } else if (ch === '\x04') { // Ctrl-D
          if (!this.line) { this.close(); return; }
        } else if (ch === '\x1b') {
          // an escape sequence (arrows, ...): not line editing here, skip it
          if (text[i + 1] === '[' || text[i + 1] === 'O') { i += 2; while (i < text.length && !/[A-Za-z~]/.test(text[i])) i++; }
        } else if (ch >= ' ') {
          this.line += ch; this.cursor = this.line.length;
          this.out(ch);
        }
      }
    }

    private deliver(line: string) {
      if (this.paused) { this.pending.push(line); return; }
      const q = this.questions.shift();
      if (q) { q(line); return; }
      this.emit('line', line);
    }

    private finish() {
      if (this.partial) { const p = this.partial; this.partial = ''; this.deliver(p); }
      this.close();
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.input?.off?.('data', this.onData);
      this.input?.off?.('end', this.onEnd);
      if (this.rawKeys) this.input.setRawMode?.(false);
      this.input?.pause?.();
      this.emit('close');
      // questions nobody will answer (readline/promises rejects them)
      const qs = this.questions.splice(0);
      for (const q of qs) (q as any).abort?.();
    }

    pause() { this.paused = true; this.emit('pause'); return this; }
    resume() {
      this.paused = false;
      this.emit('resume');
      while (!this.paused && this.pending.length) this.deliver(this.pending.shift()!);
      return this;
    }
    setPrompt(p: string) { this.promptText = String(p); }
    getPrompt() { return this.promptText; }
    prompt(_preserveCursor?: boolean) { if (this.closed) throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' }); this.out(this.promptText); }
    /** rl.write(data): as if typed */
    write(data: any) { if (typeof data === 'string') this.feed(data); }
    getCursorPos() { return { rows: 0, cols: this.promptText.length + this.cursor }; }

    question(query: string, a?: any, b?: any): any {
      const cb: Fn | undefined = typeof a === 'function' ? a : typeof b === 'function' ? b : undefined;
      const signal: AbortSignal | undefined = typeof a === 'object' ? a?.signal : undefined;
      if (this.closed) {
        const err = Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
        if (promises) return Promise.reject(err);
        throw err;
      }
      this.out(query);
      if (promises) {
        return new Promise<string>((resolve, reject) => {
          const answer: any = (line: string) => resolve(line);
          answer.abort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
          signal?.addEventListener('abort', () => { this.questions = this.questions.filter((q) => q !== answer); answer.abort(); }, { once: true });
          this.questions.push(answer);
        });
      }
      if (cb) this.questions.push((line: string) => cb(line));
      return undefined;
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<string> {
      const queue: string[] = [];
      const waiters: ((r: IteratorResult<string>) => void)[] = [];
      let done = this.closed;
      const onLine = (l: string) => { const w = waiters.shift(); if (w) w({ value: l, done: false }); else queue.push(l); };
      const onClose = () => { done = true; for (const w of waiters.splice(0)) w({ value: undefined as any, done: true }); };
      this.on('line', onLine);
      this.on('close', onClose);
      const self = this;
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
          if (done) return Promise.resolve({ value: undefined as any, done: true });
          return new Promise((r) => waiters.push(r));
        },
        return(): Promise<IteratorResult<string>> {
          self.off('line', onLine); self.off('close', onClose);
          self.close();
          return Promise.resolve({ value: undefined as any, done: true });
        },
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }
  return {
    Interface,
    createInterface: (input: any, output?: any, completer?: any, terminal?: boolean) => new Interface(input, output, completer, terminal),
  };
}
