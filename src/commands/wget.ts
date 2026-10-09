import { Command } from './index';
import { fetchCmd } from './fetch';

/** Short options that take a value: the rest of the word, or the next word (`-O file`, `-Ofile`, `-qO-`). */
const SHORT_WITH_VALUE = new Set(['O', 'o', 'a', 'P', 't', 'T', 'U', 'e', 'i', 'w', 'B', 'l', 'Q', 'D', 'R', 'A', 'X', 'I']);
/** Long options that take a value (`--name=value` or `--name value`). */
const LONG_WITH_VALUE = new Set(['output-document', 'output-file', 'append-output', 'directory-prefix', 'tries', 'timeout',
  'user-agent', 'execute', 'input-file', 'wait', 'base', 'level', 'quota', 'header', 'post-data', 'method', 'body-data',
  'user', 'password', 'http-user', 'http-password', 'referer', 'domains', 'reject', 'accept', 'exclude-directories',
  'include-directories', 'dns-timeout', 'connect-timeout', 'read-timeout', 'limit-rate', 'load-cookies', 'save-cookies']);

export const wgetCmd: Command = {
  name: 'wget',
  description: 'Download files from the web',
  async exec(ctx) {
    let outputFile = '';
    let quiet = false;
    const curlArgs: string[] = [];
    let url = '';

    const option = (name: string, value: string) => {
      if (name === 'O' || name === 'output-document') outputFile = value;
      else if (name === 'header') curlArgs.push('-H', value);
      // others (tries, timeouts, the user agent, ...) don't apply to a fetch from the page
    };
    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '--') { url = ctx.args[i + 1] ?? url; break; }
      if (arg.startsWith('--')) {
        const eq = arg.indexOf('=');
        const name = arg.slice(2, eq < 0 ? undefined : eq);
        if (name === 'quiet') quiet = true;
        else if (LONG_WITH_VALUE.has(name)) option(name, eq < 0 ? (ctx.args[++i] ?? '') : arg.slice(eq + 1));
        continue; // --no-check-certificate, --timestamping, ...: nothing to do
      }
      if (arg.startsWith('-') && arg.length > 1) {
        // Bundled short options: -q, -qO-, -O-, -Ofile, -O file, -nv
        for (let j = 1; j < arg.length; j++) {
          const c = arg[j];
          if (c === 'q') quiet = true;
          else if (c === 'n') j++; // -nv, -nc, -nd, -nH: no- prefixes
          else if (SHORT_WITH_VALUE.has(c)) {
            option(c, j + 1 < arg.length ? arg.slice(j + 1) : (ctx.args[++i] ?? ''));
            break;
          }
        }
        continue;
      }
      url = arg;
    }

    if (!url) {
      ctx.stderr = 'wget: missing URL\n';
      return 1;
    }

    // -O - is standard output: the body goes there and nothing else does
    const toStdout = outputFile === '-';
    if (!outputFile) {
      try {
        const pathname = new URL(url.startsWith('http') ? url : 'https://' + url).pathname;
        outputFile = pathname.split('/').pop() || 'index.html';
      } catch {
        outputFile = 'index.html';
      }
    }

    // wget reports on stderr (stdout carries the document with -O -)
    if (!quiet) {
      ctx.stderr += `--  ${url}\n`;
      if (!toStdout) ctx.stderr += `Saving to: '${outputFile}'\n`;
    }

    // Delegate to fetch/curl
    const fetchCtx = { ...ctx, args: ['-s', ...(toStdout ? [] : ['-o', outputFile]), url, ...curlArgs], stdout: '', stderr: '' };
    const code = await fetchCmd.exec(fetchCtx);

    if (toStdout) ctx.stdout += fetchCtx.stdout;
    else if (code === 0 && !quiet) ctx.stderr += `'${outputFile}' saved\n`;
    if (fetchCtx.stderr) ctx.stderr += fetchCtx.stderr;
    return code;
  },
};
