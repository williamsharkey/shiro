/**
 * Hypercompact Core - Context-Agnostic DOM Navigation
 *
 * This is the core implementation that works with ANY Document object:
 * - Browser native DOM
 * - DOMParser-created documents
 * - linkedom (Node.js)
 * - jsdom (Node.js)
 *
 * Key principle: This module has NO dependencies on how the Document was created.
 * It receives a Document and navigates it.
 */

const { parseCommand } = require('./parser.js');

/**
 * HCSession - A Hypercompact navigation session
 *
 * @param {Document} doc - Any DOM Document object
 * @param {string} [source='page'] - Name/path for status display
 */
class HCSession {
  constructor(doc, source = 'page') {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      throw new Error('HCSession requires a Document object with querySelectorAll');
    }

    this.doc = doc;
    this.source = source;
    this.current = doc.body || doc.documentElement;
    this.lastResults = [];
    this.lastGrid = null;
    this.vars = {};
  }

  // ==================== COMMANDS ====================

  /**
   * s - State: compressed status line
   * @returns {string} "p:source c:count d:depth @tag"
   */
  s() {
    const name = this.source.split('/').pop();
    const count = this.lastResults.length;
    const depth = this._depth(this.current);
    const tag = this.current.tagName?.toLowerCase() || 'doc';
    return `p:${name} c:${count} d:${depth} @${tag}`;
  }

  /**
   * t - Text content with optional limit
   * @param {number} [limit] - Max characters to return
   * @returns {string} Normalized text content
   */
  t(limit) {
    let text = this.current.textContent.replace(/\s+/g, ' ').trim();
    if (limit && text.length > limit) {
      text = text.slice(0, limit) + '…';
    }
    return text;
  }

  /**
   * q - Query all matching elements
   * @param {string} selector - CSS selector
   * @param {number} [limit=10] - Max results to show
   * @returns {string} Indexed list "[0]text [1]text..."
   */
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

  /**
   * q1 - Query one element, set as current
   * @param {string} selector - CSS selector
   * @returns {string} Element text content
   */
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

  /**
   * n - Select Nth from last results
   * @param {number} index - Zero-based index
   * @returns {string} "✓ [N] text..."
   */
  n(index) {
    if (index >= this.lastResults.length) return '✗ out of range';
    this.current = this.lastResults[index];
    const text = this.current.textContent.replace(/\s+/g, ' ').trim().slice(0, 100);
    return `✓ [${index}] ${text}`;
  }

  /**
   * up - Navigate to parent element
   * @param {number} [levels=1] - How many levels up
   * @returns {string} "✓ @tag"
   */
  up(levels = 1) {
    for (let i = 0; i < levels; i++) {
      if (this.current.parentElement) {
        this.current = this.current.parentElement;
      }
    }
    return `✓ @${this.current.tagName?.toLowerCase()}`;
  }

  /**
   * ch - Show children summary
   * @returns {string} Indexed list of children
   */
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

  /**
   * g - Grep for pattern in text
   * @param {string} pattern - Regex pattern
   * @param {number} [limit=10] - Max results
   * @returns {string} "L23: matching line..."
   */
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

  /**
   * look - List interactive elements
   * @returns {string} "@0 <tag> \"text\" →href"
   */
  look() {
    const interactive = this.current.querySelectorAll(
      'a, button, input, select, textarea, [onclick], [href], .btn, [role="button"]'
    );

    const items = [];
    interactive.forEach((el, idx) => {
      const text = (
        el.textContent ||
        el.value ||
        el.placeholder ||
        el.title ||
        el.getAttribute('aria-label') ||
        ''
      ).replace(/\s+/g, ' ').trim().slice(0, 20);

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

  /**
   * click - Click Nth element from look()
   * @param {number} index - Zero-based index
   * @returns {string} "✓ clicked \"text\""
   */
  click(index) {
    if (!this.lastGrid || index >= this.lastGrid.length) {
      return '✗ call look first or index out of range';
    }
    const item = this.lastGrid[index];

    // Actually click if in browser context
    if (typeof item.el.click === 'function') {
      try {
        item.el.click();
      } catch (e) {
        // Ignore click errors in non-browser environments
      }
    }

    return `✓ clicked "${item.text}"`;
  }

  /**
   * a - Get attributes of current element
   * @returns {string} "attr=value attr=value..."
   */
  a() {
    if (!this.current.attributes) return '∅';
    const attrs = [];
    for (const attr of this.current.attributes) {
      attrs.push(`${attr.name}=${attr.value.slice(0, 30)}`);
    }
    if (attrs.length === 0) return '∅ no attrs';
    return attrs.join(' ');
  }

  /**
   * h - Get HTML of current element
   * @param {number} [limit] - Max characters
   * @returns {string} Outer HTML
   */
  h(limit) {
    let html = this.current.outerHTML;
    if (limit && html.length > limit) {
      html = html.slice(0, limit) + '…[truncated]';
    }
    return html;
  }

  /**
   * store - Save current text to variable (blind operation)
   * @param {string} name - Variable name
   * @returns {string} "✓ $name (N chars)"
   */
  store(name) {
    this.vars[name] = this.current.textContent;
    const len = this.vars[name].length;
    return `✓ $${name} (${len} chars)`;
  }

  /**
   * recall - Retrieve variable value
   * @param {string} expr - Variable expression ($name or $name.length)
   * @returns {string} Variable value or property
   */
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

  /**
   * pipe - Pipe operation on last text
   * @param {string} operation - 'grep', 'wc', 'head'
   * @param {string} arg - Operation argument
   * @returns {string} Operation result
   */
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

  // ==================== HELPERS ====================

  _depth(el) {
    let d = 0;
    while (el && el !== this.doc.body && el !== this.doc.documentElement) {
      d++;
      el = el.parentElement;
    }
    return d;
  }

  // ==================== MAIN ENTRY ====================

  /**
   * exec - Execute a Hypercompact command
   * @param {string} cmd - Command string
   * @returns {string} Command result
   */
  exec(cmd) {
    const parsed = parseCommand(cmd);

    switch (parsed.type) {
      case 's': return this.s();
      case 't': return this.t(parsed.limit);
      case 'q': return this.q(parsed.selector, parsed.limit);
      case 'q1': return this.q1(parsed.selector);
      case 'n': return this.n(parsed.index);
      case 'up': return this.up(parsed.levels);
      case 'ch': return this.ch();
      case 'g': return this.g(parsed.pattern, parsed.limit);
      case 'look': return this.look();
      case 'click': return this.click(parsed.index);
      case 'a': return this.a();
      case 'h': return this.h(parsed.limit);
      case 'store': return this.store(parsed.name);
      case 'recall': return this.recall(parsed.expr);
      case 'pipe': return this.pipe(parsed.operation, parsed.arg);
      case 'batch':
        return parsed.commands.map(c => this.exec(c)).join('\n---\n');
      case 'unknown':
      default:
        return `✗ unknown: ${cmd}`;
    }
  }
}

module.exports = { HCSession };
