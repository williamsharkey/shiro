import { Command, CommandContext } from './index';

/**
 * Hypercompact - Token-efficient DOM navigation for LLM agents
 * "One DSL, Many Contexts"
 */

class HCSession {
  doc: Document;
  source: string;
  current: Element;
  lastResults: Element[] = [];
  lastGrid: { text: string; el: Element; idx: number }[] | null = null;
  vars: Record<string, string> = {};

  constructor(doc: Document, source = 'page') {
    this.doc = doc;
    this.source = source;
    this.current = doc.body || doc.documentElement;
  }

  private _depth(el: Element | null): number {
    let d = 0;
    while (el && el !== this.doc.body && el !== this.doc.documentElement) {
      d++;
      el = el.parentElement;
    }
    return d;
  }

  s(): string {
    const name = this.source.split('/').pop();
    const count = this.lastResults.length;
    const depth = this._depth(this.current);
    const tag = this.current.tagName?.toLowerCase() || 'doc';
    return `p:${name} c:${count} d:${depth} @${tag}`;
  }

  t(limit?: number): string {
    let text = (this.current.textContent || '').replace(/\s+/g, ' ').trim();
    if (limit && text.length > limit) text = text.slice(0, limit) + '…';
    return text;
  }

  q(selector: string, limit = 10): string {
    try {
      const els = Array.from(this.doc.querySelectorAll(selector));
      this.lastResults = els;
      if (els.length === 0) return '∅';
      return els.slice(0, limit).map((el, i) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        return `[${i}]${text}`;
      }).join('\n');
    } catch (e: any) {
      return '✗ ' + e.message;
    }
  }

  q1(selector: string): string {
    try {
      const el = this.doc.querySelector(selector);
      if (!el) return '∅';
      this.current = el;
      this.lastResults = [el];
      return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch (e: any) {
      return '✗ ' + e.message;
    }
  }

  n(index: number): string {
    if (index >= this.lastResults.length) return '✗ out of range';
    this.current = this.lastResults[index];
    return `✓ [${index}] ${(this.current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100)}`;
  }

  up(levels = 1): string {
    for (let i = 0; i < levels; i++) {
      if (this.current.parentElement) this.current = this.current.parentElement;
    }
    return `✓ @${this.current.tagName?.toLowerCase()}`;
  }

  ch(): string {
    const children = Array.from(this.current.children);
    if (children.length === 0) return '∅ no children';
    return children.slice(0, 15).map((c, i) => {
      const tag = c.tagName.toLowerCase();
      const cls = c.className ? '.' + String(c.className).split(' ')[0] : '';
      return `[${i}]<${tag}${cls}>${(c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)}`;
    }).join('\n');
  }

  g(pattern: string, limit = 10): string {
    const lines = (this.current.textContent || '').split('\n');
    const regex = new RegExp(pattern, 'gi');
    const matches: string[] = [];
    lines.forEach((line, i) => {
      if (regex.test(line)) {
        const clean = line.replace(/\s+/g, ' ').trim();
        if (clean) matches.push(`L${i + 1}: ${clean.slice(0, 60)}`);
      }
    });
    return matches.length === 0 ? '∅ no matches' : matches.slice(0, limit).join('\n');
  }

  look(): string {
    const interactive = this.current.querySelectorAll('a, button, input, select, textarea, [onclick], [href], .btn, [role="button"]');
    const items: { text: string; el: Element; idx: number }[] = [];
    interactive.forEach((el, idx) => {
      const text = (
        el.textContent ||
        (el as HTMLInputElement).value ||
        (el as HTMLInputElement).placeholder ||
        el.getAttribute('title') ||
        el.getAttribute('aria-label') ||
        ''
      ).replace(/\s+/g, ' ').trim().slice(0, 20);
      if (text || el.tagName.toLowerCase() === 'input') {
        items.push({ text: text || `[${(el as HTMLInputElement).type || 'input'}]`, el, idx });
      }
    });
    this.lastGrid = items;
    if (items.length === 0) return '∅ no interactive elements';
    let out = `${items.length} elements\n`;
    items.slice(0, 20).forEach((item, i) => {
      const tag = item.el.tagName.toLowerCase();
      const href = item.el.getAttribute('href');
      out += `@${i} <${tag}> "${item.text}"${href ? ` →${href.slice(0, 25)}` : ''}\n`;
    });
    return out.trim();
  }

  click(index: number): string {
    if (!this.lastGrid || index >= this.lastGrid.length) return '✗ call look first or index out of range';
    const item = this.lastGrid[index];
    try { (item.el as HTMLElement).click(); } catch { /* ignore */ }
    return `✓ clicked "${item.text}"`;
  }

  a(): string {
    if (!this.current.attributes) return '∅';
    const attrs: string[] = [];
    for (const attr of Array.from(this.current.attributes)) {
      attrs.push(`${attr.name}=${attr.value.slice(0, 30)}`);
    }
    return attrs.length === 0 ? '∅ no attrs' : attrs.join(' ');
  }

  h(limit?: number): string {
    let html = this.current.outerHTML;
    if (limit && html.length > limit) html = html.slice(0, limit) + '…[truncated]';
    return html;
  }

  store(name: string): string {
    this.vars[name] = this.current.textContent || '';
    return `✓ $${name} (${this.vars[name].length} chars)`;
  }

  recall(expr: string): string {
    const match = expr.match(/^\$(\w+)(\.(\w+))?$/);
    if (!match) return '✗ invalid var syntax';
    const name = match[1], prop = match[3];
    if (!this.vars[name]) return `✗ $${name} not set`;
    if (prop === 'length') return String(this.vars[name].length);
    if (prop) return '✗ unknown property';
    return this.vars[name].slice(0, 500);
  }

  exec(cmd: string): string {
    cmd = cmd.trim();
    let m: RegExpMatchArray | null;

    // Batch
    if (cmd.includes(';') && !cmd.startsWith(';')) {
      return cmd.split(';').map(c => c.trim()).filter(Boolean).map(c => this.exec(c)).join('\n---\n');
    }

    if (cmd === 's') return this.s();
    if (cmd === 't') return this.t();
    if ((m = cmd.match(/^t(\d+)$/))) return this.t(parseInt(m[1]));
    if (cmd.startsWith('q1 ')) return this.q1(cmd.slice(3).trim());
    if (cmd.startsWith('q ')) return this.q(cmd.slice(2).trim());
    if ((m = cmd.match(/^n(\d+)$/))) return this.n(parseInt(m[1]));
    if (cmd === 'up') return this.up();
    if ((m = cmd.match(/^up(\d+)$/))) return this.up(parseInt(m[1]));
    if (cmd === 'ch') return this.ch();
    if (cmd.startsWith('g ')) return this.g(cmd.slice(2).trim());
    if (cmd === 'look') return this.look();
    if ((m = cmd.match(/^@(\d+)$/))) return this.click(parseInt(m[1]));
    if (cmd === 'a') return this.a();
    if (cmd === 'h') return this.h();
    if ((m = cmd.match(/^h(\d+)$/))) return this.h(parseInt(m[1]));
    if ((m = cmd.match(/^>\$(\w+)$/))) return this.store(m[1]);
    if ((m = cmd.match(/^(\$\w+(\.\w+)?)$/))) return this.recall(m[1]);

    return `✗ unknown: ${cmd}`;
  }
}

// Proxy session that sends commands to the host page via postMessage bridge
class HCOuterSession {
  source = 'outer';
  private _listener: ((e: MessageEvent) => void) | null = null;
  private _pending = new Map<string, { resolve: (v: string) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor() {
    this._listener = (e: MessageEvent) => {
      if (e.data && e.data.type === 'shiro-hc-result') {
        const entry = this._pending.get(e.data.id);
        if (entry) {
          clearTimeout(entry.timer);
          this._pending.delete(e.data.id);
          entry.resolve(e.data.result);
        }
      }
    };
    window.addEventListener('message', this._listener);
  }

  exec(cmd: string): Promise<string> {
    const id = Math.random().toString(36).slice(2, 10);
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve('✗ timeout: no response from host page (is Shiro injected?)');
      }, 5000);
      this._pending.set(id, { resolve, timer });
      window.parent.postMessage({ type: 'shiro-hc', id, cmd }, '*');
    });
  }

  close() {
    if (this._listener) {
      window.removeEventListener('message', this._listener);
      this._listener = null;
    }
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
    }
    this._pending.clear();
  }
}

// Global HC state
declare global {
  interface Window {
    __hc: { session: HCSession | HCOuterSession | null; HCSession: typeof HCSession };
    hc: (cmd: string) => string | Promise<string>;
  }
}

if (typeof window !== 'undefined' && !window.__hc) {
  window.__hc = { session: null, HCSession };
  window.hc = (cmd: string) => window.__hc.session ? window.__hc.session.exec(cmd) : '✗ no session';
}

export const hcCmd: Command = {
  name: 'hc',
  description: 'Hypercompact - token-efficient DOM navigation',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;
    const sub = args[0];

    if (!sub) {
      ctx.stdout = `Hypercompact - Token-efficient DOM navigation

Usage:
  hc open <file>     Load HTML file from filesystem
  hc live            Attach to live page DOM
  hc outer           Bridge to host page DOM (when injected)
  hc close           Close current session
  hc <cmd>           Run HC command

Commands:
  s              State: "p:file c:N d:N @tag"
  t, t100        Text content (optional limit)
  q <sel>        Query all matching elements
  q1 <sel>       Query one, set as current
  n<N>           Select Nth from results
  up, up<N>      Go to parent element
  ch             Show children
  g <pattern>    Grep for text
  look           List interactive elements
  @<N>           Click Nth element
  a              Show attributes
  h, h<N>        Show HTML
  >$name         Store to variable
  $name          Recall variable

Example:
  hc open page.html
  hc t100
  hc q .price
  hc n0
  hc a
`;
      return 0;
    }

    // Open file from filesystem
    if (sub === 'open') {
      const file = args[1];
      if (!file) {
        ctx.stderr = 'hc open: missing file\n';
        return 1;
      }
      try {
        const path = ctx.fs.resolvePath(file, ctx.cwd);
        const html = await ctx.fs.readFile(path, 'utf8') as string;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        window.__hc.session = new HCSession(doc, file);
        ctx.stdout = `✓ opened ${file} (${html.length} chars)\n`;
        return 0;
      } catch (e: any) {
        ctx.stderr = `hc open: ${e.message}\n`;
        return 1;
      }
    }

    // Attach to live DOM
    if (sub === 'live') {
      window.__hc.session = new HCSession(document, 'live');
      ctx.stdout = '✓ attached to live DOM\n';
      return 0;
    }

    // Bridge to host page DOM via postMessage
    if (sub === 'outer') {
      if (window.parent === window) {
        ctx.stderr = 'hc outer: not running inside an iframe. Use "seed" first.\n';
        return 1;
      }
      const outer = new HCOuterSession();
      window.__hc.session = outer;
      // Verify the bridge is alive with a quick 's' command
      const probe = await outer.exec('s');
      if (probe.startsWith('✗ timeout')) {
        outer.close();
        window.__hc.session = null;
        ctx.stderr = 'hc outer: ' + probe + '\n';
        return 1;
      }
      ctx.stdout = '✓ connected to host page DOM\n' + probe + '\n';
      return 0;
    }

    // Close session
    if (sub === 'close') {
      if (window.__hc.session && window.__hc.session instanceof HCOuterSession) {
        (window.__hc.session as HCOuterSession).close();
      }
      window.__hc.session = null;
      ctx.stdout = '✓ session closed\n';
      return 0;
    }

    // Run HC command
    if (!window.__hc.session) {
      ctx.stderr = 'hc: no session. Use "hc open <file>", "hc live", or "hc outer" first.\n';
      return 1;
    }

    const cmd = args.join(' ');
    const result = await window.__hc.session.exec(cmd);
    ctx.stdout = result + '\n';
    return 0;
  },
};
