import { Command } from './index';

export const tputCmd: Command = {
  name: 'tput',
  description: 'Terminal capability lookup',
  async exec(ctx) {
    const cap = ctx.args[0];
    if (!cap) {
      ctx.stderr = 'tput: missing operand\n';
      return 1;
    }

    const size = ctx.terminal?.getSize() || { cols: 80, rows: 24 };

    const ansiColors: Record<number, string> = {
      0: '\x1b[30m', 1: '\x1b[31m', 2: '\x1b[32m', 3: '\x1b[33m',
      4: '\x1b[34m', 5: '\x1b[35m', 6: '\x1b[36m', 7: '\x1b[37m',
      8: '\x1b[90m', 9: '\x1b[91m', 10: '\x1b[92m', 11: '\x1b[93m',
      12: '\x1b[94m', 13: '\x1b[95m', 14: '\x1b[96m', 15: '\x1b[97m',
    };
    const bgColors: Record<number, string> = {
      0: '\x1b[40m', 1: '\x1b[41m', 2: '\x1b[42m', 3: '\x1b[43m',
      4: '\x1b[44m', 5: '\x1b[45m', 6: '\x1b[46m', 7: '\x1b[47m',
    };

    switch (cap) {
      case 'cols':
        ctx.stdout = size.cols + '\n';
        return 0;
      case 'lines':
        ctx.stdout = size.rows + '\n';
        return 0;
      case 'colors':
        ctx.stdout = '256\n';
        return 0;
      case 'setaf': {
        const n = parseInt(ctx.args[1] || '0');
        if (n < 16) ctx.stdout = ansiColors[n] || '';
        else if (n < 256) ctx.stdout = `\x1b[38;5;${n}m`;
        return 0;
      }
      case 'setab': {
        const n = parseInt(ctx.args[1] || '0');
        if (n < 8) ctx.stdout = bgColors[n] || '';
        else if (n < 256) ctx.stdout = `\x1b[48;5;${n}m`;
        return 0;
      }
      case 'sgr0':
        ctx.stdout = '\x1b[0m';
        return 0;
      case 'bold':
        ctx.stdout = '\x1b[1m';
        return 0;
      case 'smul':
        ctx.stdout = '\x1b[4m';
        return 0;
      case 'rmul':
        ctx.stdout = '\x1b[24m';
        return 0;
      case 'rev':
        ctx.stdout = '\x1b[7m';
        return 0;
      case 'clear':
        ctx.stdout = '\x1b[2J\x1b[H';
        return 0;
      case 'cup': {
        const row = ctx.args[1] || '0';
        const col = ctx.args[2] || '0';
        ctx.stdout = `\x1b[${parseInt(row) + 1};${parseInt(col) + 1}H`;
        return 0;
      }
      case 'civis':
        ctx.stdout = '\x1b[?25l';
        return 0;
      case 'cnorm':
        ctx.stdout = '\x1b[?25h';
        return 0;
      case 'sc':
        ctx.stdout = '\x1b[s';
        return 0;
      case 'rc':
        ctx.stdout = '\x1b[u';
        return 0;
      case 'el':
        ctx.stdout = '\x1b[K';
        return 0;
      case 'smcup':
        ctx.stdout = '\x1b[?1049h';
        return 0;
      case 'rmcup':
        ctx.stdout = '\x1b[?1049l';
        return 0;
      default:
        ctx.stderr = `tput: unknown terminfo capability '${cap}'\n`;
        return 1;
    }
  },
};
