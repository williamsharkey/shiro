/**
 * page — Interact with served app iframes
 *
 * Usage:
 *   page click #selector         Click an element
 *   page input #selector "val"   Set an input's value (fires input+change events)
 *   page text [#selector]        Get text content (defaults to body)
 *   page html [#selector]        Get innerHTML
 *   page attr #selector name     Get an attribute value
 *   page eval "code"             Eval JS in the iframe context
 *   page title                   Get document.title
 *   page wait #selector [ms]     Wait for element to appear (default 3000ms)
 *
 * Port targeting (when multiple servers are open):
 *   page :8080 click #btn        Target a specific port
 *
 * If only one server window is open, it's used automatically.
 * Also checks the become-mode iframe.
 */

import { Command } from './index';

/** Find the target iframe, optionally by port */
function findIframe(port?: number): HTMLIFrameElement | null {
  // Check become-mode iframe first
  const becomeContainer = document.getElementById('become-container');
  if (becomeContainer) {
    const becomeIframe = becomeContainer.querySelector('iframe');
    if (becomeIframe) {
      if (!port) return becomeIframe;
      // If port specified, check if it matches
      const vp = becomeIframe.getAttribute('data-virtual-port');
      if (vp && parseInt(vp, 10) === port) return becomeIframe;
    }
  }

  // Find all server window iframes
  const all = Array.from(document.querySelectorAll('[data-virtual-port]')) as HTMLIFrameElement[];

  if (port) {
    return all.find(el => parseInt(el.getAttribute('data-virtual-port')!, 10) === port) || null;
  }

  if (all.length === 1) return all[0];
  if (all.length === 0) return null;

  // Multiple — can't auto-detect
  return null;
}

/** List open ports for error messages */
function listPorts(): number[] {
  const ports: number[] = [];
  document.querySelectorAll('[data-virtual-port]').forEach(el => {
    ports.push(parseInt(el.getAttribute('data-virtual-port')!, 10));
  });
  return ports;
}

export const pageCmd: Command = {
  name: 'page',
  description: 'Interact with a served app (click, input, text, eval, etc.)',
  async exec(ctx) {
    const raw = ctx.args.slice();

    // Parse optional :port prefix
    let port: number | undefined;
    if (raw.length && /^:\d+$/.test(raw[0])) {
      port = parseInt(raw[0].slice(1), 10);
      raw.shift();
    }

    const action = raw[0]?.toLowerCase();
    if (!action) {
      ctx.stderr += 'Usage: page [:port] <action> [selector] [value]\n';
      ctx.stderr += 'Actions: click, input, text, html, attr, eval, title, wait\n';
      return 1;
    }

    // title doesn't need a selector
    if (action === 'title') {
      const iframe = findIframe(port);
      if (!iframe) return noIframe(ctx, port);
      const doc = iframe.contentDocument;
      if (!doc) { ctx.stderr += 'iframe not loaded\n'; return 1; }
      ctx.stdout += (doc.title || '') + '\n';
      return 0;
    }

    // eval takes the rest as code
    if (action === 'eval') {
      const code = raw.slice(1).join(' ');
      if (!code) { ctx.stderr += 'Usage: page eval "code"\n'; return 1; }
      const iframe = findIframe(port);
      if (!iframe) return noIframe(ctx, port);
      const win = iframe.contentWindow;
      if (!win) { ctx.stderr += 'iframe not loaded\n'; return 1; }
      try {
        const result = (win as any).eval(code);
        if (result !== undefined) ctx.stdout += String(result) + '\n';
        return 0;
      } catch (e: any) {
        ctx.stderr += (e.message || String(e)) + '\n';
        return 1;
      }
    }

    const selector = raw[1];

    // wait for element to appear
    if (action === 'wait') {
      if (!selector) { ctx.stderr += 'Usage: page wait <selector> [timeout_ms]\n'; return 1; }
      const timeout = parseInt(raw[2], 10) || 3000;
      const iframe = findIframe(port);
      if (!iframe) return noIframe(ctx, port);
      const doc = iframe.contentDocument;
      if (!doc) { ctx.stderr += 'iframe not loaded\n'; return 1; }

      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (doc.querySelector(selector)) {
          ctx.stdout += 'found\n';
          return 0;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      ctx.stderr += `timeout: ${selector} not found after ${timeout}ms\n`;
      return 1;
    }

    const validActions = ['click', 'input', 'text', 'html', 'attr'];
    if (!validActions.includes(action)) {
      ctx.stderr += `Unknown action: ${action}\n`;
      ctx.stderr += 'Actions: click, input, text, html, attr, eval, title, wait\n';
      return 1;
    }

    // All remaining actions need a selector (except text/html which default to body)
    if (!selector && action !== 'text' && action !== 'html') {
      ctx.stderr += `Usage: page ${action} <selector>\n`;
      return 1;
    }

    const iframe = findIframe(port);
    if (!iframe) return noIframe(ctx, port);
    const doc = iframe.contentDocument;
    if (!doc) { ctx.stderr += 'iframe not loaded\n'; return 1; }

    const sel = selector || 'body';
    const el = doc.querySelector(sel);
    if (!el) {
      ctx.stderr += `element not found: ${sel}\n`;
      return 1;
    }

    switch (action) {
      case 'click':
        (el as HTMLElement).click();
        return 0;

      case 'input': {
        const value = raw.slice(2).join(' ');
        const tag = el.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          (el as any).value = value;
        } else {
          (el as HTMLElement).textContent = value;
        }
        // Fire input + change events so frameworks pick it up
        try {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch {}
        return 0;
      }

      case 'text':
        ctx.stdout += ((el as HTMLElement).textContent || '') + '\n';
        return 0;

      case 'html':
        ctx.stdout += (el as HTMLElement).innerHTML + '\n';
        return 0;

      case 'attr': {
        const attrName = raw[2];
        if (!attrName) { ctx.stderr += 'Usage: page attr <selector> <attribute>\n'; return 1; }
        const val = el.getAttribute(attrName);
        if (val === null) { ctx.stderr += `no attribute: ${attrName}\n`; return 1; }
        ctx.stdout += val + '\n';
        return 0;
      }

      default:
        return 1; // unreachable — validated above
    }
  },
};

function noIframe(ctx: { stderr: string }, port?: number): number {
  if (port) {
    ctx.stderr += `no open window for port ${port}\n`;
  } else {
    const ports = listPorts();
    if (ports.length === 0) {
      ctx.stderr += 'no server windows open — use "serve <dir> <port>" then "serve open <port>" first\n';
    } else {
      ctx.stderr += `multiple server windows open — specify port: page :${ports[0]} <action>\n`;
      ctx.stderr += `open ports: ${ports.join(', ')}\n`;
    }
  }
  return 1;
}
