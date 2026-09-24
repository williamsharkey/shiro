import { describe, it, expect, beforeEach } from 'vitest';
import { record, queryConsole, clearConsoleLog, formatEntries } from '@shiro/console-log';

describe('bounded console log', () => {
  beforeEach(() => clearConsoleLog());

  it('collapses consecutive repeats into one entry with a count', () => {
    for (let i = 0; i < 50; i++) record('warn', 'same thing');
    record('log', 'different');
    const r = queryConsole();
    expect(r.entries.map((e) => [e.text, e.count])).toEqual([['same thing', 50], ['different', 1]]);
  });

  it('keeps the ring bounded in entries and characters', () => {
    for (let i = 0; i < 5000; i++) record('log', `line ${i}`);
    expect(queryConsole({ limit: 1e9, maxBytes: 1e9 }).total).toBeLessThanOrEqual(3000);
    clearConsoleLog();
    for (let i = 0; i < 2000; i++) record('log', `${i} ` + 'x'.repeat(1990));
    const all = queryConsole({ limit: 1e9, maxBytes: 1e9 });
    const chars = all.entries.reduce((n, e) => n + e.text.length, 0);
    expect(chars).toBeLessThanOrEqual(1_500_000);
    expect(all.entries.at(-1)!.text.startsWith('1999 ')).toBe(true); // newest kept
  });

  it('truncates very long messages', () => {
    record('error', 'y'.repeat(10_000));
    const e = queryConsole().entries[0];
    expect(e.text.length).toBeLessThan(2100);
    expect(e.text).toContain('more chars');
  });

  it('filters by regex, level, and time, newest last', () => {
    record('log', '[fetch] /v1/messages 200');
    record('error', 'Unhandled rejection: boom');
    record('warn', '[fetch] SSE stream ended (58082 bytes)');
    expect(queryConsole({ grep: 'fetch' }).entries.map((e) => e.level)).toEqual(['log', 'warn']);
    expect(queryConsole({ level: 'error' }).entries).toHaveLength(1);
    expect(queryConsole({ grep: 'sse stream', level: 'warn,log' }).entries).toHaveLength(1);
    expect(queryConsole({ since: Date.now() + 60_000 }).entries).toHaveLength(0);
    expect(queryConsole({ since: -60_000 }).entries).toHaveLength(3);
  });

  it('caps replies by limit and bytes and says so', () => {
    for (let i = 0; i < 300; i++) record('log', `entry ${i} ` + 'z'.repeat(100));
    const byCount = queryConsole({ limit: 10 });
    expect(byCount.entries).toHaveLength(10);
    expect(byCount.entries.at(-1)!.text.startsWith('entry 299')).toBe(true);
    expect(byCount.truncated).toBe(true);
    expect(byCount.matched).toBe(300);
    const byBytes = queryConsole({ limit: 1000, maxBytes: 1000 });
    expect(byBytes.entries.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(1000);
    expect(byBytes.truncated).toBe(true);
    expect(formatEntries(byBytes)).toContain('raise limit/maxBytes');
  });

  it('treats a bad regex as a literal search', () => {
    record('log', 'value [unclosed');
    expect(queryConsole({ grep: '[unclosed' }).entries).toHaveLength(1);
  });

  it('stringifies objects at capture time instead of retaining them', () => {
    const obj: any = { a: 1 };
    console.log('obj', obj);
    obj.a = 2;
    const hit = queryConsole({ grep: '"a":' }).entries.at(-1);
    if (hit) expect(hit.text).toContain('"a":1');
  });
});
