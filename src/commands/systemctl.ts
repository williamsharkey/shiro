/**
 * systemctl — Service manager control
 *
 * systemctl start|stop|restart|status|list-units [service]
 */

import type { Command, CommandContext } from './index';
import { serviceManager } from '../service-manager';

export const systemctlCmd: Command = {
  name: 'systemctl',
  description: 'Control the system service manager',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      ctx.stdout += 'Usage: systemctl <command> [service]\n';
      ctx.stdout += '\nCommands:\n';
      ctx.stdout += '  start <service>     Start a service\n';
      ctx.stdout += '  stop <service>      Stop a service\n';
      ctx.stdout += '  restart <service>   Restart a service\n';
      ctx.stdout += '  status [service]    Show service status\n';
      ctx.stdout += '  list-units          List all services\n';
      ctx.stdout += '  enable <service>    Enable a service (no-op)\n';
      ctx.stdout += '  disable <service>   Disable a service (no-op)\n';
      return args[0] === '--help' || args[0] === '-h' ? 0 : 1;
    }

    // Ensure service manager has fs/shell binding
    serviceManager.bind(ctx.fs, ctx.shell);

    const subcommand = args[0];
    const serviceName = args[1]?.replace(/\.service$/, '');

    switch (subcommand) {
      case 'start': {
        if (!serviceName) {
          ctx.stderr += 'systemctl: missing service name\n';
          return 1;
        }
        const ok = await serviceManager.start(serviceName);
        if (!ok) {
          ctx.stderr += `Failed to start ${serviceName}.service\n`;
          return 1;
        }
        return 0;
      }

      case 'stop': {
        if (!serviceName) {
          ctx.stderr += 'systemctl: missing service name\n';
          return 1;
        }
        const ok = serviceManager.stop(serviceName);
        if (!ok) {
          ctx.stderr += `Failed to stop ${serviceName}.service\n`;
          return 1;
        }
        return 0;
      }

      case 'restart': {
        if (!serviceName) {
          ctx.stderr += 'systemctl: missing service name\n';
          return 1;
        }
        const ok = await serviceManager.restart(serviceName);
        if (!ok) {
          ctx.stderr += `Failed to restart ${serviceName}.service\n`;
          return 1;
        }
        return 0;
      }

      case 'status': {
        if (serviceName) {
          const state = serviceManager.getStatus(serviceName);
          if (!state) {
            ctx.stderr += `Unit ${serviceName}.service could not be found.\n`;
            return 4; // systemctl returns 4 for unknown units
          }

          const uptime = state.status === 'active'
            ? formatUptime(Date.now() - state.startTime)
            : 'n/a';

          ctx.stdout += `● ${serviceName}.service - ${state.config.description || serviceName}\n`;
          ctx.stdout += `   Loaded: loaded (/etc/services/${serviceName}.conf)\n`;
          ctx.stdout += `   Active: ${formatStatus(state.status)} since ${new Date(state.startTime).toLocaleString()}\n`;
          ctx.stdout += `  Process: ${state.pid}\n`;
          ctx.stdout += `   Uptime: ${uptime}\n`;
          ctx.stdout += ` Restarts: ${state.restarts}\n`;

          // Show recent logs
          const logs = serviceManager.getLogs(serviceName, 5);
          if (logs.length > 0) {
            ctx.stdout += '\nRecent logs:\n';
            for (const entry of logs) {
              const ts = new Date(entry.timestamp).toLocaleTimeString();
              ctx.stdout += `  ${ts} ${entry.message}\n`;
            }
          }

          return state.status === 'active' ? 0 : 3;
        }

        // No service name: show all
        return listUnits(ctx);
      }

      case 'list-units': {
        return listUnits(ctx);
      }

      case 'enable':
      case 'disable': {
        if (!serviceName) {
          ctx.stderr += `systemctl: missing service name\n`;
          return 1;
        }
        // No-op for now — just acknowledge
        ctx.stdout += `${subcommand === 'enable' ? 'Created' : 'Removed'} symlink for ${serviceName}.service\n`;
        return 0;
      }

      default: {
        ctx.stderr += `systemctl: unknown command '${subcommand}'\n`;
        return 1;
      }
    }
  },
};

function listUnits(ctx: CommandContext): number {
  const units = serviceManager.listUnits();
  if (units.length === 0) {
    ctx.stdout += 'No services registered.\n';
    return 0;
  }

  ctx.stdout += 'UNIT                          LOAD   ACTIVE   SUB     DESCRIPTION\n';
  for (const state of units) {
    const name = (state.config.name + '.service').padEnd(30);
    const load = 'loaded'.padEnd(7);
    const active = state.status.padEnd(9);
    const sub = (state.status === 'active' ? 'running' : state.status === 'failed' ? 'failed' : 'dead').padEnd(8);
    const desc = state.config.description || state.config.name;
    ctx.stdout += `${name}${load}${active}${sub}${desc}\n`;
  }
  ctx.stdout += `\n${units.length} loaded units listed.\n`;
  return 0;
}

function formatStatus(status: string): string {
  switch (status) {
    case 'active': return 'active (running)';
    case 'inactive': return 'inactive (dead)';
    case 'failed': return 'failed';
    case 'activating': return 'activating';
    default: return status;
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}min`;
}
