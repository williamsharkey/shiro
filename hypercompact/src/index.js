/**
 * Hypercompact - Token-Efficient DOM Navigation
 *
 * "One DSL, Many Contexts"
 *
 * Usage in Node.js (with linkedom):
 *   const { createSession } = require('hypercompact');
 *   const { parseHTML } = require('linkedom');
 *   const { document } = parseHTML(html);
 *   const session = createSession(document, 'page.html');
 *   console.log(session.exec('q .price'));
 *
 * Usage in Browser:
 *   const { createSession } = window.Hypercompact;
 *   const doc = new DOMParser().parseFromString(html, 'text/html');
 *   const session = createSession(doc, 'page.html');
 *   console.log(session.exec('q .price'));
 *
 * Usage with live DOM:
 *   const session = createSession(document, 'live');
 *   console.log(session.exec('look'));
 */

const { HCSession } = require('./core.js');
const { parseCommand, describeCommand } = require('./parser.js');

/**
 * Create a new Hypercompact session
 *
 * @param {Document} doc - DOM Document object (from linkedom, DOMParser, or native)
 * @param {string} [source='page'] - Source name for status display
 * @returns {HCSession} Navigation session
 */
function createSession(doc, source = 'page') {
  return new HCSession(doc, source);
}

/**
 * One-shot command execution
 *
 * @param {Document} doc - DOM Document object
 * @param {string} cmd - HC command
 * @param {string} [source='page'] - Source name
 * @returns {string} Command result
 */
function exec(doc, cmd, source = 'page') {
  const session = new HCSession(doc, source);
  return session.exec(cmd);
}

/**
 * Create session from HTML string (requires DOMParser or linkedom)
 *
 * In browser: uses native DOMParser
 * In Node.js: requires linkedom to be passed in
 *
 * @param {string} html - HTML string
 * @param {string} [source='page'] - Source name
 * @param {Object} [options] - Options
 * @param {Function} [options.parseHTML] - linkedom parseHTML function (Node.js only)
 * @returns {HCSession} Navigation session
 */
function fromHTML(html, source = 'page', options = {}) {
  let doc;

  if (typeof DOMParser !== 'undefined') {
    // Browser environment
    const parser = new DOMParser();
    doc = parser.parseFromString(html, 'text/html');
  } else if (options.parseHTML) {
    // Node.js with linkedom
    const result = options.parseHTML(html);
    doc = result.document;
  } else {
    throw new Error(
      'fromHTML requires DOMParser (browser) or options.parseHTML (linkedom in Node.js)'
    );
  }

  return new HCSession(doc, source);
}

/**
 * Version info
 */
const VERSION = '2.0.0';

/**
 * Quick reference for commands
 */
const COMMANDS = {
  s: 'State: "p:file c:N d:N @tag"',
  t: 'Text content (t100 for limit)',
  q: 'Query all: "q .price" → [0]$29 [1]$49',
  q1: 'Query one, set as current',
  n: 'Select Nth: "n2" → ✓ [2] ...',
  up: 'Parent: "up" or "up3"',
  ch: 'Children summary',
  g: 'Grep: "g pattern" → L23: match',
  look: 'List interactive elements',
  '@': 'Click: "@3" → ✓ clicked',
  a: 'Attributes of current',
  h: 'HTML (h200 for limit)',
  '>$': 'Store: ">$name" → ✓ $name (N chars)',
  '$': 'Recall: "$name" → value'
};

// Export everything
module.exports = {
  // Main API
  createSession,
  exec,
  fromHTML,

  // Classes (for advanced usage)
  HCSession,

  // Parser (for tools/extensions)
  parseCommand,
  describeCommand,

  // Info
  VERSION,
  COMMANDS
};

// Also expose as default for ES modules
module.exports.default = module.exports;
