/**
 * Shared copy/paste utilities for terminal buffer extraction and text cleanup.
 * Used by both ShiroTerminal (main) and WindowTerminal (spawned windows).
 */

import type { Terminal } from '@xterm/xterm';

/**
 * Extract terminal buffer content as a string, respecting soft-wrapped lines.
 * xterm.js sets `isWrapped` on continuation rows — these should be concatenated
 * without inserting `\n`, since they're a single logical line that wrapped.
 */
export function bufferToString(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  let current = '';

  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;

    const text = line.translateToString(true);
    if (line.isWrapped) {
      // Continuation of previous logical line — append without newline
      current += text;
    } else {
      // New logical line — push previous and start fresh
      if (i > 0) lines.push(current);
      current = text;
    }
  }
  // Push the last line
  lines.push(current);

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return lines.join('\n');
}

/**
 * Strip consistent leading whitespace from all non-empty lines.
 * Handles Claude Code's 2-4 space padding. Conservative: if the indent
 * isn't uniform across all non-empty lines, leaves text untouched.
 */
export function smartCopyProcess(text: string): string {
  if (!text) return text;

  const lines = text.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);

  if (nonEmptyLines.length === 0) return text;

  // Find the minimum leading whitespace among non-empty lines
  let minIndent = Infinity;
  for (const line of nonEmptyLines) {
    const match = line.match(/^( +)/);
    if (match) {
      minIndent = Math.min(minIndent, match[1].length);
    } else {
      // A non-empty line with no leading space — no uniform indent
      minIndent = 0;
      break;
    }
  }

  if (minIndent === 0 || minIndent === Infinity) return text;

  // Verify all non-empty lines have at least this much indent
  const prefix = ' '.repeat(minIndent);
  for (const line of nonEmptyLines) {
    if (!line.startsWith(prefix)) return text;
  }

  // Strip the uniform indent
  return lines
    .map(l => (l.trim().length > 0 ? l.slice(minIndent) : l))
    .join('\n');
}
