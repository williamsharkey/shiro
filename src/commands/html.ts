/**
 * html - render HTML in a window
 * img  - display an image in a window
 *
 *   echo '<h1>Hello</h1>' | html
 *   html page.html
 *   img screenshot.png
 */

import { Command } from './index';
import { createServerWindow } from '../server-window';

export const htmlCmd: Command = {
  name: 'html',
  description: 'Render HTML in a window',
  async exec(ctx) {
    let html = '';

    if (ctx.stdin) {
      // Piped input
      html = ctx.stdin;
    } else if (ctx.args.length > 0) {
      const arg = ctx.args.join(' ');
      // Detect inline HTML (starts with < or contains common tags)
      if (arg.trimStart().startsWith('<')) {
        html = arg;
      } else {
        // File argument
        const path = ctx.fs.resolvePath(ctx.args[0], ctx.cwd);
        try {
          const content = await ctx.fs.readFile(path, 'utf8');
          html = typeof content === 'string' ? content : new TextDecoder().decode(content as Uint8Array);
        } catch (e: any) {
          ctx.stderr = `html: ${e.message}\n`;
          return 1;
        }
      }
    } else {
      ctx.stderr = 'Usage: html <file>, html "<html>...", or echo "..." | html\n';
      return 1;
    }

    const win = createServerWindow({
      mode: 'iframe',
      title: ctx.args[0] || 'html',
      width: '32em',
      height: '22em',
    });
    win.updateIframe(html);
    return 0;
  },
};

export const imgCmd: Command = {
  name: 'img',
  description: 'Display an image in a window',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'Usage: img <file>\n';
      return 1;
    }

    const path = ctx.fs.resolvePath(ctx.args[0], ctx.cwd);
    let data: Uint8Array;
    try {
      const content = await ctx.fs.readFile(path);
      data = content instanceof Uint8Array ? content : new TextEncoder().encode(content as string);
    } catch (e: any) {
      ctx.stderr = `img: ${e.message}\n`;
      return 1;
    }

    // Detect MIME type from extension
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
      bmp: 'image/bmp', ico: 'image/x-icon',
    };
    const mime = mimeMap[ext] || 'image/png';

    // Base64 encode
    let b64 = '';
    const chunk = 8192;
    for (let i = 0; i < data.length; i += chunk) {
      b64 += String.fromCharCode(...data.subarray(i, i + chunk));
    }
    b64 = btoa(b64);

    const html = `<!DOCTYPE html>
<html><head><style>
  body { margin:0; display:flex; justify-content:center; align-items:center; min-height:100vh; background:#1a1a2e; }
  img { max-width:100%; max-height:100vh; object-fit:contain; }
</style></head><body>
  <img src="data:${mime};base64,${b64}" />
</body></html>`;

    const name = path.split('/').pop() || 'image';
    const win = createServerWindow({
      mode: 'iframe',
      title: name,
      width: '32em',
      height: '22em',
    });
    win.updateIframe(html);
    return 0;
  },
};
