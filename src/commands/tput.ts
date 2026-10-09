import { Command } from './index';
import { ptyOf } from './tty-of';

export const tputCmd: Command = {
  name: 'tput',
  description: 'Terminal capability lookup',
  async exec(ctx) {
    const args = [...ctx.args];
    // -T type / -Ttype: only xterm-like terminals exist here
    while (args[0]?.startsWith('-T')) { if (args.shift() === '-T') args.shift(); }
    const cap = args[0];
    if (!cap) {
      ctx.stderr = 'tput: missing operand\n';
      return 1;
    }

    // Size comes from the controlling tty (TIOCGWINSZ); LINES/COLUMNS override it, as in ncurses
    const ws = ptyOf(ctx, [1, 2, 0])?.winsize ?? ctx.terminal?.getSize() ?? { cols: 80, rows: 24 };
    const envInt = (name: string) => (/^\d+$/.test(ctx.env[name] ?? '') ? parseInt(ctx.env[name], 10) : 0);
    const size = { cols: envInt('COLUMNS') || ws.cols, rows: envInt('LINES') || ws.rows };
    const num = (i: number) => parseInt(args[i] || '0', 10) || 0;

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
      case 'longname':
        ctx.stdout = 'xterm with 256 colors';
        return 0;
      case 'home':
        ctx.stdout = '\x1b[H';
        return 0;
      case 'ed':
        ctx.stdout = '\x1b[J';
        return 0;
      case 'dim':
        ctx.stdout = '\x1b[2m';
        return 0;
      case 'sitm':
        ctx.stdout = '\x1b[3m';
        return 0;
      case 'ritm':
        ctx.stdout = '\x1b[23m';
        return 0;
      case 'smso':
        ctx.stdout = '\x1b[7m';
        return 0;
      case 'rmso':
        ctx.stdout = '\x1b[27m';
        return 0;
      case 'blink':
        ctx.stdout = '\x1b[5m';
        return 0;
      case 'bel':
        ctx.stdout = '\x07';
        return 0;
      case 'cuu1':
        ctx.stdout = '\x1b[A';
        return 0;
      case 'cud1':
        ctx.stdout = '\n';
        return 0;
      case 'cuu': case 'cud': case 'cuf': case 'cub': {
        const letter = { cuu: 'A', cud: 'B', cuf: 'C', cub: 'D' }[cap];
        ctx.stdout = `\x1b[${num(1)}${letter}`;
        return 0;
      }
      case 'hpa':
        ctx.stdout = `\x1b[${num(1) + 1}G`;
        return 0;
      case 'vpa':
        ctx.stdout = `\x1b[${num(1) + 1}d`;
        return 0;
      case 'il': case 'dl': case 'ich': case 'dch': case 'ech': {
        const code = { il: 'L', dl: 'M', ich: '@', dch: 'P', ech: 'X' }[cap];
        ctx.stdout = `\x1b[${num(1)}${code}`;
        return 0;
      }
      case 'el1':
        ctx.stdout = '\x1b[1K';
        return 0;
      case 'init':
      case 'reset': {
        // Like tput reset: sane tty modes, then the terminal's reset string
        const tty = ctx.terminal?.tty?.pty;
        if (tty) {
          const { defaultTermios } = await import('../kernel/pty');
          tty.setTermios(defaultTermios());
        }
        ctx.stdout = cap === 'reset' ? '\x1bc' : '\x1b[!p\x1b[?3;4l\x1b[4l\x1b>';
        return 0;
      }
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
