#!/usr/bin/env node
/**
 * Hypercompact Tool v2
 * Combines best of Lens + Skyeyes + HC
 *
 * Design principles:
 * 1. Terse returns ("✓" not {"success":true})
 * 2. Grid navigation for visual UIs
 * 3. State compression
 * 4. Blind operations
 * 5. Batching
 */

const fs = require('fs');
const { JSDOM } = require('jsdom');

class HypercompactSession {
  constructor(htmlPath) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    this.dom = new JSDOM(html);
    this.doc = this.dom.window.document;
    this.current = this.doc.body;
    this.lastResults = [];
    this.vars = {};
    this.lastGrid = null;
    this.path = htmlPath;
  }

  // ==================== STATE ====================

  // Compressed state - one line, full context
  // s → "p:/products c:47 d:3 @body"
  s() {
    const path = this.path.split('/').pop();
    const count = this.lastResults.length;
    const depth = this._depth(this.current);
    const tag = this.current.tagName?.toLowerCase() || 'doc';
    return `p:${path} c:${count} d:${depth} @${tag}`;
  }

  // ==================== TEXT EXTRACTION ====================

  // t - get text, normalized whitespace
  // t → "Shop Cart Login Featured Apple $5..."
  // t100 → first ~100 chars
  t(limit) {
    let text = this.current.textContent.replace(/\s+/g, ' ').trim();
    if (limit && text.length > limit) {
      text = text.slice(0, limit) + '…';
    }
    return text;
  }

  // ==================== QUERY ====================

  // q selector → indexed list, terse
  // q .price → "[0]$5.99 [1]$12.99 [2]$3.49"
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

  // q1 selector → single element, set as current
  // q1 h1 → "Welcome to Our Store"
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

  // ==================== NAVIGATION ====================

  // n3 → select 3rd from last results, set as current
  n(index) {
    if (index >= this.lastResults.length) return '✗ out of range';
    this.current = this.lastResults[index];
    const text = this.current.textContent.replace(/\s+/g, ' ').trim().slice(0, 100);
    return `✓ [${index}] ${text}`;
  }

  // up → parent, up3 → 3 levels up
  up(levels = 1) {
    for (let i = 0; i < levels; i++) {
      if (this.current.parentElement) {
        this.current = this.current.parentElement;
      }
    }
    return `✓ @${this.current.tagName?.toLowerCase()}`;
  }

  // ch → children summary
  ch() {
    const children = Array.from(this.current.children);
    if (children.length === 0) return '∅ no children';
    return children.slice(0, 15).map((c, i) => {
      const tag = c.tagName.toLowerCase();
      const cls = c.className ? '.' + c.className.split(' ')[0] : '';
      const text = c.textContent.replace(/\s+/g, ' ').trim().slice(0, 30);
      return `[${i}]<${tag}${cls}>${text}`;
    }).join('\n');
  }

  // ==================== GREP ====================

  // g pattern → find text matches with context
  // g price → "L23: price: $5.99\nL45: price: $12.99"
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

  // ==================== GRID VIEW (from Lens) ====================

  // look → render clickable elements as text grid
  // look → "12 elements\n  0123456789...\n0│[Shop] [Cart]..."
  look(width = 50, height = 15) {
    const rect = { left: 0, top: 0, width: 1000, height: 800 };
    const interactive = this.current.querySelectorAll(
      'a, button, input, select, [onclick], [href], .btn, [role="button"]'
    );

    const items = [];
    interactive.forEach((el, idx) => {
      const text = (el.textContent || el.value || el.placeholder || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 15);
      if (text) {
        // Simulate grid positions based on DOM order
        const row = Math.floor(idx / 5) % height;
        const col = (idx % 5) * 10;
        items.push({ row, col, text, el, idx });
      }
    });

    this.lastGrid = items;

    if (items.length === 0) return '∅ no interactive elements';

    // Build simple list view (more reliable than grid)
    let out = `${items.length} elements\n`;
    items.slice(0, 20).forEach((item, i) => {
      const tag = item.el.tagName.toLowerCase();
      const href = item.el.href ? ' →' + item.el.href.slice(0, 30) : '';
      out += `@${i} <${tag}> "${item.text}"${href}\n`;
    });

    return out;
  }

  // @n → click nth element from look()
  // @3 → "✓ clicked 'Add to Cart'"
  click(index) {
    if (!this.lastGrid || index >= this.lastGrid.length) {
      return '✗ call look first or index out of range';
    }
    const item = this.lastGrid[index];
    // In real browser, would call item.el.click()
    return `✓ clicked "${item.text}"`;
  }

  // ==================== ATTRIBUTES ====================

  // a → get attributes of current element
  // a → "href=/products class=btn id=submit"
  a() {
    if (!this.current.attributes) return '∅';
    const attrs = Array.from(this.current.attributes);
    if (attrs.length === 0) return '∅ no attrs';
    return attrs.map(a => `${a.name}=${a.value.slice(0, 30)}`).join(' ');
  }

  // ==================== HTML ====================

  // h → outer HTML of current, h200 → limited
  h(limit) {
    let html = this.current.outerHTML;
    if (limit && html.length > limit) {
      html = html.slice(0, limit) + '…[truncated]';
    }
    return html;
  }

  // ==================== VARIABLES (blind ops) ====================

  // >$x → store current text in var (returns just "✓ $x")
  store(name) {
    this.vars[name] = this.current.textContent;
    const len = this.vars[name].length;
    return `✓ $${name} (${len} chars)`;
  }

  // $x → retrieve var
  // $x.length → property access
  recall(expr) {
    const match = expr.match(/^\$(\w+)(\.(.+))?$/);
    if (!match) return '✗ invalid var syntax';
    const name = match[1];
    const prop = match[3];

    if (!this.vars[name]) return `✗ $${name} not set`;

    if (prop === 'length') return String(this.vars[name].length);
    if (prop) return '✗ unknown property';

    // Return actual value (normally would be filtered first)
    return this.vars[name].slice(0, 500);
  }

  // ==================== PIPE OPERATIONS ====================

  // Simulate grep on last result
  pipe(operation, arg) {
    const lastText = this.vars['_'] || this.current.textContent;

    if (operation === 'grep' || operation === 'g') {
      const regex = new RegExp(arg, 'gi');
      const lines = lastText.split('\n').filter(l => regex.test(l));
      return lines.slice(0, 10).map(l => l.trim().slice(0, 60)).join('\n') || '∅';
    }
    if (operation === 'wc') {
      const words = lastText.split(/\s+/).filter(w => w).length;
      return `${words} words`;
    }
    if (operation === 'head') {
      const n = parseInt(arg) || 10;
      return lastText.split('\n').slice(0, n).join('\n');
    }

    return '✗ unknown pipe: ' + operation;
  }

  // ==================== BATCH ====================

  // Run multiple commands, return combined results
  // batch("t100; q .price; n0") → "text...\n---\n[0]$5...\n---\n✓ [0]..."
  batch(cmds) {
    const results = [];
    for (const cmd of cmds.split(';').map(c => c.trim())) {
      if (cmd) results.push(this.exec(cmd));
    }
    return results.join('\n---\n');
  }

  // ==================== HELPERS ====================

  _depth(el) {
    let d = 0;
    while (el && el !== this.doc.body) {
      d++;
      el = el.parentElement;
    }
    return d;
  }

  // ==================== COMMAND PARSER ====================

  exec(cmd) {
    cmd = cmd.trim();

    // State
    if (cmd === 's') return this.s();

    // Text
    if (cmd === 't') return this.t();
    if (cmd.match(/^t(\d+)$/)) return this.t(parseInt(cmd.slice(1)));

    // Query
    if (cmd.startsWith('q1 ')) return this.q1(cmd.slice(3));
    if (cmd.startsWith('q ')) return this.q(cmd.slice(2));

    // Navigation
    if (cmd.match(/^n(\d+)$/)) return this.n(parseInt(cmd.slice(1)));
    if (cmd === 'up') return this.up();
    if (cmd.match(/^up(\d+)$/)) return this.up(parseInt(cmd.slice(2)));
    if (cmd === 'ch') return this.ch();

    // Grep
    if (cmd.startsWith('g ')) return this.g(cmd.slice(2));

    // Grid/Look
    if (cmd === 'look') return this.look();
    if (cmd.match(/^@(\d+)$/)) return this.click(parseInt(cmd.slice(1)));

    // Attributes
    if (cmd === 'a') return this.a();

    // HTML
    if (cmd === 'h') return this.h();
    if (cmd.match(/^h(\d+)$/)) return this.h(parseInt(cmd.slice(1)));

    // Variables
    if (cmd.match(/^>\$(\w+)$/)) return this.store(cmd.slice(2));
    if (cmd.match(/^\$\w+/)) return this.recall(cmd);

    // Pipe
    if (cmd.includes('|')) {
      const [_, op, arg] = cmd.match(/\|\s*(\w+)\s*(.*)/) || [];
      if (op) return this.pipe(op, arg?.trim());
    }

    // Batch
    if (cmd.includes(';')) return this.batch(cmd);

    return '✗ unknown: ' + cmd;
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log(`Hypercompact v2 - Token-efficient web navigation

Usage: node hc_tool_v2.js <html_file> "<command>"

Commands:
  s              State: "p:file c:count d:depth @tag"
  t, t100        Text content (optional limit)
  q <sel>        Query all, indexed list
  q1 <sel>       Query one, set as current
  n<N>           Select Nth from last query
  up, up<N>      Go to parent (N levels)
  ch             Children summary
  g <pattern>    Grep with line numbers
  look           List interactive elements
  @<N>           Click Nth from look
  a              Attributes of current
  h, h<N>        HTML (optional limit)
  >$x            Store in variable
  $x             Recall variable
  |grep <pat>    Pipe through grep
  cmd1; cmd2     Batch multiple commands

Examples:
  node hc_tool_v2.js page.html "t100"
  node hc_tool_v2.js page.html "q .product; n2; a"
  node hc_tool_v2.js page.html "look; @3"
`);
    process.exit(1);
  }

  const [htmlFile, ...cmdParts] = args;
  const cmd = cmdParts.join(' ');

  try {
    const session = new HypercompactSession(htmlFile);
    console.log(session.exec(cmd));
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}

module.exports = { HypercompactSession };
