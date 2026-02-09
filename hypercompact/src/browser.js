/**
 * Hypercompact Browser Bundle
 *
 * This file is designed to be included in browser environments like Foam/Shiro.
 * It uses the native DOMParser and exposes a global API.
 *
 * Usage in browser:
 *   <script src="hypercompact/src/browser.js"></script>
 *   <script>
 *     // Parse HTML string into session
 *     const session = HC.open('<html>...</html>', 'page.html');
 *     console.log(session.exec('q .price'));
 *
 *     // Or use live DOM
 *     const liveSession = HC.live();
 *     console.log(liveSession.exec('look'));
 *
 *     // Or use an iframe
 *     const iframeSession = HC.iframe('#my-iframe');
 *   </script>
 *
 * For Foam/Shiro shell integration, see the shell command implementation.
 */

(function(global) {
  'use strict';

  // ==================== PARSER ====================

  function parseCommand(cmd) {
    cmd = cmd.trim();

    if (!cmd) return { type: 'unknown', raw: cmd };

    if (cmd.includes(';') && !cmd.startsWith(';')) {
      const commands = cmd.split(';').map(c => c.trim()).filter(Boolean);
      return { type: 'batch', commands, raw: cmd };
    }

    if (cmd.includes('|')) {
      const match = cmd.match(/\|\s*(\w+)\s*(.*)/);
      if (match) {
        return { type: 'pipe', operation: match[1], arg: match[2]?.trim() || '', raw: cmd };
      }
    }

    if (cmd === 's') return { type: 's', raw: cmd };
    if (cmd === 't') return { type: 't', limit: null, raw: cmd };

    let m;
    if ((m = cmd.match(/^t(\d+)$/))) return { type: 't', limit: parseInt(m[1]), raw: cmd };
    if (cmd.startsWith('q1 ')) return { type: 'q1', selector: cmd.slice(3).trim(), raw: cmd };
    if (cmd.startsWith('q ')) return { type: 'q', selector: cmd.slice(2).trim(), limit: 10, raw: cmd };
    if ((m = cmd.match(/^n(\d+)$/))) return { type: 'n', index: parseInt(m[1]), raw: cmd };
    if (cmd === 'up') return { type: 'up', levels: 1, raw: cmd };
    if ((m = cmd.match(/^up(\d+)$/))) return { type: 'up', levels: parseInt(m[1]), raw: cmd };
    if (cmd === 'ch') return { type: 'ch', raw: cmd };
    if (cmd.startsWith('g ')) return { type: 'g', pattern: cmd.slice(2).trim(), limit: 10, raw: cmd };
    if (cmd === 'look') return { type: 'look', raw: cmd };
    if ((m = cmd.match(/^@(\d+)$/))) return { type: 'click', index: parseInt(m[1]), raw: cmd };
    if (cmd === 'a') return { type: 'a', raw: cmd };
    if (cmd === 'h') return { type: 'h', limit: null, raw: cmd };
    if ((m = cmd.match(/^h(\d+)$/))) return { type: 'h', limit: parseInt(m[1]), raw: cmd };
    if ((m = cmd.match(/^>\$(\w+)$/))) return { type: 'store', name: m[1], raw: cmd };
    if ((m = cmd.match(/^(\$\w+(\.\w+)?)$/))) return { type: 'recall', expr: m[1], raw: cmd };

    return { type: 'unknown', raw: cmd };
  }

  // ==================== SESSION ====================

  class HCSession {
    constructor(doc, source = 'page') {
      if (!doc || typeof doc.querySelectorAll !== 'function') {
        throw new Error('HCSession requires a Document object');
      }
      this.doc = doc;
      this.source = source;
      this.current = doc.body || doc.documentElement;
      this.lastResults = [];
      this.lastGrid = null;
      this.vars = {};
    }

    s() {
      const name = this.source.split('/').pop();
      const count = this.lastResults.length;
      const depth = this._depth(this.current);
      const tag = this.current.tagName?.toLowerCase() || 'doc';
      return `p:${name} c:${count} d:${depth} @${tag}`;
    }

    t(limit) {
      let text = this.current.textContent.replace(/\s+/g, ' ').trim();
      if (limit && text.length > limit) text = text.slice(0, limit) + '…';
      return text;
    }

    q(selector, limit = 10) {
      try {
        const els = Array.from(this.doc.querySelectorAll(selector));
        this.lastResults = els;
        if (els.length === 0) return '∅';
        return els.slice(0, limit).map((el, i) => {
          const text = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
          return `[${i}]${text}`;
        }).join('\n');
      } catch (e) {
        return '✗ ' + e.message;
      }
    }

    q1(selector) {
      try {
        const el = this.doc.querySelector(selector);
        if (!el) return '∅';
        this.current = el;
        this.lastResults = [el];
        return el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
      } catch (e) {
        return '✗ ' + e.message;
      }
    }

    n(index) {
      if (index >= this.lastResults.length) return '✗ out of range';
      this.current = this.lastResults[index];
      const text = this.current.textContent.replace(/\s+/g, ' ').trim().slice(0, 100);
      return `✓ [${index}] ${text}`;
    }

    up(levels = 1) {
      for (let i = 0; i < levels; i++) {
        if (this.current.parentElement) this.current = this.current.parentElement;
      }
      return `✓ @${this.current.tagName?.toLowerCase()}`;
    }

    ch() {
      const children = Array.from(this.current.children);
      if (children.length === 0) return '∅ no children';
      return children.slice(0, 15).map((c, i) => {
        const tag = c.tagName.toLowerCase();
        const cls = c.className ? '.' + String(c.className).split(' ')[0] : '';
        const text = c.textContent.replace(/\s+/g, ' ').trim().slice(0, 30);
        return `[${i}]<${tag}${cls}>${text}`;
      }).join('\n');
    }

    g(pattern, limit = 10) {
      const text = this.current.textContent;
      const lines = text.split('\n');
      const regex = new RegExp(pattern, 'gi');
      const matches = [];
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          const clean = line.replace(/\s+/g, ' ').trim();
          if (clean) matches.push(`L${i + 1}: ${clean.slice(0, 60)}`);
        }
      });
      if (matches.length === 0) return '∅ no matches';
      return matches.slice(0, limit).join('\n');
    }

    look() {
      const interactive = this.current.querySelectorAll(
        'a, button, input, select, textarea, [onclick], [href], .btn, [role="button"]'
      );
      const items = [];
      interactive.forEach((el, idx) => {
        const text = (el.textContent || el.value || el.placeholder || el.title || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ').trim().slice(0, 20);
        if (text || el.tagName.toLowerCase() === 'input') {
          items.push({ text: text || `[${el.type || 'input'}]`, el, idx });
        }
      });
      this.lastGrid = items;
      if (items.length === 0) return '∅ no interactive elements';
      let out = `${items.length} elements\n`;
      items.slice(0, 20).forEach((item, i) => {
        const tag = item.el.tagName.toLowerCase();
        const href = item.el.getAttribute('href');
        const hrefStr = href ? ` →${href.slice(0, 25)}` : '';
        out += `@${i} <${tag}> "${item.text}"${hrefStr}\n`;
      });
      return out.trim();
    }

    click(index) {
      if (!this.lastGrid || index >= this.lastGrid.length) {
        return '✗ call look first or index out of range';
      }
      const item = this.lastGrid[index];
      try { item.el.click(); } catch (e) { /* ignore */ }
      return `✓ clicked "${item.text}"`;
    }

    a() {
      if (!this.current.attributes) return '∅';
      const attrs = [];
      for (const attr of this.current.attributes) {
        attrs.push(`${attr.name}=${attr.value.slice(0, 30)}`);
      }
      if (attrs.length === 0) return '∅ no attrs';
      return attrs.join(' ');
    }

    h(limit) {
      let html = this.current.outerHTML;
      if (limit && html.length > limit) html = html.slice(0, limit) + '…[truncated]';
      return html;
    }

    store(name) {
      this.vars[name] = this.current.textContent;
      return `✓ $${name} (${this.vars[name].length} chars)`;
    }

    recall(expr) {
      const match = expr.match(/^\$(\w+)(\.(.+))?$/);
      if (!match) return '✗ invalid var syntax';
      const name = match[1];
      const prop = match[3];
      if (!this.vars[name]) return `✗ $${name} not set`;
      if (prop === 'length') return String(this.vars[name].length);
      if (prop) return '✗ unknown property';
      return this.vars[name].slice(0, 500);
    }

    pipe(operation, arg) {
      const lastText = this.vars['_'] || this.current.textContent;
      if (operation === 'grep' || operation === 'g') {
        const regex = new RegExp(arg, 'gi');
        const lines = lastText.split('\n').filter(l => regex.test(l));
        return lines.slice(0, 10).map(l => l.trim().slice(0, 60)).join('\n') || '∅';
      }
      if (operation === 'wc') {
        return `${lastText.split(/\s+/).filter(w => w).length} words`;
      }
      if (operation === 'head') {
        const n = parseInt(arg) || 10;
        return lastText.split('\n').slice(0, n).join('\n');
      }
      return '✗ unknown pipe: ' + operation;
    }

    _depth(el) {
      let d = 0;
      while (el && el !== this.doc.body && el !== this.doc.documentElement) {
        d++;
        el = el.parentElement;
      }
      return d;
    }

    exec(cmd) {
      const p = parseCommand(cmd);
      switch (p.type) {
        case 's': return this.s();
        case 't': return this.t(p.limit);
        case 'q': return this.q(p.selector, p.limit);
        case 'q1': return this.q1(p.selector);
        case 'n': return this.n(p.index);
        case 'up': return this.up(p.levels);
        case 'ch': return this.ch();
        case 'g': return this.g(p.pattern, p.limit);
        case 'look': return this.look();
        case 'click': return this.click(p.index);
        case 'a': return this.a();
        case 'h': return this.h(p.limit);
        case 'store': return this.store(p.name);
        case 'recall': return this.recall(p.expr);
        case 'pipe': return this.pipe(p.operation, p.arg);
        case 'batch': return p.commands.map(c => this.exec(c)).join('\n---\n');
        default: return `✗ unknown: ${cmd}`;
      }
    }
  }

  // ==================== PUBLIC API ====================

  const HC = {
    VERSION: '2.0.0',

    /**
     * Create session from HTML string
     */
    open: function(html, source = 'page') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      return new HCSession(doc, source);
    },

    /**
     * Create session on live page DOM
     */
    live: function() {
      return new HCSession(document, 'live');
    },

    /**
     * Create session on iframe content
     */
    iframe: function(selector) {
      const iframe = document.querySelector(selector);
      if (!iframe) throw new Error(`Iframe not found: ${selector}`);
      if (!iframe.contentDocument) throw new Error('Cannot access iframe document (CORS?)');
      return new HCSession(iframe.contentDocument, selector);
    },

    /**
     * Create session on any Document
     */
    create: function(doc, source = 'page') {
      return new HCSession(doc, source);
    },

    /**
     * One-shot command on HTML string
     */
    exec: function(html, cmd, source = 'page') {
      return this.open(html, source).exec(cmd);
    },

    // Expose class for advanced usage
    HCSession: HCSession
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HC;
  }
  global.HC = HC;
  global.Hypercompact = HC;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
