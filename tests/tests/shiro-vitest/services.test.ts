import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { ServiceManager, serviceManager } from '@shiro/service-manager';

describe('Init System + Cron', () => {
  let shell: Shell;
  let fs: FileSystem;
  let mgr: ServiceManager;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    // Reset the global singleton so commands see clean state
    serviceManager.reset();
    serviceManager.bind(fs, shell);
    // Also create a local ref for unit tests
    mgr = serviceManager;
  });

  afterEach(() => {
    mgr.reset();
  });

  // ── ServiceManager unit tests ─────────────────────────────────

  describe('ServiceManager', () => {
    it('parses INI-style service config', () => {
      const config = mgr.parseServiceConfig('test', [
        '[Unit]',
        'Description=Test Service',
        '',
        '[Service]',
        'ExecStart=echo hello',
        'Restart=always',
        'RestartSec=5',
      ].join('\n'));

      expect(config.name).toBe('test');
      expect(config.description).toBe('Test Service');
      expect(config.execStart).toBe('echo hello');
      expect(config.restart).toBe('always');
      expect(config.restartSec).toBe(5);
    });

    it('defaults for missing config fields', () => {
      const config = mgr.parseServiceConfig('minimal', 'ExecStart=true\n');
      expect(config.description).toBe('');
      expect(config.restart).toBe('no');
      expect(config.restartSec).toBe(1);
    });

    it('logging ring buffer works', () => {
      mgr.log('test', 'message 1');
      mgr.log('test', 'message 2', 'error');
      mgr.log('other', 'message 3');

      const all = mgr.getLogs();
      expect(all.length).toBe(3);

      const filtered = mgr.getLogs('test');
      expect(filtered.length).toBe(2);

      const limited = mgr.getLogs(undefined, 1);
      expect(limited.length).toBe(1);
      expect(limited[0].unit).toBe('other');
    });

    it('getSyslog returns formatted text', () => {
      mgr.log('myunit', 'hello world');
      const syslog = mgr.getSyslog();
      expect(syslog).toContain('myunit');
      expect(syslog).toContain('hello world');
    });

    it('starts and stops a service', async () => {
      // Create service config
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/hello.conf', [
        '[Unit]',
        'Description=Hello Service',
        '[Service]',
        'ExecStart=echo hello from service',
      ].join('\n'));

      const started = await mgr.start('hello');
      expect(started).toBe(true);

      const state = mgr.getStatus('hello');
      expect(state).toBeDefined();
      expect(state!.status).toBe('active');
      expect(state!.config.description).toBe('Hello Service');

      const stopped = mgr.stop('hello');
      expect(stopped).toBe(true);
      expect(mgr.getStatus('hello')!.status).toBe('inactive');
    });

    it('listUnits returns all services', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/svc1.conf', 'ExecStart=echo 1\nDescription=Svc One\n');
      await fs.writeFile('/etc/services/svc2.conf', 'ExecStart=echo 2\nDescription=Svc Two\n');

      await mgr.start('svc1');
      await mgr.start('svc2');

      const units = mgr.listUnits();
      expect(units.length).toBe(2);
    });

    it('refuses to start already active service', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/dup.conf', 'ExecStart=echo dup\n');

      await mgr.start('dup');
      const again = await mgr.start('dup');
      expect(again).toBe(false);
    });

    it('start fails for unknown service', async () => {
      const ok = await mgr.start('nonexistent');
      expect(ok).toBe(false);
    });

    it('restart stops then starts', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/rsvc.conf', 'ExecStart=echo restarted\n');

      await mgr.start('rsvc');
      const ok = await mgr.restart('rsvc');
      expect(ok).toBe(true);
      expect(mgr.getStatus('rsvc')!.status).toBe('active');
    });
  });

  // ── Crontab parsing ───────────────────────────────────────────

  describe('Crontab parsing', () => {
    it('parses standard crontab entries', () => {
      const entries = mgr.parseCrontab([
        '# comment',
        '*/5 * * * * echo tick',
        '0 12 * * 1-5 echo lunch',
        '',
        '30 2 1 * * echo monthly',
      ].join('\n'));

      expect(entries.length).toBe(3);
      expect(entries[0].minute).toBe('*/5');
      expect(entries[0].command).toBe('echo tick');
      expect(entries[1].hour).toBe('12');
      expect(entries[1].dayOfWeek).toBe('1-5');
      expect(entries[2].dayOfMonth).toBe('1');
    });

    it('ignores malformed lines', () => {
      const entries = mgr.parseCrontab('bad line\ntoo few');
      expect(entries.length).toBe(0);
    });
  });

  // ── Cron field matching ───────────────────────────────────────

  describe('Cron matching', () => {
    it('star matches all', () => {
      expect(mgr.matchesCronField('*', 0, 59)).toBe(true);
      expect(mgr.matchesCronField('*', 23, 23)).toBe(true);
    });

    it('exact value matches', () => {
      expect(mgr.matchesCronField('5', 5, 59)).toBe(true);
      expect(mgr.matchesCronField('5', 6, 59)).toBe(false);
    });

    it('step (*/N) matches', () => {
      expect(mgr.matchesCronField('*/15', 0, 59)).toBe(true);
      expect(mgr.matchesCronField('*/15', 15, 59)).toBe(true);
      expect(mgr.matchesCronField('*/15', 30, 59)).toBe(true);
      expect(mgr.matchesCronField('*/15', 7, 59)).toBe(false);
    });

    it('range (N-M) matches', () => {
      expect(mgr.matchesCronField('1-5', 3, 6)).toBe(true);
      expect(mgr.matchesCronField('1-5', 0, 6)).toBe(false);
      expect(mgr.matchesCronField('1-5', 6, 6)).toBe(false);
    });

    it('comma-separated values match', () => {
      expect(mgr.matchesCronField('1,3,5', 3, 59)).toBe(true);
      expect(mgr.matchesCronField('1,3,5', 4, 59)).toBe(false);
    });

    it('shouldRun checks all fields', () => {
      const entry = mgr.parseCrontab('30 14 * * 1 echo monday')[0];
      // Monday at 14:30
      const monday = new Date(2026, 2, 2, 14, 30); // March 2, 2026 is Monday
      expect(mgr.shouldRun(entry, monday)).toBe(true);

      const tuesday = new Date(2026, 2, 3, 14, 30);
      expect(mgr.shouldRun(entry, tuesday)).toBe(false);
    });
  });

  // ── Cron daemon ───────────────────────────────────────────────

  describe('Cron daemon', () => {
    it('starts and stops', () => {
      expect(mgr.isCronRunning()).toBe(false);
      mgr.startCronDaemon();
      expect(mgr.isCronRunning()).toBe(true);
      mgr.stopCronDaemon();
      expect(mgr.isCronRunning()).toBe(false);
    });

    it('cronTick runs matching entries', async () => {
      const now = new Date();
      const minute = String(now.getMinutes());
      const hour = String(now.getHours());

      // Force a crontab that matches right now
      await mgr.saveCrontab(`${minute} ${hour} * * * echo cron-ran`);

      // Reset lastCronMinute to allow execution
      (mgr as any).lastCronMinute = -1;

      await mgr.cronTick();

      const logs = mgr.getLogs('cron');
      expect(logs.some(l => l.message.includes('Running: echo cron-ran'))).toBe(true);
    });
  });

  // ── systemctl command ─────────────────────────────────────────

  describe('systemctl command', () => {
    it('shows help with no args', async () => {
      const { output, exitCode } = await run(shell, 'systemctl');
      expect(exitCode).toBe(1);
      expect(output).toContain('Usage:');
    });

    it('shows help with --help', async () => {
      const { output, exitCode } = await run(shell, 'systemctl --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('start');
    });

    it('start and status', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/web.conf', [
        '[Service]',
        'Description=Web Server',
        'ExecStart=echo serving',
      ].join('\n'));

      const start = await run(shell, 'systemctl start web');
      expect(start.exitCode).toBe(0);

      const status = await run(shell, 'systemctl status web');
      expect(status.output).toContain('web.service');
      expect(status.output).toContain('Web Server');
    });

    it('stop works', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/svc.conf', 'ExecStart=echo hi\n');

      await run(shell, 'systemctl start svc');
      const { exitCode } = await run(shell, 'systemctl stop svc');
      expect(exitCode).toBe(0);
    });

    it('restart works', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/rs.conf', 'ExecStart=echo restarted\n');

      await run(shell, 'systemctl start rs');
      const { exitCode } = await run(shell, 'systemctl restart rs');
      expect(exitCode).toBe(0);
    });

    it('list-units', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/a.conf', 'ExecStart=echo a\nDescription=Alpha\n');
      await fs.writeFile('/etc/services/b.conf', 'ExecStart=echo b\nDescription=Beta\n');

      await run(shell, 'systemctl start a');
      await run(shell, 'systemctl start b');
      const { output, exitCode } = await run(shell, 'systemctl list-units');
      expect(exitCode).toBe(0);
      expect(output).toContain('Alpha');
      expect(output).toContain('Beta');
      expect(output).toContain('2 loaded units');
    });

    it('status for unknown service', async () => {
      const { exitCode, output } = await run(shell, 'systemctl status nope');
      expect(exitCode).toBe(4);
      expect(output).toContain('could not be found');
    });

    it('enable/disable are no-ops', async () => {
      const { exitCode: e1 } = await run(shell, 'systemctl enable myservice');
      expect(e1).toBe(0);
      const { exitCode: e2 } = await run(shell, 'systemctl disable myservice');
      expect(e2).toBe(0);
    });

    it('unknown subcommand', async () => {
      const { exitCode } = await run(shell, 'systemctl frobnicate');
      expect(exitCode).toBe(1);
    });

    it('handles .service suffix', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/myapp.conf', 'ExecStart=echo myapp\nDescription=My App\n');

      const { exitCode } = await run(shell, 'systemctl start myapp.service');
      expect(exitCode).toBe(0);
    });
  });

  // ── crontab command ───────────────────────────────────────────

  describe('crontab command', () => {
    it('shows help with no args', async () => {
      const { output, exitCode } = await run(shell, 'crontab');
      expect(exitCode).toBe(1);
      expect(output).toContain('Usage:');
    });

    it('-l with no crontab', async () => {
      // Ensure no crontab file exists (shared IndexedDB may have leftovers)
      try { await fs.unlink('/var/spool/cron/crontabs/user'); } catch {}
      const { exitCode, output } = await run(shell, 'crontab -l');
      expect(exitCode).toBe(1);
      expect(output).toContain('no crontab');
    });

    it('installs from file and lists', async () => {
      await fs.writeFile('/home/user/mycron', '*/5 * * * * echo tick\n0 12 * * * echo noon\n');
      const install = await run(shell, 'crontab mycron');
      expect(install.exitCode).toBe(0);
      expect(install.output).toContain('2 entries');

      const list = await run(shell, 'crontab -l');
      expect(list.exitCode).toBe(0);
      expect(list.output).toContain('echo tick');
      expect(list.output).toContain('echo noon');
    });

    it('-r removes crontab', async () => {
      await fs.writeFile('/home/user/cr', '* * * * * echo test\n');
      await run(shell, 'crontab cr');

      const { exitCode } = await run(shell, 'crontab -r');
      expect(exitCode).toBe(0);

      const list = await run(shell, 'crontab -l');
      expect(list.exitCode).toBe(1);
    });

    it('-e shows unsupported message', async () => {
      const { exitCode, output } = await run(shell, 'crontab -e');
      expect(exitCode).toBe(1);
      expect(output).toContain('not supported');
    });

    it('missing file errors', async () => {
      const { exitCode, output } = await run(shell, 'crontab nonexistent');
      expect(exitCode).toBe(1);
      expect(output).toContain('No such file');
    });
  });

  // ── journalctl command ────────────────────────────────────────

  describe('journalctl command', () => {
    it('shows help with --help', async () => {
      const { output, exitCode } = await run(shell, 'journalctl --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('-u');
    });

    it('shows no entries when empty', async () => {
      const { output, exitCode } = await run(shell, 'journalctl');
      expect(exitCode).toBe(0);
      expect(output).toContain('No entries');
    });

    it('shows logs after service starts', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/logsvc.conf', 'ExecStart=echo log-output\nDescription=Logging Service\n');

      await run(shell, 'systemctl start logsvc');
      const { output, exitCode } = await run(shell, 'journalctl -u logsvc');
      expect(exitCode).toBe(0);
      expect(output).toContain('logsvc');
    });

    it('-n limits entries', async () => {
      try { await fs.mkdir('/etc'); } catch {}
      try { await fs.mkdir('/etc/services'); } catch {}
      await fs.writeFile('/etc/services/multi.conf', 'ExecStart=echo line1\n');

      await run(shell, 'systemctl start multi');
      await run(shell, 'systemctl stop multi');
      await run(shell, 'systemctl start multi');

      const { output } = await run(shell, 'journalctl -n 2');
      // Should have at most 2 entries
      const lines = output.trim().split('\n').filter(l => l.includes('shiro'));
      expect(lines.length).toBeLessThanOrEqual(2);
    });
  });

  // ── /var/log virtual filesystem ───────────────────────────────

  describe('/var/log virtual filesystem', () => {
    it('/var/log/syslog exists', async () => {
      const stat = await fs.stat('/var/log/syslog');
      expect(stat).toBeDefined();
    });

    it('/var/log is a directory', async () => {
      const stat = await fs.stat('/var/log');
      expect(stat).toBeDefined();
      expect(stat!.isDirectory()).toBe(true);
    });

    it('/var/log readdir returns syslog and journal', async () => {
      const entries = await fs.readdir('/var/log');
      expect(entries).toContain('syslog');
      expect(entries).toContain('journal');
    });
  });
});
