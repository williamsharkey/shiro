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
  exitCode: number;
  exitCalled: boolean;
  streamedToTerminal: boolean;
  isInteractiveMode: boolean;
  scriptTimeoutId: any;
  ownsStdinPassthrough: boolean;
  deferredExitResolve: ((code: number) => void) | null;
  fakeProcess: any;  // set after createFakeProcess() returns
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
