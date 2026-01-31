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
    let silent = false;
    let showErrors = false;
    let failOnError = false;
    let followRedirects = true; // fetch follows by default, but we track for -L
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
      } else if (arg === '-s' || arg === '--silent') {
        silent = true;
      } else if (arg === '-S' || arg === '--show-error') {
        showErrors = true;
      } else if (arg === '-f' || arg === '--fail') {
        failOnError = true;
      } else if (arg === '-L' || arg === '--location') {
        followRedirects = true;
      } else if (arg.startsWith('-') && !arg.startsWith('--')) {
        // Handle combined flags like -fsSL
        for (const flag of arg.slice(1)) {
          if (flag === 'f') failOnError = true;
          else if (flag === 's') silent = true;
          else if (flag === 'S') showErrors = true;
          else if (flag === 'L') followRedirects = true;
          else if (flag === 'i') showHeaders = true;
          else if (flag === 'I') headersOnly = true;
        }
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
      const fetchOpts: RequestInit = {
        method,
        headers,
        redirect: followRedirects ? 'follow' : 'manual',
      };
      if (body && method !== 'GET' && method !== 'HEAD') {
        fetchOpts.body = body;
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const response = await fetch(url, fetchOpts);

      // Handle -f (fail silently on HTTP errors)
      if (failOnError && !response.ok) {
        if (showErrors) {
          ctx.stderr = `curl: (22) The requested URL returned error: ${response.status}\n`;
        }
        return 22; // curl exit code for HTTP error
      }

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
      if (!silent || showErrors) {
        ctx.stderr = `curl: ${e.message}\n`;
      }
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
