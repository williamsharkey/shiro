/**
 * mdview - render markdown as formatted HTML in a window
 *
 *   echo '# Hello' | mdview
 *   mdview README.md
 *   mdview "# Inline markdown"
 */

import { Command } from './index';
import { createServerWindow } from '../server-window';

export const mdviewCmd: Command = {
  name: 'mdview',
  description: 'Render markdown as formatted HTML',
  async exec(ctx) {
    let md = '';

    if (ctx.stdin) {
      md = ctx.stdin;
    } else if (ctx.args.length > 0) {
      const arg = ctx.args.join(' ');
      // If it looks like a file path (no leading # and contains a dot), try reading it
      const firstArg = ctx.args[0];
      if (!arg.trimStart().startsWith('#') && firstArg.includes('.')) {
        const path = ctx.fs.resolvePath(firstArg, ctx.cwd);
        try {
          const content = await ctx.fs.readFile(path, 'utf8');
          md = typeof content === 'string' ? content : new TextDecoder().decode(content as Uint8Array);
        } catch (e: any) {
          ctx.stderr = `mdview: ${e.message}\n`;
          return 1;
        }
      } else {
        // Inline markdown text
        md = arg;
      }
    } else {
      ctx.stderr = 'Usage: mdview <file>, mdview "# markdown...", or echo "..." | mdview\n';
      return 1;
    }

    const html = buildMarkdownPage(md, ctx.args[0] || 'mdview');

    const win = createServerWindow({
      mode: 'iframe',
      title: ctx.args[0] || 'mdview',
      width: '48em',
      height: '32em',
    });
    win.updateIframe(html);
    return 0;
  },
};

function buildMarkdownPage(md: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0f0f1a; color: #d4d4d8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.6; }
  .md-body { max-width: 48em; margin: 0 auto; padding: 1.5em 2em; }

  /* Headings */
  .md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
    color: #e4e4e7; margin-top: 1.4em; margin-bottom: 0.5em; font-weight: 600; line-height: 1.25;
  }
  .md-body h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid #27273a; }
  .md-body h2 { font-size: 1.5em; padding-bottom: 0.25em; border-bottom: 1px solid #27273a; }
  .md-body h3 { font-size: 1.25em; }

  /* Paragraphs & text */
  .md-body p { margin: 0.8em 0; }
  .md-body a { color: #60a5fa; text-decoration: none; }
  .md-body a:hover { text-decoration: underline; }
  .md-body strong { color: #e4e4e7; }

  /* Lists */
  .md-body ul, .md-body ol { padding-left: 2em; margin: 0.5em 0; }
  .md-body li { margin: 0.25em 0; }
  .md-body li > p { margin: 0.4em 0; }

  /* Code */
  .md-body code {
    background: #1e1e2e; padding: 0.2em 0.4em; border-radius: 4px;
    font-family: "SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace; font-size: 0.9em;
  }
  .md-body pre {
    background: #1e1e2e; border: 1px solid #27273a; border-radius: 6px;
    padding: 1em; overflow-x: auto; margin: 1em 0;
  }
  .md-body pre code { background: none; padding: 0; font-size: 0.85em; }

  /* Blockquotes */
  .md-body blockquote {
    border-left: 4px solid #3b3b5c; padding: 0.5em 1em; margin: 0.8em 0;
    color: #a1a1aa; background: #16162a;
  }

  /* Tables */
  .md-body table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  .md-body th, .md-body td { border: 1px solid #27273a; padding: 0.5em 0.75em; text-align: left; }
  .md-body th { background: #1e1e2e; color: #e4e4e7; font-weight: 600; }
  .md-body tr:nth-child(even) { background: #16162a; }

  /* Horizontal rules */
  .md-body hr { border: none; border-top: 1px solid #27273a; margin: 1.5em 0; }

  /* Images */
  .md-body img { max-width: 100%; border-radius: 6px; }

  /* Task lists */
  .md-body input[type="checkbox"] { margin-right: 0.4em; }

  /* highlight.js overrides for dark theme */
  .hljs { background: #1e1e2e !important; color: #d4d4d8 !important; }
</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
</head>
<body>
<div class="md-body" id="output"></div>
<script type="text/template" id="md-src">${md.replace(/<\/script>/gi, '<\\/script>')}</script>
<script type="module">
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15/lib/marked.esm.js';
import hljs from 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/es/highlight.min.js';

marked.setOptions({
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
});

const src = document.getElementById('md-src').textContent;
document.getElementById('output').innerHTML = marked.parse(src);
</script>
</body></html>`;
}
