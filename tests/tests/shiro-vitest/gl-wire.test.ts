import { describe, it, expect } from 'vitest';
import { decodeBatch, BufferOffset, ReplyWriter, message, specOf, OPS, MSG_FRAME, BATCH_MAGIC, type Arg } from '@shiro/gl/wire';
import { batch, command, concat, ab, opOf } from './gl-encode';

/** The GL wire format (src/gl/wire.ts): what libGLX_tabcomputer sends and glshiro decodes. */
function decode(buf: Uint8Array) {
  const out: { ctx: number; name: string; args: Arg[] }[] = [];
  decodeBatch(ab(buf), (ctx, op, args) => out.push({ ctx, name: OPS[op][0], args: args.map((a) => (ArrayBuffer.isView(a) ? Array.from(a as unknown as ArrayLike<number | bigint>) as unknown as Arg : a)) }));
  return out;
}

describe('GL wire format', () => {
  it('compiles op specs, dropping the reply marker', () => {
    expect(specOf(opOf('glReadPixels'))).toEqual({ codes: ['i', 'i', 'i', 'i', 'u', 'u', 'q'], reply: true });
    expect(specOf(opOf('glTexImage2D'))).toEqual({ codes: ['u', 'i', 'i', 'i', 'i', 'i', 'u', 'u', 'Ab'], reply: false });
    expect(specOf(0)).toBeUndefined();
    expect(specOf(OPS.length + 5)).toBeUndefined();
  });

  it('round-trips every scalar code', () => {
    const got = decode(batch(7, [
      ['glBitmap', -3, 4, 1.5, -2.25, 0.5, 8, new Uint8Array([1, 2, 3])],
      ['glClearDepth', 0.123456789012],
      ['glBindBufferRange', 0x8a11, 2, 9, 2 ** 40 + 3, 256],
      ['glClear', 0x4100],
    ]));
    expect(got.map((c) => c.ctx)).toEqual([7, 7, 7, 7]);
    expect(got[0]).toEqual({ ctx: 7, name: 'glBitmap', args: [-3, 4, 1.5, -2.25, 0.5, 8, [1, 2, 3]] });
    expect(got[1].args[0]).toBe(0.123456789012);
    expect(got[2].args).toEqual([0x8a11, 2, 9, 2 ** 40 + 3, 256]);
    expect(got[3].args).toEqual([0x4100]);
  });

  it('decodes each array element type', () => {
    const got = decode(batch(1, [
      ['glColor4fv', new Float32Array([0.25, 0.5, 0.75, 1])],
      ['glColor3iv', new Int32Array([-1, 0, 2 ** 31 - 1])],
      ['glColor3uiv', new Uint32Array([0, 1, 2 ** 32 - 1])],
      ['glColor3sv', new Int16Array([-32768, 0, 32767])],
      ['glColor3usv', new Uint16Array([0, 1, 65535])],
      ['glColor3bv', new Int8Array([-128, 0, 127])],
      ['glClipPlane', 0x3000, new Float64Array([1, -2, 3.5, -4.25])],
      ['glMultiDrawElements', 4, new Int32Array([3, 6]), 0x1405, new BigInt64Array([0n, 12n]), 2],
    ]));
    expect(got.map((c) => c.args)).toEqual([
      [[0.25, 0.5, 0.75, 1]], [[-1, 0, 2 ** 31 - 1]], [[0, 1, 2 ** 32 - 1]], [[-32768, 0, 32767]], [[0, 1, 65535]], [[-128, 0, 127]],
      [0x3000, [1, -2, 3.5, -4.25]], [4, [3, 6], 0x1405, [0n, 12n], 2],
    ]);
  });

  it('pads odd-length arrays and keeps following arguments aligned', () => {
    const got = decode(batch(1, [['glBitmap', 1, 2, 3, 4, 5, 6, new Uint8Array([9, 9, 9, 9, 9])], ['glClear', 0x100]]));
    expect(got[0].args[6]).toEqual([9, 9, 9, 9, 9]);
    expect(got[1]).toMatchObject({ name: 'glClear', args: [0x100] });
  });

  it('decodes strings, NULL arrays and unpack-buffer offsets', () => {
    const got = decode(batch(2, [
      ['glBindAttribLocation', 3, 1, 'position'],
      ['glTexImage2D', 0x0de1, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401, null],
      ['glTexImage2D', 0x0de1, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401, new BufferOffset(4096)],
    ]));
    expect(got[0].args).toEqual([3, 1, 'position']);
    expect(got[1].args[8]).toBeNull();
    expect(got[2].args[8]).toBeInstanceOf(BufferOffset);
    expect((got[2].args[8] as BufferOffset).offset).toBe(4096);
  });

  it('accepts the two-word header for long commands', () => {
    const big = new Uint8Array(300_000).map((_, i) => i & 0xff);
    const cmd = command('glShaderSource', [5, big]);
    expect(new DataView(cmd.buffer).getUint32(0, true) >>> 16).toBe(0); // the long form
    const short = command('glClear', [1], true);
    const got = decode(batch(1, [cmd, short]));
    expect(got[0].name).toBe('glShaderSource');
    expect((got[0].args[1] as unknown as number[]).length).toBe(300_000);
    expect((got[0].args[1] as unknown as number[])[299_999]).toBe(299_999 & 0xff);
    expect(got[1]).toMatchObject({ name: 'glClear', args: [1] });
  });

  it('decodes several batches with different contexts in one buffer', () => {
    const got = decode(concat(batch(1, [['glClear', 1]]), batch(2, [['glClear', 2], ['glFlush']]), batch(1, [])));
    expect(got.map((c) => [c.ctx, c.name])).toEqual([[1, 'glClear'], [2, 'glClear'], [2, 'glFlush']]);
  });

  it('rejects broken streams', () => {
    const good = batch(1, [['glClear', 1]]);
    const bad = (mut: (dv: DataView, u8: Uint8Array) => void) => { const u8 = good.slice(); mut(new DataView(u8.buffer), u8); return () => decode(u8); };
    expect(bad((dv) => dv.setUint32(0, 0x12345678, true))).toThrow(/bad batch magic/);
    expect(bad((dv) => dv.setUint32(8, 4, true))).toThrow(/bad batch length/);
    expect(bad((dv) => dv.setUint32(8, 400, true))).toThrow(/bad batch length/);
    expect(bad((dv) => dv.setUint32(12, (0xfff0 | (2 << 16)) >>> 0, true))).toThrow(/unknown op/);
    expect(bad((dv) => dv.setUint32(12, (opOf('glClear') | (9 << 16)) >>> 0, true))).toThrow(/bad command length/);
    // an array whose length runs past its command
    const arr = batch(1, [['glColor4fv', new Float32Array(4)]]);
    new DataView(arr.buffer).setUint32(16, 1000, true);
    expect(() => decode(arr)).toThrow(/array past its command/);
    expect(new DataView(good.buffer).getUint32(0, true)).toBe(BATCH_MAGIC);
  });

  it('writes replies and messages', () => {
    const w = new ReplyWriter().u32(0xffffffff).i32(-2).f64(1.25).str('héllo');
    for (let i = 0; i < 100; i++) w.u32(i); // grows past 256 bytes
    const r = w.finish();
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    expect(dv.getUint32(0, true)).toBe(0xffffffff);
    expect(dv.getInt32(4, true)).toBe(-2);
    expect(dv.getFloat64(8, true)).toBe(1.25);
    expect(dv.getUint32(16, true)).toBe(6);
    expect(new TextDecoder().decode(r.subarray(20, 26))).toBe('héllo');
    expect(dv.getUint32(28, true)).toBe(0); // padded to 4
    expect(dv.getUint32(28 + 99 * 4, true)).toBe(99);
    const m = message(MSG_FRAME, new Uint8Array([1, 2, 3, 4]));
    expect(Array.from(m)).toEqual([2, 0, 0, 0, 4, 0, 0, 0, 1, 2, 3, 4]);
  });
});
