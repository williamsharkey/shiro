import { describe, it, expect, beforeEach } from 'vitest';
import { smartCopyProcess, bufferToString } from '@shiro/utils/copy-utils';
import { Terminal } from '@xterm/xterm';

describe('smartCopyProcess', () => {
  it('strips consistent 2-space indent', () => {
    const input = '  line one\n  line two\n  line three';
    expect(smartCopyProcess(input)).toBe('line one\nline two\nline three');
  });

  it('strips consistent 4-space indent', () => {
    const input = '    hello\n    world';
    expect(smartCopyProcess(input)).toBe('hello\nworld');
  });

  it('leaves text alone when indent is inconsistent', () => {
    const input = '  line one\n    line two\n line three';
    // Min indent is 1, all non-empty lines have at least 1 space
    expect(smartCopyProcess(input)).toBe(' line one\n   line two\nline three');
  });

  it('handles empty lines within indented blocks', () => {
    const input = '  line one\n\n  line three';
    expect(smartCopyProcess(input)).toBe('line one\n\nline three');
  });

  it('handles empty string', () => {
    expect(smartCopyProcess('')).toBe('');
  });

  it('handles single line with indent', () => {
    expect(smartCopyProcess('   hello')).toBe('hello');
  });

  it('handles single line without indent', () => {
    expect(smartCopyProcess('hello')).toBe('hello');
  });

  it('leaves text untouched when no indent', () => {
    const input = 'line one\nline two\nline three';
    expect(smartCopyProcess(input)).toBe(input);
  });

  it('preserves relative indentation', () => {
    const input = '    base\n      nested\n    base again';
    expect(smartCopyProcess(input)).toBe('base\n  nested\nbase again');
  });

  it('handles lines with only spaces as empty', () => {
    const input = '  code\n   \n  more code';
    // The "   " line is only spaces — trimmed to empty, so it's skipped for indent calc
    expect(smartCopyProcess(input)).toBe('code\n   \nmore code');
  });
});

/** Helper: write to terminal and wait for the write to complete */
function termWrite(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, resolve);
  });
}

describe('bufferToString', () => {
  let term: Terminal;

  beforeEach(() => {
    const container = document.createElement('div');
    container.style.width = '400px';
    container.style.height = '300px';
    document.body.appendChild(container);

    term = new Terminal({ cols: 40, rows: 10, scrollback: 100 });
    term.open(container);
  });

  it('returns empty string for empty buffer', () => {
    const result = bufferToString(term);
    expect(result).toBe('');
  });

  it('extracts single short line', async () => {
    await termWrite(term, 'hello world');
    const result = bufferToString(term);
    expect(result).toContain('hello world');
  });

  it('handles multiple lines', async () => {
    await termWrite(term, 'line one\r\nline two\r\nline three');
    const result = bufferToString(term);
    expect(result).toContain('line one');
    expect(result).toContain('line two');
    expect(result).toContain('line three');
    const lines = result.split('\n');
    expect(lines.some(l => l.includes('line one'))).toBe(true);
    expect(lines.some(l => l.includes('line two'))).toBe(true);
  });

  it('concatenates soft-wrapped lines without newline', async () => {
    // Write a string longer than terminal width (40 cols)
    const longStr = 'A'.repeat(60);
    await termWrite(term, longStr);

    const result = bufferToString(term);
    // Should be a single logical line with all 60 A's, no spurious \n
    expect(result).toContain(longStr);
    const lines = result.split('\n');
    const aLine = lines.find(l => l.includes('AAAA'));
    expect(aLine).toBeDefined();
    expect(aLine!.replace(/\s/g, '').length).toBeGreaterThanOrEqual(60);
  });

  it('handles mix of short and long lines', async () => {
    await termWrite(term, 'short\r\n' + 'B'.repeat(80) + '\r\nend');

    const result = bufferToString(term);
    const lines = result.split('\n');

    expect(lines.some(l => l.includes('short'))).toBe(true);
    const bLine = lines.find(l => l.includes('BBBB'));
    expect(bLine).toBeDefined();
    expect(bLine!.replace(/\s/g, '').length).toBeGreaterThanOrEqual(80);
    expect(lines.some(l => l.includes('end'))).toBe(true);
  });

  it('trims trailing empty lines', async () => {
    await termWrite(term, 'content\r\n\r\n\r\n');
    const result = bufferToString(term);
    expect(result.endsWith('\n')).toBe(false);
    expect(result).toContain('content');
  });

  it('handles multiple wrapped lines correctly', async () => {
    const line1 = 'X'.repeat(50);
    const line2 = 'Y'.repeat(50);
    await termWrite(term, line1 + '\r\n' + line2);

    const result = bufferToString(term);
    const lines = result.split('\n');

    const xLine = lines.find(l => l.includes('XXXX'));
    const yLine = lines.find(l => l.includes('YYYY'));
    expect(xLine).toBeDefined();
    expect(yLine).toBeDefined();
    expect(xLine!.replace(/\s/g, '').length).toBeGreaterThanOrEqual(50);
    expect(yLine!.replace(/\s/g, '').length).toBeGreaterThanOrEqual(50);
  });
});
