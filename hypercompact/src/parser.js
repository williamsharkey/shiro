/**
 * Hypercompact Command Parser
 *
 * Parses terse HC commands into structured objects.
 * This is separate from core.js to allow:
 * - Testing the parser independently
 * - Potential syntax extensions
 * - Clear separation of concerns
 */

/**
 * Parse a Hypercompact command string
 *
 * @param {string} cmd - Raw command string
 * @returns {Object} Parsed command with type and parameters
 *
 * @example
 * parseCommand('t100')     // { type: 't', limit: 100 }
 * parseCommand('q .price') // { type: 'q', selector: '.price' }
 * parseCommand('n2')       // { type: 'n', index: 2 }
 */
function parseCommand(cmd) {
  cmd = cmd.trim();

  // Empty command
  if (!cmd) {
    return { type: 'unknown', raw: cmd };
  }

  // Batch commands (contains ; but not in first position)
  if (cmd.includes(';') && !cmd.startsWith(';')) {
    const commands = cmd.split(';').map(c => c.trim()).filter(Boolean);
    return { type: 'batch', commands, raw: cmd };
  }

  // Pipe operations
  if (cmd.includes('|')) {
    const match = cmd.match(/\|\s*(\w+)\s*(.*)/);
    if (match) {
      return {
        type: 'pipe',
        operation: match[1],
        arg: match[2]?.trim() || '',
        raw: cmd
      };
    }
  }

  // State
  if (cmd === 's') {
    return { type: 's', raw: cmd };
  }

  // Text: t or t100
  if (cmd === 't') {
    return { type: 't', limit: null, raw: cmd };
  }
  const tMatch = cmd.match(/^t(\d+)$/);
  if (tMatch) {
    return { type: 't', limit: parseInt(tMatch[1]), raw: cmd };
  }

  // Query one: q1 selector
  if (cmd.startsWith('q1 ')) {
    return { type: 'q1', selector: cmd.slice(3).trim(), raw: cmd };
  }

  // Query all: q selector
  if (cmd.startsWith('q ')) {
    return { type: 'q', selector: cmd.slice(2).trim(), limit: 10, raw: cmd };
  }

  // Navigate to result: n0, n1, n2...
  const nMatch = cmd.match(/^n(\d+)$/);
  if (nMatch) {
    return { type: 'n', index: parseInt(nMatch[1]), raw: cmd };
  }

  // Up: up or up3
  if (cmd === 'up') {
    return { type: 'up', levels: 1, raw: cmd };
  }
  const upMatch = cmd.match(/^up(\d+)$/);
  if (upMatch) {
    return { type: 'up', levels: parseInt(upMatch[1]), raw: cmd };
  }

  // Children
  if (cmd === 'ch') {
    return { type: 'ch', raw: cmd };
  }

  // Grep: g pattern
  if (cmd.startsWith('g ')) {
    return { type: 'g', pattern: cmd.slice(2).trim(), limit: 10, raw: cmd };
  }

  // Look (list interactive elements)
  if (cmd === 'look') {
    return { type: 'look', raw: cmd };
  }

  // Click: @0, @1, @2...
  const clickMatch = cmd.match(/^@(\d+)$/);
  if (clickMatch) {
    return { type: 'click', index: parseInt(clickMatch[1]), raw: cmd };
  }

  // Attributes
  if (cmd === 'a') {
    return { type: 'a', raw: cmd };
  }

  // HTML: h or h200
  if (cmd === 'h') {
    return { type: 'h', limit: null, raw: cmd };
  }
  const hMatch = cmd.match(/^h(\d+)$/);
  if (hMatch) {
    return { type: 'h', limit: parseInt(hMatch[1]), raw: cmd };
  }

  // Store variable: >$name
  const storeMatch = cmd.match(/^>\$(\w+)$/);
  if (storeMatch) {
    return { type: 'store', name: storeMatch[1], raw: cmd };
  }

  // Recall variable: $name or $name.prop
  const recallMatch = cmd.match(/^(\$\w+(\.\w+)?)$/);
  if (recallMatch) {
    return { type: 'recall', expr: recallMatch[1], raw: cmd };
  }

  // Unknown command
  return { type: 'unknown', raw: cmd };
}

/**
 * Format a command for display (used in help text)
 * @param {string} type - Command type
 * @returns {string} Human-readable description
 */
function describeCommand(type) {
  const descriptions = {
    's': 'State: show current position',
    't': 'Text: get text content',
    'q': 'Query: find all matching elements',
    'q1': 'Query one: find first match, set as current',
    'n': 'Navigate: select Nth result',
    'up': 'Up: go to parent element',
    'ch': 'Children: show child elements',
    'g': 'Grep: search text for pattern',
    'look': 'Look: list interactive elements',
    'click': 'Click: click Nth interactive element',
    'a': 'Attributes: show element attributes',
    'h': 'HTML: show element HTML',
    'store': 'Store: save text to variable',
    'recall': 'Recall: retrieve variable',
    'pipe': 'Pipe: filter through operation',
    'batch': 'Batch: run multiple commands'
  };
  return descriptions[type] || 'Unknown command';
}

module.exports = { parseCommand, describeCommand };
