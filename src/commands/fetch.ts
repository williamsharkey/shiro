import { Command, CommandContext } from './index';

export const fetchCmd: Command = {
  name: 'fetch',
  description: 'HTTP client (like curl)',
  async exec(ctx: CommandContext) {
    let method = 'GET';
    let url = '';
    let body = '';
    let headersOnly = false;
    let showHeaders = false;
    let outputFile = '';
    const headers: Record<string, string> = {};

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-X' && ctx.args[i + 1]) {
        method = ctx.args[++i].toUpperCase();
      } else if (arg === '-H' && ctx.args[i + 1]) {
        const header = ctx.args[++i];
        const colonIdx = header.indexOf(':');
        if (colonIdx > 0) {
          headers[header.slice(0, colonIdx).trim()] = header.slice(colonIdx + 1).trim();
        }
      } else if (arg === '-d' && ctx.args[i + 1]) {
        body = ctx.args[++i];
        if (method === 'GET') method = 'POST';
      } else if (arg === '-I' || arg === '--head') {
        headersOnly = true;
      } else if (arg === '-i' || arg === '--include') {
        showHeaders = true;
      } else if (arg === '-o' && ctx.args[i + 1]) {
        outputFile = ctx.args[++i];
      } else if (!arg.startsWith('-')) {
        url = arg;
      }
      i++;
    }

    if (!url) {
      ctx.stderr = 'fetch: missing URL\n';
      return 1;
    }

    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      const fetchOpts: RequestInit = { method, headers };
      if (body && method !== 'GET' && method !== 'HEAD') {
        fetchOpts.body = body;
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const response = await fetch(url, fetchOpts);

      let output = '';

      if (showHeaders || headersOnly) {
        output += `HTTP/${response.status} ${response.statusText}\n`;
        response.headers.forEach((value, key) => {
          output += `${key}: ${value}\n`;
        });
        output += '\n';
      }

      if (!headersOnly) {
        const text = await response.text();
        output += text;
        if (!text.endsWith('\n')) output += '\n';
      }

      if (outputFile) {
        const resolved = ctx.fs.resolvePath(outputFile, ctx.cwd);
        await ctx.fs.writeFile(resolved, output);
        ctx.stdout = '';
      } else {
        ctx.stdout = output;
      }

      return response.ok ? 0 : 1;
    } catch (e: any) {
      ctx.stderr = `fetch: ${e.message}\n`;
      return 1;
    }
  },
};

// Alias curl -> fetch
export const curlCmd: Command = {
  name: 'curl',
  description: 'HTTP client (alias for fetch)',
  exec: fetchCmd.exec,
};
