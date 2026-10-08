import { describe, it, expect } from 'vitest';
import { WasiTTY, LineDiscipline } from '@shiro/wasi-tty';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('WasiTTY', () => {
  it('queues bytes and reads across chunk boundaries', () => {
    const tty = new WasiTTY();
    tty.pushText('ab');
    tty.pushText('cd');
    expect(text(tty.read(3))).toBe('abc');
    expect(text(tty.read(10))).toBe('d');
    expect(tty.readable()).toBe(false);
  });

  it('wait resolves on input, on timeout, and on EOF', async () => {
    const tty = new WasiTTY();
    expect(await tty.wait(5)).toBe(false);
    const pending = tty.wait();
    tty.pushText('x');
    expect(await pending).toBe(true);
    tty.read(1);
    const atEof = tty.wait();
    tty.close();
    expect(await atEof).toBe(true);
    expect(tty.isEOF()).toBe(true);
  });

  it('abort rejects waiters and later reads', async () => {
    const tty = new WasiTTY();
    const pending = tty.wait();
    tty.abort(new Error('killed'));
    await expect(pending).rejects.toThrow('killed');
    expect(() => tty.read(1)).toThrow('killed');
  });
});

describe('LineDiscipline', () => {
  const setup = () => {
    const tty = new WasiTTY();
    const echoed: string[] = [];
    let interrupted = 0;
    const ld = new LineDiscipline(tty, (s) => echoed.push(s), () => interrupted++);
    return { tty, ld, echoed, interrupted: () => interrupted };
  };

  it('cooked: echoes, edits, and delivers whole lines', () => {
    const { tty, ld, echoed } = setup();
    ld.input('helx');
    expect(tty.readable()).toBe(false);
    ld.input('\x7flo\r');
    expect(text(tty.read(100))).toBe('hello\n');
    expect(echoed.join('')).toBe('helx\b \blo\r\n');
  });

  it('cooked: ignores escape sequences such as arrow keys', () => {
    const { tty, ld } = setup();
    ld.input('a\x1b[Ab\x1bOC\x1b[3~c\r');
    expect(text(tty.read(100))).toBe('abc\n');
  });

  it('cooked: Ctrl-D is EOF on an empty line and flushes a partial one', () => {
    const { tty, ld } = setup();
    ld.input('partial\x04');
    expect(text(tty.read(100))).toBe('partial');
    ld.input('\x04');
    expect(tty.isEOF()).toBe(true);
  });

  it('cooked: Ctrl-C interrupts and drops the line', () => {
    const { tty, ld, interrupted } = setup();
    ld.input('abc\x03');
    expect(interrupted()).toBe(1);
    expect(tty.readable()).toBe(false);
  });

  it('raw: passes every byte through without echo', () => {
    const { tty, ld, echoed } = setup();
    tty.raw = true;
    ld.input('q\x1b[A\x03');
    expect(text(tty.read(100))).toBe('q\x1b[A\x03');
    expect(echoed).toEqual([]);
  });
});
