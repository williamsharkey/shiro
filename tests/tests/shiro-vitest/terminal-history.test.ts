import { describe, it, expect } from 'vitest';

/**
 * Tests for terminal multi-line history redraw logic.
 *
 * The actual ShiroTerminal requires xterm.js which needs a real DOM + canvas.
 * These tests verify the row-calculation logic used by redrawLine() to
 * properly clear wrapped lines when navigating history.
 *
 * For full integration testing, use skyeyes:
 *   1. Load shiro in a browser
 *   2. Type a long command that wraps (100+ chars)
 *   3. Press Enter, then type a short command, press Enter
 *   4. Press Up twice to recall the long command
 *   5. Press Up/Down to navigate — no junk lines should remain
 *   6. Verify with: term.buffer.active.getLine(row).translateToString(true)
 */

/** Mirrors the row calculation in terminal.ts redrawLine() */
function calculateDisplayedRows(promptLength: number, inputLength: number, cols: number): number {
  const totalChars = promptLength + inputLength;
  return Math.max(1, Math.ceil(totalChars / cols));
}

describe('Terminal history row calculation', () => {
  // Typical prompt: "user@shiro:~$ " = 14 chars
  const PROMPT_LEN = 14;

  it('short input fits in one row', () => {
    expect(calculateDisplayedRows(PROMPT_LEN, 10, 80)).toBe(1);
  });

  it('input that exactly fills one row', () => {
    // 14 + 66 = 80 chars = exactly 1 row
    expect(calculateDisplayedRows(PROMPT_LEN, 66, 80)).toBe(1);
  });

  it('input that wraps to two rows', () => {
    // 14 + 67 = 81 chars → 2 rows on 80-col terminal
    expect(calculateDisplayedRows(PROMPT_LEN, 67, 80)).toBe(2);
  });

  it('long input wraps to many rows', () => {
    // 14 + 226 = 240 chars → 3 rows on 80-col terminal
    expect(calculateDisplayedRows(PROMPT_LEN, 226, 80)).toBe(3);
  });

  it('empty input is 1 row', () => {
    expect(calculateDisplayedRows(PROMPT_LEN, 0, 80)).toBe(1);
  });

  it('narrow terminal wraps sooner', () => {
    // 14 + 30 = 44 chars on 40-col terminal → 2 rows
    expect(calculateDisplayedRows(PROMPT_LEN, 30, 40)).toBe(2);
  });

  it('very long input on narrow terminal', () => {
    // 14 + 200 = 214 chars on 40-col terminal → ceil(214/40) = 6 rows
    expect(calculateDisplayedRows(PROMPT_LEN, 200, 40)).toBe(6);
  });
});
