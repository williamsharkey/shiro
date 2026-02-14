import { Command } from './index';
import { fetchCmd } from './fetch';

export const wgetCmd: Command = {
  name: 'wget',
  description: 'Download files from the web',
  async exec(ctx) {
    let outputFile = '';
    let quiet = false;
    const curlArgs: string[] = [];
    let url = '';

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if ((arg === '-O' || arg === '--output-document') && ctx.args[i + 1]) {
        outputFile = ctx.args[++i];
      } else if (arg === '-q' || arg === '--quiet') {
        quiet = true;
      } else if (arg === '--no-check-certificate') {
        // ignore — browser handles TLS
      } else if (arg === '-N' || arg === '--timestamping') {
        // ignore
      } else if ((arg === '--header') && ctx.args[i + 1]) {
        curlArgs.push('-H', ctx.args[++i]);
      } else if (!arg.startsWith('-')) {
        url = arg;
      }
      i++;
    }

    if (!url) {
      ctx.stderr = 'wget: missing URL\n';
      return 1;
    }

    // Extract filename from URL if no -O given
    if (!outputFile) {
      try {
        const pathname = new URL(url.startsWith('http') ? url : 'https://' + url).pathname;
        outputFile = pathname.split('/').pop() || 'index.html';
      } catch {
        outputFile = 'index.html';
      }
    }

    if (!quiet) {
      ctx.stdout += `--  ${url}\n`;
      ctx.stdout += `Saving to: '${outputFile}'\n`;
    }

    // Delegate to fetch/curl
    const fetchCtx = { ...ctx, args: ['-s', '-o', outputFile, url, ...curlArgs], stdout: '', stderr: '' };
    const code = await fetchCmd.exec(fetchCtx);

    if (code === 0 && !quiet) {
      ctx.stdout += `'${outputFile}' saved\n`;
    }
    if (fetchCtx.stderr) ctx.stderr += fetchCtx.stderr;
    return code;
  },
};
