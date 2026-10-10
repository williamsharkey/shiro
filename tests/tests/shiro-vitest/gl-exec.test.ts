import { describe, it, expect } from 'vitest';
import { Executor, type Present } from '@shiro/gl/exec';
import { PROTOCOL, MSG_REPLY, MSG_FRAME, MSG_ERROR } from '@shiro/gl/wire';
import { mockWebGL2 } from './gl-mock';
import { batch, ab, messages } from './gl-encode';

/**
 * glshiro's executor (src/gl/exec.ts) on the recording WebGL2 stand-in:
 * contexts and drawables, immediate mode, display lists, shaders, replies,
 * frames. tests/browser/gl-exec.mjs runs the same streams on real WebGL2.
 */
const TRIANGLES = 4, COMPILE = 0x1300, COMPILE_AND_EXECUTE = 0x1301, VERTEX_SHADER = 0x8b31, FRAGMENT_SHADER = 0x8b30;
const WIN = 0x400001, FBCONFIG = 0x100;

function setup(size = { width: 64, height: 48 }) {
  const mock = mockWebGL2();
  const sent: Uint8Array[] = [];
  const frames: { xid: number; frame: Present }[] = [];
  const sizes = new Map([[WIN, size]]);
  const logs: string[] = [];
  const ex = new Executor(mock.gl, {
    send: (d) => sent.push(d.slice()),
    presentMode: 'pixels',
    drawableSize: (xid) => sizes.get(xid) ?? null,
    present: (xid, frame) => frames.push({ xid, frame }),
    log: (m) => logs.push(m),
  });
  const run = (ctx: number, cmds: Parameters<typeof batch>[1]) => expect(ex.run(ab(batch(ctx, cmds)))).toBe(true);
  const replies = () => messages(sent).filter((m) => m.kind === MSG_REPLY).map((m) => m.payload);
  const start = (core = false) => {
    run(0, [['tcCreateContext', 1, 0, core ? 3 : 2, core ? 3 : 1, core ? 1 : 0], ['tcMakeCurrent', 1, WIN, WIN, FBCONFIG]]);
  };
  return { ex, mock, sent, frames, sizes, logs, run, replies, start };
}

function readStrings(p: Uint8Array, n: number): string[] {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const out: string[] = [];
  let o = 0;
  for (let i = 0; i < n; i++) {
    const len = dv.getUint32(o, true);
    out.push(new TextDecoder().decode(p.subarray(o + 4, o + 4 + len)));
    o += 4 + ((len + 3) & ~3);
  }
  return out;
}

describe('GL executor', () => {
  it('answers hello with whether the protocol matches', () => {
    const t = setup();
    t.run(0, [['tcHello', PROTOCOL, 42, new TextEncoder().encode('glxgears')], ['tcHello', PROTOCOL ^ 1, 42, new Uint8Array(0)]]);
    expect(t.replies().map((p) => new DataView(p.buffer).getUint32(0, true))).toEqual([1, 0]);
  });

  it('makes a framebuffer the size of the window and sets the first viewport', () => {
    const t = setup();
    t.start();
    const storage = t.mock.calls.filter((c) => c.name === 'renderbufferStorage');
    expect(storage.map((c) => c.args.slice(2))).toEqual([[64, 48], [64, 48]]);
    expect(t.mock.calls.filter((c) => c.name === 'viewport').at(-1)?.args).toEqual([0, 0, 64, 48]);
  });

  it('reports the compatibility and core profiles in context info', () => {
    for (const core of [false, true]) {
      const t = setup();
      t.start(core);
      t.run(1, [['tcContextInfo']]);
      const [vendor, renderer, version, glsl, exts] = readStrings(t.replies()[0], 5);
      expect(vendor).toBe('tabcomputer');
      expect(renderer).toMatch(/^tabcomputer WebGL2/);
      expect(version).toBe(core ? '3.3 (Core Profile) tabcomputer' : '2.1 tabcomputer');
      expect(glsl).toBe(core ? '3.30 tabcomputer' : '1.20 tabcomputer');
      expect(exts.includes('GL_ARB_multitexture')).toBe(!core);
      expect(exts).toContain('GL_ARB_vertex_array_object');
    }
  });

  it('clears and presents a frame at swap, acking its number', () => {
    const t = setup();
    t.start();
    t.run(1, [['glClearColor', 1, 0, 0, 1], ['glClear', 0x4000], ['tcSwapBuffers', WIN, 7]]);
    expect(t.mock.calls.filter((c) => c.name === 'clearColor').at(-1)?.args).toEqual([1, 0, 0, 1]);
    expect(t.mock.count('clear')).toBeGreaterThan(0);
    expect(t.frames).toHaveLength(1);
    expect(t.frames[0]).toMatchObject({ xid: WIN, frame: { width: 64, height: 48 } });
    expect(t.frames[0].frame.pixels?.length).toBe(64 * 48 * 4);
    const acks = messages(t.sent).filter((m) => m.kind === MSG_FRAME);
    expect(acks.map((m) => new DataView(m.payload.buffer).getUint32(0, true))).toEqual([7]);
    expect(t.ex.frames).toBe(1);
  });

  it('follows the window size at swap', () => {
    const t = setup();
    t.start();
    t.sizes.set(WIN, { width: 100, height: 80 });
    t.run(1, [['tcSwapBuffers', WIN, 1], ['tcSwapBuffers', WIN, 2]]);
    expect(t.frames.map((f) => [f.frame.width, f.frame.height])).toEqual([[64, 48], [100, 80]]);
  });

  it('draws immediate mode through a generated fixed-function program', () => {
    const t = setup();
    t.start();
    t.run(1, [['glBegin', TRIANGLES], ['glColor3f', 1, 0, 0], ['glVertex2f', 0, 0], ['glVertex2f', 1, 0], ['glVertex2f', 0, 1], ['glEnd']]);
    expect(t.mock.count('drawArrays') + t.mock.count('drawElements')).toBe(1);
    const sources = t.mock.calls.filter((c) => c.name === 'shaderSource').map((c) => c.args[1] as string);
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const s of sources) expect(s.startsWith('#version 300 es')).toBe(true);
    // glEnd without glBegin is an error message, not a crash
    t.run(1, [['glEnd']]);
    const errs = messages(t.sent).filter((m) => m.kind === MSG_ERROR);
    expect(errs.map((m) => new DataView(m.payload.buffer).getUint32(4, true))).toEqual([0x502]); // INVALID_OPERATION
  });

  it('compiles display lists without drawing and replays them on glCallList', () => {
    const t = setup();
    t.start();
    const tri: Parameters<typeof batch>[1] = [['glBegin', TRIANGLES], ['glVertex3f', 0, 0, 0], ['glVertex3f', 1, 0, 0], ['glVertex3f', 0, 1, 0], ['glEnd']];
    t.run(1, [['glGenLists', 2, 10], ['glNewList', 10, COMPILE], ...tri, ['glEndList']]);
    const draws = () => t.mock.count('drawArrays') + t.mock.count('drawElements');
    expect(draws()).toBe(0);
    t.run(1, [['glCallList', 10], ['glCallList', 10]]);
    expect(draws()).toBe(2);
    // COMPILE_AND_EXECUTE draws while compiling; a list calling a list
    t.run(1, [['glNewList', 11, COMPILE_AND_EXECUTE], ['glCallList', 10], ['glEndList']]);
    expect(draws()).toBe(3);
    t.run(1, [['glCallList', 11]]);
    expect(draws()).toBe(4);
    t.run(1, [['glCallLists', 2, 0x1401 /* UNSIGNED_BYTE */, new Uint8Array([10, 11])]]);
    expect(draws()).toBe(6);
  });

  it('translates legacy GLSL at link and reports compile status', () => {
    const t = setup();
    t.start();
    const vs = 'attribute vec3 pos; varying vec4 c; void main() { c = gl_Color; gl_Position = gl_ModelViewProjectionMatrix * vec4(pos, 1.0); }';
    const fs = 'varying vec4 c; uniform sampler2D tex; void main() { gl_FragColor = c * texture2D(tex, vec2(0.5)); }';
    t.run(1, [
      ['glCreateShader', VERTEX_SHADER, 1], ['glShaderSource', 1, new TextEncoder().encode(vs)], ['glCompileShader', 1],
      ['glCreateShader', FRAGMENT_SHADER, 2], ['glShaderSource', 2, new TextEncoder().encode(fs)], ['glCompileShader', 2],
      ['glCreateShader', 0x8dd9 /* GEOMETRY_SHADER */, 3], ['glShaderSource', 3, new TextEncoder().encode('void main() {}')], ['glCompileShader', 3],
      ['glCreateProgram', 4], ['glAttachShader', 4, 1], ['glAttachShader', 4, 2], ['glBindAttribLocation', 4, 0, 'pos'], ['glLinkProgram', 4],
      ['glGetShaderInfo', 1], ['glGetShaderInfo', 3], ['glGetProgramInfo', 4], ['glUseProgram', 4],
    ]);
    const [vsInfo, gsInfo, progInfo] = t.replies();
    expect(new DataView(vsInfo.buffer).getUint32(0, true)).toBe(1);
    expect(new DataView(gsInfo.buffer).getUint32(0, true)).toBe(0);
    expect(readStrings(gsInfo.subarray(4), 1)[0]).toMatch(/geometry/);
    expect(new DataView(progInfo.buffer).getUint32(0, true)).toBe(1);
    const sources = t.mock.calls.filter((c) => c.name === 'shaderSource').map((c) => c.args[1] as string);
    const v = sources.find((s) => s.includes('pos'))!;
    expect(v).toMatch(/^#version 300 es/);
    expect(v).toContain('in vec3 pos;');
    expect(v).toContain('uniform mat4 _tc_ModelViewProjectionMatrix;');
    expect(v).not.toMatch(/\battribute\b|\bvarying\b|gl_Color/);
    const f = sources.find((s) => s.includes('_tc_FragColor'))!;
    expect(f).toContain('layout(location = 0) out vec4 _tc_FragColor;');
    expect(f).toContain('texture(tex');
    expect(t.mock.calls.find((c) => c.name === 'bindAttribLocation' && c.args[2] === 'pos')?.args[1]).toBe(0);
  });

  it('keeps contexts apart and shares objects between shared contexts', () => {
    const t = setup();
    t.run(0, [['tcCreateContext', 1, 0, 2, 1, 0], ['tcCreateContext', 2, 1, 2, 1, 0], ['tcCreateContext', 3, 0, 2, 1, 0], ['tcMakeCurrent', 1, WIN, WIN, FBCONFIG]]);
    t.run(1, [['glCreateShader', VERTEX_SHADER, 9], ['glShaderSource', 9, new TextEncoder().encode('void main() { gl_Position = vec4(0.0); }')], ['glCompileShader', 9]]);
    t.run(0, [['tcMakeCurrent', 2, WIN, WIN, FBCONFIG]]);
    t.run(2, [['glGetShaderInfo', 9]]);
    t.run(0, [['tcMakeCurrent', 3, WIN, WIN, FBCONFIG]]);
    t.run(3, [['glGetShaderInfo', 9]]);
    const [shared, other] = t.replies();
    expect(new DataView(shared.buffer).getUint32(0, true)).toBe(1);
    expect(new DataView(other.buffer).getUint32(0, true)).toBe(0);
    t.run(0, [['tcDestroyContext', 3], ['tcDestroyContext', 2], ['tcDestroyContext', 1]]);
  });

  it('replies to every reply-wanting command even when the handler fails', () => {
    const t = setup();
    // no current context: the handlers have nothing to work on, but the guest still waits
    t.run(0, [['glGetError'], ['glGetString', 0x1f00], ['glGetIntegerv', 0x0d33], ['glFinish']]);
    expect(t.replies()).toHaveLength(4);
  });

  it('returns false for a broken stream', () => {
    const t = setup();
    const b = batch(0, [['glFlush']]);
    new DataView(b.buffer).setUint32(0, 0, true);
    expect(t.ex.run(ab(b))).toBe(false);
    expect(t.logs.join('\n')).toMatch(/bad batch magic/);
  });
});

describe('frame pacing', () => {
  it('holds frame acks until the next animation frame and passes everything else at once', async () => {
    const { pacedSend } = await import('@shiro/gl/present');
    const out: number[] = [];
    const frames: (() => void)[] = [];
    const send = pacedSend((d) => out.push(new DataView(d.buffer, d.byteOffset).getUint32(0, true)), (cb) => frames.push(cb));
    const mock = mockWebGL2();
    const ex = new Executor(mock.gl, { send, presentMode: 'pixels', drawableSize: () => ({ width: 8, height: 8 }), present() {} });
    ex.run(ab(batch(0, [['tcCreateContext', 1, 0, 2, 1, 0], ['tcMakeCurrent', 1, WIN, WIN, FBCONFIG]])));
    ex.run(ab(batch(1, [['tcSwapBuffers', WIN, 1], ['glGetError'], ['tcSwapBuffers', WIN, 2]])));
    // the reply went out; the acks wait for one animation frame (a hidden tab never gives it)
    expect(out).toEqual([MSG_REPLY]);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(out).toEqual([MSG_REPLY, MSG_FRAME, MSG_FRAME]);
    ex.run(ab(batch(1, [['tcSwapBuffers', WIN, 3]])));
    expect(frames).toHaveLength(1);
    expect(out).toHaveLength(3);
  });
});
