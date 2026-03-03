/**
 * service-manager.ts — Init system for Shiro
 *
 * ServiceManager singleton: start/stop/restart services, parse config files,
 * maintain a ring buffer of log entries accessible via /var/log/syslog.
 */

import type { FileSystem } from './filesystem';
import { Shell } from './shell';

// ── Log Entry ───────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: number;
  unit: string;
  message: string;
  priority: 'info' | 'error' | 'warn';
}

// ── Service Config ──────────────────────────────────────────────────

export interface ServiceConfig {
  name: string;
  description: string;
  execStart: string;
  restart: 'no' | 'always' | 'on-failure';
  restartSec: number;
}

// ── Service State ───────────────────────────────────────────────────

export type ServiceStatus = 'active' | 'inactive' | 'failed' | 'activating';

export interface ServiceState {
  config: ServiceConfig;
  status: ServiceStatus;
  pid: number;
  startTime: number;
  restarts: number;
  exitCode: number;
  /** Timer for auto-restart */
  restartTimer: ReturnType<typeof setTimeout> | null;
  /** Timer for periodic exec */
  runTimer: ReturnType<typeof setInterval> | null;
}

// ── Crontab Entry ───────────────────────────────────────────────────

export interface CronEntry {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
  command: string;
  raw: string;
}

// ── ServiceManager ──────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 10000;
let nextServicePid = 2000;

export class ServiceManager {
  private services = new Map<string, ServiceState>();
  private logs: LogEntry[] = [];
  private cronEntries: CronEntry[] = [];
  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private lastCronMinute = -1;
  private fs: FileSystem | null = null;
  private shell: Shell | null = null;

  /** Bind to filesystem and shell for command execution */
  bind(fs: FileSystem, shell: Shell): void {
    this.fs = fs;
    this.shell = shell;
  }

  // ── Logging ─────────────────────────────────────────────────────

  log(unit: string, message: string, priority: LogEntry['priority'] = 'info'): void {
    this.logs.push({ timestamp: Date.now(), unit, message, priority });
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    }
  }

  getLogs(unit?: string, count?: number): LogEntry[] {
    let entries = unit
      ? this.logs.filter(e => e.unit === unit)
      : [...this.logs];
    if (count && count > 0) {
      entries = entries.slice(-count);
    }
    return entries;
  }

  /** Get all logs as syslog-formatted text */
  getSyslog(): string {
    return this.logs.map(e => {
      const d = new Date(e.timestamp);
      const ts = d.toLocaleString();
      return `${ts} ${e.unit}: ${e.message}`;
    }).join('\n') + '\n';
  }

  // ── Config Parsing ──────────────────────────────────────────────

  parseServiceConfig(name: string, content: string): ServiceConfig {
    const config: ServiceConfig = {
      name,
      description: '',
      execStart: '',
      restart: 'no',
      restartSec: 1,
    };

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '' || trimmed.startsWith('[')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.substring(0, eq).trim();
      const value = trimmed.substring(eq + 1).trim();

      switch (key) {
        case 'Description': config.description = value; break;
        case 'ExecStart': config.execStart = value; break;
        case 'Restart':
          if (value === 'always' || value === 'on-failure' || value === 'no') {
            config.restart = value;
          }
          break;
        case 'RestartSec': config.restartSec = parseInt(value, 10) || 1; break;
      }
    }

    return config;
  }

  // ── Service Lifecycle ───────────────────────────────────────────

  async loadService(name: string): Promise<ServiceConfig | null> {
    if (!this.fs) return null;
    const path = `/etc/services/${name}.conf`;
    try {
      const content = await this.fs.readFile(path, 'utf8');
      if (typeof content !== 'string') return null;
      return this.parseServiceConfig(name, content);
    } catch {
      return null;
    }
  }

  async start(name: string): Promise<boolean> {
    const existing = this.services.get(name);
    if (existing && existing.status === 'active') {
      this.log(name, 'Service is already active', 'warn');
      return false;
    }

    const config = existing?.config || await this.loadService(name);
    if (!config) {
      this.log(name, `Service ${name} not found`, 'error');
      return false;
    }

    if (!config.execStart) {
      this.log(name, 'No ExecStart defined', 'error');
      return false;
    }

    const pid = nextServicePid++;
    const state: ServiceState = {
      config,
      status: 'activating',
      pid,
      startTime: Date.now(),
      restarts: existing?.restarts || 0,
      exitCode: 0,
      restartTimer: null,
      runTimer: null,
    };
    this.services.set(name, state);
    this.log(name, `Starting ${config.description || name}...`);

    // Execute the command asynchronously
    this.runService(name, state);

    state.status = 'active';
    this.log(name, `Started ${config.description || name} (PID ${pid})`);
    return true;
  }

  private async runService(name: string, state: ServiceState): Promise<void> {
    if (!this.shell) return;

    try {
      const fork = this.shell.fork();
      let output = '';
      await fork.execute(state.config.execStart, (text: string) => {
        output += text;
      });
      this.log(name, output.trim() || 'Command completed');
      state.exitCode = 0;
    } catch (e: any) {
      this.log(name, `Error: ${e.message}`, 'error');
      state.exitCode = 1;
      state.status = 'failed';

      // Auto-restart logic
      if (state.config.restart === 'always' || state.config.restart === 'on-failure') {
        this.scheduleRestart(name, state);
      }
    }
  }

  private scheduleRestart(name: string, state: ServiceState): void {
    const delaySec = state.config.restartSec;
    this.log(name, `Scheduled restart in ${delaySec}s`);
    state.restartTimer = setTimeout(() => {
      state.restarts++;
      this.log(name, `Restarting (attempt ${state.restarts})`);
      state.status = 'activating';
      state.pid = nextServicePid++;
      state.startTime = Date.now();
      this.runService(name, state);
      state.status = 'active';
    }, delaySec * 1000);
  }

  stop(name: string): boolean {
    const state = this.services.get(name);
    if (!state) {
      this.log(name, `Service ${name} not found`, 'error');
      return false;
    }
    if (state.status === 'inactive') {
      this.log(name, 'Service is already inactive', 'warn');
      return false;
    }

    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (state.runTimer) {
      clearInterval(state.runTimer);
      state.runTimer = null;
    }

    state.status = 'inactive';
    this.log(name, `Stopped ${state.config.description || name}`);
    return true;
  }

  async restart(name: string): Promise<boolean> {
    this.stop(name);
    return this.start(name);
  }

  getStatus(name: string): ServiceState | undefined {
    return this.services.get(name);
  }

  listUnits(): ServiceState[] {
    return Array.from(this.services.values());
  }

  // ── Crontab ─────────────────────────────────────────────────────

  parseCrontab(content: string): CronEntry[] {
    const entries: CronEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length < 6) continue;

      entries.push({
        minute: parts[0],
        hour: parts[1],
        dayOfMonth: parts[2],
        month: parts[3],
        dayOfWeek: parts[4],
        command: parts.slice(5).join(' '),
        raw: trimmed,
      });
    }
    return entries;
  }

  async loadCrontab(): Promise<CronEntry[]> {
    if (!this.fs) return [];
    try {
      const content = await this.fs.readFile('/var/spool/cron/crontabs/user', 'utf8');
      if (typeof content !== 'string') return [];
      this.cronEntries = this.parseCrontab(content);
      return this.cronEntries;
    } catch {
      return [];
    }
  }

  async saveCrontab(content: string): Promise<void> {
    if (!this.fs) return;
    // Ensure directory exists
    try { await this.fs.mkdir('/var'); } catch {}
    try { await this.fs.mkdir('/var/spool'); } catch {}
    try { await this.fs.mkdir('/var/spool/cron'); } catch {}
    try { await this.fs.mkdir('/var/spool/cron/crontabs'); } catch {}
    await this.fs.writeFile('/var/spool/cron/crontabs/user', content);
    this.cronEntries = this.parseCrontab(content);
  }

  getCrontab(): CronEntry[] {
    return this.cronEntries;
  }

  /** Check if a cron field matches a given value */
  matchesCronField(field: string, value: number, _max: number): boolean {
    if (field === '*') return true;

    // Handle step: */N
    if (field.startsWith('*/')) {
      const step = parseInt(field.substring(2), 10);
      return step > 0 && value % step === 0;
    }

    // Handle comma-separated values
    const parts = field.split(',');
    for (const part of parts) {
      // Handle range: N-M
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        if (value >= start && value <= end) return true;
      } else {
        if (parseInt(part, 10) === value) return true;
      }
    }
    return false;
  }

  /** Check if a cron entry should run at the given time */
  shouldRun(entry: CronEntry, now: Date): boolean {
    return (
      this.matchesCronField(entry.minute, now.getMinutes(), 59) &&
      this.matchesCronField(entry.hour, now.getHours(), 23) &&
      this.matchesCronField(entry.dayOfMonth, now.getDate(), 31) &&
      this.matchesCronField(entry.month, now.getMonth() + 1, 12) &&
      this.matchesCronField(entry.dayOfWeek, now.getDay(), 6)
    );
  }

  /** Run one cron tick: execute any matching entries */
  async cronTick(): Promise<void> {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    // Prevent running twice in the same minute
    if (currentMinute === this.lastCronMinute) return;
    this.lastCronMinute = currentMinute;

    for (const entry of this.cronEntries) {
      if (this.shouldRun(entry, now)) {
        this.log('cron', `Running: ${entry.command}`);
        if (this.shell) {
          try {
            const fork = this.shell.fork();
            let output = '';
            await fork.execute(entry.command, (text: string) => {
              output += text;
            });
            if (output.trim()) {
              this.log('cron', output.trim());
            }
          } catch (e: any) {
            this.log('cron', `Error: ${e.message}`, 'error');
          }
        }
      }
    }
  }

  /** Start cron daemon (setInterval at 60s) */
  startCronDaemon(): void {
    if (this.cronTimer) return;
    this.log('crond', 'Cron daemon started');
    this.cronTimer = setInterval(() => this.cronTick(), 60000);
  }

  /** Stop cron daemon */
  stopCronDaemon(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
      this.log('crond', 'Cron daemon stopped');
    }
  }

  isCronRunning(): boolean {
    return this.cronTimer !== null;
  }

  /** Reset all state (for testing) */
  reset(): void {
    this.stopCronDaemon();
    for (const [, state] of this.services) {
      if (state.restartTimer) clearTimeout(state.restartTimer);
      if (state.runTimer) clearInterval(state.runTimer);
    }
    this.services.clear();
    this.logs = [];
    this.cronEntries = [];
    this.lastCronMinute = -1;
  }
}

// ── Singleton ───────────────────────────────────────────────────────

export const serviceManager: ServiceManager =
  (typeof window !== 'undefined' && (window as any).__serviceManager instanceof ServiceManager)
    ? (window as any).__serviceManager
    : new ServiceManager();
if (typeof window !== 'undefined') {
  (window as any).__serviceManager = serviceManager;
}
