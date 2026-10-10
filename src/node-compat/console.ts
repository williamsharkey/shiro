import type { CommandContext } from '../commands/index';
import type { SharedState } from './types';
import { formatWithOptions, inspect } from './inspect';

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
      const s = formatLog(args, _st.stdoutToTerminal);
      stdoutBuf.push(s + '\n');
      if (_st.stdoutToTerminal && ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
    },
    info: (...args: any[]) => {
      const s = formatLog(args, _st.stdoutToTerminal);
      stdoutBuf.push(s + '\n');
      if (_st.stdoutToTerminal && ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
    },
    warn: (...args: any[]) => { stderrBuf.push(formatLog(args, !!ctx.terminal) + '\n'); },
    error: (...args: any[]) => { stderrBuf.push(formatLog(args, !!ctx.terminal) + '\n'); },
    dir: (obj: any, opts?: any) => {
      const s = inspect(obj, { colors: _st.stdoutToTerminal, ...(opts && typeof opts === 'object' ? opts : {}), customInspect: false });
      stdoutBuf.push(s + '\n');
      if (_st.stdoutToTerminal && ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n') + '\r\n'); }
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

  // Nothing prints after process.exit() (catch blocks the unwinding passes through)
  for (const k of ['log', 'info', 'warn', 'error', 'dir', 'debug', 'trace', 'table']) {
    const orig = fakeConsole[k];
    fakeConsole[k] = (...args: any[]) => { if (!_st.outputClosed) orig(...args); };
  }

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
    log(...args: any[]) { const s = formatLog(args) + '\n'; if (this._stdout?.write) this._stdout.write(s); else { stdoutBuf.push(s); if (_st.stdoutToTerminal && ctx.terminal) { _st.streamedToTerminal = true; ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n')); } } }
    info(...args: any[]) { this.log(...args); }
    warn(...args: any[]) { const s = formatLog(args) + '\n'; if (this._stderr?.write) this._stderr.write(s); else { stderrBuf.push(s); } }
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

/** console.log's arguments as node prints them: printf-style %s %d %i %f %j
 *  %o %O %c %% in a leading string (mocha's reporters use them), then the
 *  rest separated by spaces, values as util.inspect shows them (in color
 *  on a terminal, as node does). */
export function formatLog(args: any[], colors = false): string {
  return formatWithOptions({ colors }, args);
}
