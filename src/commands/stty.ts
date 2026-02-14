import { Command } from './index';

export const sttyCmd: Command = {
  name: 'stty',
  description: 'Get/set terminal settings',
  async exec(ctx) {
    const size = ctx.terminal?.getSize() || { rows: 24, cols: 80 };

    if (ctx.args.length === 0 || ctx.args[0] === '-a') {
      ctx.stdout = `speed 38400 baud; rows ${size.rows}; columns ${size.cols}; line = 0;\n` +
        'intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D;\n' +
        '-parenb -parodd cs8 -hupcl -cstopb cread -clocal\n' +
        '-ignbrk -brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl ixon\n' +
        'opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0\n' +
        'isig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop\n';
      return 0;
    }

    if (ctx.args[0] === 'size') {
      ctx.stdout = `${size.rows} ${size.cols}\n`;
      return 0;
    }

    // Everything else (raw, -echo, sane, erase, etc.) is a no-op
    return 0;
  },
};
