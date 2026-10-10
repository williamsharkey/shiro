import type { CommandContext } from '../commands/index';

/**
 * NodeEnv: the shared state for a single `node` command invocation.
 * Every module factory receives this instead of closing over variables.
 * Each `node` invocation creates its own NodeEnv — no shared singletons.
 */
export interface NodeEnv {
  ctx: CommandContext;
  scriptPath: string;
  fileArgs: string[];

  // Output buffers
  stdoutBuf: string[];
  stderrBuf: string[];
  streamedToTerminal: boolean;

  // File system cache (sync-first pattern)
  fileCache: Map<string, string>;
  fileMtimes: Map<string, number>;

  // Module system
  moduleCache: Map<string, { exports: any }>;

  // Async coordination
  pendingPromises: Promise<any>[];

  // Process lifecycle
  exitCode: number;
  exitCalled: boolean;
  isInteractiveMode: boolean;
  scriptTimeoutId: any;
  processEvents: Record<string, Function[]>;
  deferredExitResolve: ((code: number) => void) | null;

  // Shims (assigned during init, used by modules)
  FakeBuffer: any;
  fakeProcess: any;
  fakeConsole: any;

  // Stdin passthrough ownership
  ownsStdinPassthrough: boolean;

  // Sync operation watchdog
  syncOpCount: number;
  syncResetScheduled: boolean;
}

/**
 * SharedState: lightweight subset of NodeEnv containing mutable primitives
 * shared between extracted factories and the remaining exec() code.
 * Used during the incremental migration — factories receive this as a parameter.
 */
export interface SharedState {
  /** Put the shell's cwd back when the script ends (process.chdir is the process's own) */
  restoreCwd?: () => void;
  exitCode: number;
  exitCalled: boolean;
  /** process.exit() ran its 'exit' listeners: in Node nothing runs after it,
   *  here the script unwinds by an exception, and what catch blocks on the
   *  way print is dropped */
  outputClosed?: boolean;
  /**
   * The script is past its top level, waiting on its async work: an exit now ends
   * it, interactive or not (its output closes, so a catch around process.exit()
   * that prints what it caught prints nothing: Gemini CLI's "critical error")
   */
  exitEnds?: boolean;
  /** Stdout goes to the terminal: there is one and stdout isn't piped or redirected */
  stdoutToTerminal: boolean;
  /** Something was written to the terminal on stdout / stderr (so it isn't returned in ctx too) */
  streamedToTerminal: boolean;
  streamedStderr: boolean;
  isInteractiveMode: boolean;
  scriptTimeoutId: any;
  ownsStdinPassthrough: boolean;
  /** process.stdin reading the terminal's pty (tty-stdin.ts): closed when the script ends */
  ttyStdin?: { close(): void };
  deferredExitResolve: ((code: number) => void) | null;
  fakeProcess: any;  // set after createFakeProcess() returns
  portDetected?: boolean;
  /** Globals this script installed, so exit only restores them while still ours */
  installedFetch?: typeof fetch;
  installedSetTimeout?: typeof setTimeout;
  installedClearTimeout?: typeof clearTimeout;
  installedSetInterval?: typeof setInterval;
  installedClearInterval?: typeof clearInterval;
}

/** Sync FS operation watchdog limit */
export const SYNC_OP_LIMIT = 50_000;

/** Tick the sync-op watchdog; throws if too many sync ops without yielding. */
export function tickSyncOps(env: NodeEnv): void {
  if (++env.syncOpCount > SYNC_OP_LIMIT) {
    env.syncOpCount = 0;
    throw new Error(
      `ENOMEM: too many synchronous filesystem operations without yielding (${SYNC_OP_LIMIT}). ` +
      `Use async fs methods (fs.promises.readdir, etc.) for recursive directory traversal.`
    );
  }
  if (!env.syncResetScheduled) {
    env.syncResetScheduled = true;
    Promise.resolve().then(() => { env.syncOpCount = 0; env.syncResetScheduled = false; });
  }
}
