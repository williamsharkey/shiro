/**
 * Process Table - global registry for windowed processes.
 */

import type { WindowTerminal } from './window-terminal';
import type { ServerWindow } from './server-window';

export interface ShiroProcess {
  pid: number;
  command: string;
  status: 'running' | 'stopped' | 'exited' | 'killed';
  exitCode: number;
  startTime: number;
  windowTerminal: WindowTerminal | null;
  serverWindow: ServerWindow | null;
  promise: Promise<number>;
  kill: () => void;
  abortController: AbortController | null;
  /** Exited but not yet waited for (a kernel zombie); ps shows it until it is reaped */
  zombie?: boolean;
}

/** Another registry whose processes ps/kill/top should see (the kernel's process table). */
export interface ProcessSource {
  list(): ShiroProcess[];
  get(pid: number): ShiroProcess | undefined;
  /** Send `sig` (default SIGTERM); false when the pid isn't this source's */
  kill(pid: number, sig?: number): boolean;
}

class ProcessTable {
  private processes = new Map<number, ShiroProcess>();
  private nextPid = 100;
  private sources: ProcessSource[] = [];

  /** Next pid; shared with the kernel so the two tables never collide. */
  allocatePid(): number {
    return this.nextPid++;
  }

  attachSource(source: ProcessSource): () => void {
    this.sources.push(source);
    return () => { this.sources = this.sources.filter(s => s !== source); };
  }

  allocate(command: string): ShiroProcess {
    const pid = this.allocatePid();
    const proc: ShiroProcess = {
      pid,
      command,
      status: 'running',
      exitCode: 0,
      startTime: Date.now(),
      windowTerminal: null,
      serverWindow: null,
      promise: Promise.resolve(0), // replaced by spawn
      kill: () => {}, // replaced by spawn
      abortController: null,
    };
    this.processes.set(pid, proc);
    return proc;
  }

  kill(pid: number, sig?: number): boolean {
    const proc = this.processes.get(pid);
    if (!proc) return this.sources.some(s => s.kill(pid, sig));
    if (proc.status !== 'running') return false;
    if (proc.abortController) proc.abortController.abort();
    proc.kill();
    proc.status = 'killed';
    proc.exitCode = 130;
    return true;
  }

  list(): ShiroProcess[] {
    const all = Array.from(this.processes.values());
    for (const s of this.sources) all.push(...s.list());
    return all.sort((a, b) => a.pid - b.pid);
  }

  get(pid: number): ShiroProcess | undefined {
    const own = this.processes.get(pid);
    if (own) return own;
    for (const s of this.sources) {
      const p = s.get(pid);
      if (p) return p;
    }
    return undefined;
  }

  remove(pid: number): void {
    this.processes.delete(pid);
  }

  markExited(pid: number, exitCode: number): void {
    const proc = this.processes.get(pid);
    if (proc && proc.status === 'running') {
      proc.status = 'exited';
      proc.exitCode = exitCode;
      // Auto-remove after 30 seconds
      setTimeout(() => this.processes.delete(pid), 30_000);
    }
  }
}

// Singleton — reuse window global to survive double evaluation
// (entry chunk is both inlined in HTML and loaded as file by lazy chunks)
export const processTable: ProcessTable =
  (typeof window !== 'undefined' && (window as any).__processTable?.allocate)
    ? (window as any).__processTable
    : new ProcessTable();
if (typeof window !== 'undefined') {
  (window as any).__processTable = processTable;
}
