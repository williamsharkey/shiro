import type { Command } from './index';
import { parseArgs } from './flags';

export const notifyCmd: Command = {
  name: 'notify',
  description: 'Send a browser notification',
  async exec(ctx) {
    if (typeof Notification === 'undefined') {
      ctx.stderr += 'notify: Notification API not available\n';
      return 1;
    }

    const { values, positional } = parseArgs(ctx.args, ['t', 'title']);

    const title = values.t || values.title || 'Shiro';

    // Body from args or stdin
    let body = positional.join(' ');
    if (!body && ctx.stdin) {
      body = ctx.stdin.trim();
    }
    if (!body) {
      ctx.stderr += 'Usage: notify [-t title] "message" or echo "msg" | notify\n';
      return 1;
    }

    // Request permission if needed
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        ctx.stderr += 'notify: permission denied\n';
        return 1;
      }
    } else if (Notification.permission === 'denied') {
      ctx.stderr += 'notify: notifications blocked by browser\n';
      return 1;
    }

    new Notification(title, { body });
    return 0;
  },
};
