#!/usr/bin/env node
/**
 * Hypercompact Tool Simulator
 * Simulates the REPL for token efficiency study
 */

const fs = require('fs');
const { JSDOM } = require('jsdom');

class HypercompactSession {
  constructor(htmlPath) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    this.dom = new JSDOM(html);
    this.doc = this.dom.window.document;
    this.currentElement = this.doc.body;
    this.lastResults = [];
    this.variables = {};
  }

  // Get normalized text content
  t(limit = null) {
    let text = this.currentElement.textContent
      .replace(/\s+/g, ' ')
      .trim();
    if (limit && text.length > limit) {
      text = text.slice(0, limit) + '...';
    }
    return text;
  }

  // Query selector all - returns indexed list
  q(selector, limit = 10) {
    const elements = Array.from(this.doc.querySelectorAll(selector));
    this.lastResults = elements;
    return elements.slice(0, limit).map((el, i) => {
      const text = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
      return `[${i}]${text}`;
    }).join('\n');
  }

  // Query selector single
  q1(selector) {
    const el = this.doc.querySelector(selector);
    if (!el) return 'null';
    this.currentElement = el;
    this.lastResults = [el];
    return el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  // Zoom to text occurrence
  z(keyword, occurrence = 1) {
    const walker = this.doc.createTreeWalker(
      this.doc.body,
      4, // NodeFilter.SHOW_TEXT
      null,
      false
    );

    let count = 0;
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.toLowerCase().includes(keyword.toLowerCase())) {
        count++;
        if (count === occurrence) {
          const parent = node.parentElement;
          this.currentElement = parent;

          // Get context: parent's text with depth indicator
          let depth = 0;
          let el = parent;
          while (el && el !== this.doc.body) {
            depth++;
            el = el.parentElement;
          }

          const context = parent.textContent.replace(/\s+/g, ' ').trim().slice(0, 150);
          return `${depth}(${context})`;
        }
      }
    }
    return `not found: ${keyword}`;
  }

  // Get outer HTML of current element (with optional limit)
  h(limit = null) {
    let html = this.currentElement.outerHTML;
    if (limit && html.length > limit) {
      html = html.slice(0, limit) + '...[truncated]';
    }
    return html;
  }

  // Navigate to nth result from last query
  n(index) {
    if (index >= this.lastResults.length) return 'index out of range';
    this.currentElement = this.lastResults[index];
    return this.currentElement.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  // Get children summary
  ch() {
    const children = Array.from(this.currentElement.children);
    return children.slice(0, 10).map((c, i) => {
      const tag = c.tagName.toLowerCase();
      const text = c.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
      return `[${i}]<${tag}>${text}`;
    }).join('\n');
  }

  // Go to parent
  up(levels = 1) {
    for (let i = 0; i < levels; i++) {
      if (this.currentElement.parentElement) {
        this.currentElement = this.currentElement.parentElement;
      }
    }
    return `now at: <${this.currentElement.tagName.toLowerCase()}>`;
  }

  // Store in variable (returns minimal acknowledgment)
  store(varName) {
    this.variables[varName] = this.currentElement.outerHTML;
    return `stored $${varName} (${this.variables[varName].length} chars)`;
  }

  // Execute command string
  exec(cmd) {
    cmd = cmd.trim();

    // Parse command
    if (cmd === 't') return this.t();
    if (cmd.match(/^t(\d+)$/)) return this.t(parseInt(cmd.slice(1)));
    if (cmd.startsWith('q1 ')) return this.q1(cmd.slice(3));
    if (cmd.startsWith('q ')) return this.q(cmd.slice(2));
    if (cmd.match(/^z\.(\w+)(\d*)$/)) {
      const m = cmd.match(/^z\.(\w+)(\d*)$/);
      return this.z(m[1], parseInt(m[2]) || 1);
    }
    if (cmd.match(/^z(\d+)$/)) {
      const idx = parseInt(cmd.slice(1));
      return this.n(idx);
    }
    if (cmd === 'h') return this.h();
    if (cmd.match(/^h(\d+)$/)) return this.h(parseInt(cmd.slice(1)));
    if (cmd.match(/^n(\d+)$/)) return this.n(parseInt(cmd.slice(1)));
    if (cmd === 'ch') return this.ch();
    if (cmd === 'up') return this.up();
    if (cmd.match(/^up(\d+)$/)) return this.up(parseInt(cmd.slice(2)));
    if (cmd.startsWith('>$')) return this.store(cmd.slice(2));

    return `unknown command: ${cmd}`;
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node hc_tool.js <html_file> <command>');
    console.log('Commands: t, t<n>, q <selector>, q1 <selector>, z.<word>, z<n>, h, h<n>, ch, up');
    process.exit(1);
  }

  const [htmlFile, ...cmdParts] = args;
  const cmd = cmdParts.join(' ');

  try {
    const session = new HypercompactSession(htmlFile);
    console.log(session.exec(cmd));
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

module.exports = { HypercompactSession };
