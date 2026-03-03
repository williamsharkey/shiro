import type { CommandContext } from '../commands/index';
import type { SharedState } from './types';
import { formatArg } from '../commands/jseval/utils';

/**
 * Create the fake console object for the Node.js compat layer.
 * Writes to stdoutBuf/stderrBuf and optionally streams to terminal.
 */
export function createFakeConsole(
  ctx: CommandContext,
  stdoutBuf: string[],
  stderrBuf: string[],
  _st: SharedState,
): any {
  const fakeConsole: any = {
    log: (...args: any[]) => {
      const s = args.map(formatArg).join(' ');
      stdoutBuf.push(s);
      if (ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
    },
    info: (...args: any[]) => {
      const s = args.map(formatArg).join(' ');
      stdoutBuf.push(s);
      if (ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
    },
    warn: (...args: any[]) => { stderrBuf.push(args.map(formatArg).join(' ')); },
    error: (...args: any[]) => { stderrBuf.push(args.map(formatArg).join(' ')); },
    dir: (obj: any) => {
      const s = JSON.stringify(obj, null, 2);
      stdoutBuf.push(s);
      if (ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
    },
    debug: (...args: any[]) => { fakeConsole.log(...args); },
    trace: (...args: any[]) => { fakeConsole.log(...args); },
    assert: (val: any, ...args: any[]) => { if (!val) fakeConsole.error('Assertion failed:', ...args); },
    time: () => {}, timeEnd: () => {}, timeLog: () => {},
    count: () => {}, countReset: () => {},
    group: () => {}, groupEnd: () => {}, groupCollapsed: () => {},
    clear: () => { if (ctx.terminal) ctx.terminal.writeOutput('\x1b[2J\x1b[H'); },
    table: (...args: any[]) => { fakeConsole.log(...args); },
  };

  // Console constructor — Node.js API: new console.Console(stdout, stderr)
  class FakeConsoleClass {
    _stdout: any; _stderr: any;
    constructor(stdoutOrOpts?: any, stderr?: any) {
      if (stdoutOrOpts && typeof stdoutOrOpts === 'object' && stdoutOrOpts.stdout) {
        this._stdout = stdoutOrOpts.stdout;
        this._stderr = stdoutOrOpts.stderr || stdoutOrOpts.stdout;
      } else {
        this._stdout = stdoutOrOpts || _st.fakeProcess?.stdout;
        this._stderr = stderr || stdoutOrOpts || _st.fakeProcess?.stderr;
      }
    }
    log(...args: any[]) { const s = args.map(formatArg).join(' ') + '\n'; if (this._stdout?.write) this._stdout.write(s); else { stdoutBuf.push(s.replace(/\n$/, '')); if (ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n')); } } }
    info(...args: any[]) { this.log(...args); }
    warn(...args: any[]) { const s = args.map(formatArg).join(' ') + '\n'; if (this._stderr?.write) this._stderr.write(s); else { stderrBuf.push(s.replace(/\n$/, '')); } }
    error(...args: any[]) { this.warn(...args); }
    dir(obj: any) { this.log(obj); }
    debug(...args: any[]) { this.log(...args); }
    trace(...args: any[]) { this.log(...args); }
    assert(val: any, ...args: any[]) { if (!val) this.error('Assertion failed:', ...args); }
    time() {} timeEnd() {} timeLog() {}
    count() {} countReset() {}
    group() {} groupEnd() {} groupCollapsed() {}
    clear() { fakeConsole.clear(); }
    table(...args: any[]) { this.log(...args); }
  }
  fakeConsole.Console = FakeConsoleClass;

  return fakeConsole;
}
