/**
 * Process Table - global registry for windowed processes.
 */

import type { WindowTerminal } from './window-terminal';
import type { ServerWindow } from './server-window';

export interface ShiroProcess {
  pid: number;
  command: string;
  status: 'running' | 'exited' | 'killed';
  exitCode: number;
  startTime: number;
  windowTerminal: WindowTerminal | null;
  serverWindow: ServerWindow | null;
  promise: Promise<number>;
  kill: () => void;
}

class ProcessTable {
  private processes = new Map<number, ShiroProcess>();
  private nextPid = 100;

  allocate(command: string): ShiroProcess {
    const pid = this.nextPid++;
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
    };
    this.processes.set(pid, proc);
    return proc;
  }

  kill(pid: number): boolean {
    const proc = this.processes.get(pid);
    if (!proc || proc.status !== 'running') return false;
    proc.kill();
    proc.status = 'killed';
    proc.exitCode = 130;
    return true;
  }

  list(): ShiroProcess[] {
    return Array.from(this.processes.values());
  }

  get(pid: number): ShiroProcess | undefined {
    return this.processes.get(pid);
  }

  remove(pid: number): void {
    this.processes.delete(pid);
  }

  markExited(pid: number, exitCode: number): void {
    const proc = this.processes.get(pid);
    if (proc && proc.status === 'running') {
      proc.status = 'exited';
      proc.exitCode = exitCode;
    }
  }
}

export const processTable = new ProcessTable();
