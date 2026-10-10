/**
 * glshiro's executor: runs one guest process's GL command stream on a
 * WebGL2 context (docs/research/GL.md, "Page side").
 *
 * All GL contexts of the process live in one WebGL2 context: share groups are
 * name maps, and each GL context's state is shadowed here and re-applied
 * when another context becomes current. A GL window's default framebuffer
 * is a framebuffer object of the window's size; glXSwapBuffers hands its
 * pixels to the host (src/gl/server.ts), which shows them in the X window.
 *
 * Handlers are methods named after the GL function (aliases share the core
 * function's opcode). A handler for a command the guest waits on returns the
 * reply payload. Unknown commands are logged once and ignored.
 */
import * as E from './gen/enums';
import { OPS } from './gen/ops';
import { BufferOffset, decodeBatch, f64s, message, MSG_ERROR, MSG_FRAME, MSG_REPLY, PROTOCOL, ReplyWriter, u32s, type Arg } from './wire';
import { ATTR, enabledLights, FF_CLIP_PLANES, FF_LIGHTS, FF_TEXTURE_UNITS, ffKey, ffSource, FFState, type UnitInfo } from './ff';
import { frustum, identity, invert, mul, normalMatrix, ortho, rotation, scaling, transformVec4, translation, type Mat4 } from './mat';
import { convertForUpload, defaultPixelStore, packPixels, texFormat, tighten, type PixelStore, type TexFormat } from './formats';
import { translateShader, type Translated } from './glsl/translate';

type GL = WebGL2RenderingContext;

export interface Present {
  /** RGBA bytes, bottom row first (the readback path), or a bitmap (the fast path). */
  pixels?: Uint8Array;
  bitmap?: ImageBitmap;
  width: number;
  height: number;
}
export interface ExecHost {
  /** Bytes for the guest (replies, frame acks, errors). */
  send(data: Uint8Array): void;
  /** The X drawable's current size, or null when it doesn't exist (anymore). */
  drawableSize(xid: number): { width: number; height: number } | null;
  /** A finished frame for an X drawable. */
  present(xid: number, frame: Present): void;
  /** How the host wants frames: pixels (readback) or bitmap (OffscreenCanvas). */
  presentMode: 'pixels' | 'bitmap';
  log?(msg: string): void;
}

interface Tex {
  tex: WebGLTexture; target: number; webglTarget: number;
  levels: { w: number; h: number; d: number; fmt: TexFormat; internal: number }[];
  immutable: boolean;
  params: Map<number, number | Float32Array>;
}
interface Buf { buf: WebGLBuffer; size: number; usage: number; target: number }
interface ShaderObj { kind: 'shader'; type: number; sh: WebGLShader | null; source: string; translated: Translated | null; compiled: boolean; log: string }
interface Loc { wl: WebGLUniformLocation; type: number }
interface Var { name: string; type: number; size: number; loc: number }
interface ProgObj {
  kind: 'program'; prog: WebGLProgram; shaders: Set<number>;
  linked: boolean; linkLog: string; infoReady: boolean;
  attribs: Var[]; uniforms: Var[]; blocks: Var[];
  locs: (Loc | null)[];
  bindings: Map<string, number>; fragData: Map<string, number>;
  tfVaryings: string[]; tfMode: number;
  /** compatibility built-ins the program's shaders use: name → location */
  builtins: Map<string, WebGLUniformLocation>;
  builtinAttribs: Map<string, number>;
}
interface List { cmds: { op: number; args: Arg[] }[] }
interface Share {
  textures: Map<number, Tex>; buffers: Map<number, Buf>; renderbuffers: Map<number, WebGLRenderbuffer>;
  objects: Map<number, ShaderObj | ProgObj>; lists: Map<number, List>; samplers: Map<number, WebGLSampler>;
  refs: number;
}
interface Drawable {
  xid: number; width: number; height: number; samples: number; depth: boolean; stencil: boolean;
  fbo: WebGLFramebuffer; color: WebGLRenderbuffer; ds: WebGLRenderbuffer | null;
  resolveFbo: WebGLFramebuffer | null; resolveColor: WebGLRenderbuffer | null;
}
interface FBConfig { depth: boolean; stencil: boolean; samples: number; alpha: boolean; doublebuffer: boolean }

interface ClientArray { enabled: boolean; size: number; type: number; normalized: boolean; stride: number; offset: number; buffer: number; integer: boolean; divisor: number }
interface Vao { vao: WebGLVertexArrayObject | null; element: number; attribs: ClientArray[] }

const newArray = (): ClientArray => ({ enabled: false, size: 4, type: E.FLOAT, normalized: false, stride: 0, offset: 0, buffer: 0, integer: false, divisor: 0 });

/** WebGL2 capabilities glEnable passes straight through. */
const WEBGL_CAPS = new Set([E.BLEND, E.CULL_FACE, E.DEPTH_TEST, E.DITHER, E.POLYGON_OFFSET_FILL, E.SAMPLE_ALPHA_TO_COVERAGE,
  E.SAMPLE_COVERAGE, E.SCISSOR_TEST, E.STENCIL_TEST, E.RASTERIZER_DISCARD]);
/** Commands that run at once even while a display list is being compiled (GL 2.1 §5.4). */
const NOT_IN_LISTS = new Set(['glNewList', 'glEndList', 'glGenLists', 'glDeleteLists', 'glFeedbackBuffer', 'glSelectBuffer', 'glRenderMode',
  'glClientActiveTexture', 'glColorPointer', 'glEdgeFlagPointer', 'glFogCoordPointer', 'glIndexPointer', 'glInterleavedArrays',
  'glNormalPointer', 'glSecondaryColorPointer', 'glTexCoordPointer', 'glVertexAttribPointer', 'glVertexPointer', 'glVertexAttribIPointer',
  'glEnableClientState', 'glDisableClientState', 'glEnableVertexAttribArray', 'glDisableVertexAttribArray', 'glPixelStorei', 'glPixelStoref',
  'glReadPixels', 'glGenTextures', 'glDeleteTextures', 'glAreTexturesResident', 'glIsTexture', 'glFinish', 'glFlush', 'glIsList',
  'glGenBuffers', 'glDeleteBuffers', 'glBindBuffer', 'glBufferData', 'glBufferSubData', 'glMapBuffer', 'glUnmapBuffer',
  'glCreateShader', 'glCreateProgram', 'glShaderSource', 'glCompileShader', 'glLinkProgram', 'glDeleteShader', 'glDeleteProgram',
  'glAttachShader', 'glDetachShader', 'glGenFramebuffers', 'glGenRenderbuffers', 'glGenQueries', 'glGenVertexArrays', 'glBindVertexArray',
  'glFenceSync', 'glDeleteSync', 'glGetError', 'glGetString', 'glGetStringi', 'glGetProgramInfo', 'glGetShaderInfo', 'glClientUploadArray']);

class Ctx {
  ff = new FFState();
  caps = new Set<number>([E.DITHER, E.MULTISAMPLE]);
  viewport = [0, 0, 0, 0];
  scissor = [0, 0, 0, 0];
  clearColor = [0, 0, 0, 0];
  clearDepth = 1;
  clearStencil = 0;
  colorMask = [true, true, true, true];
  depthMask = true;
  depthFunc = E.LESS;
  depthRange = [0, 1];
  blend = { srcRGB: E.ONE, dstRGB: E.ZERO, srcA: E.ONE, dstA: E.ZERO, eqRGB: E.FUNC_ADD, eqA: E.FUNC_ADD, color: [0, 0, 0, 0] };
  cullFace = E.BACK;
  frontFace = E.CCW;
  polygonOffset = [0, 0];
  polygonMode = [E.FILL, E.FILL];
  stencil = {
    front: { func: E.ALWAYS, ref: 0, mask: 0xffffffff, fail: E.KEEP, zfail: E.KEEP, zpass: E.KEEP, writemask: 0xffffffff },
    back: { func: E.ALWAYS, ref: 0, mask: 0xffffffff, fail: E.KEEP, zfail: E.KEEP, zpass: E.KEEP, writemask: 0xffffffff },
  };
  lineWidth = 1;
  sampleCoverage = [1, false] as [number, boolean];
  activeUnit = 0;
  textures: Map<number, number>[] = Array.from({ length: 32 }, () => new Map());
  samplers: number[] = new Array(32).fill(0);
  arrayBuffer = 0;
  copyRead = 0; copyWrite = 0; pixelPack = 0; pixelUnpack = 0; uniformBuffer = 0; tfBuffer = 0; textureBuffer = 0;
  uniformBindings: [number, number, number][] = []; // buffer, offset, size per index
  tfBindings: [number, number, number][] = [];
  program = 0;
  vaos = new Map<number, Vao>();
  vao!: Vao;
  framebuffers = new Map<number, WebGLFramebuffer>();
  drawFb = 0; readFb = 0;
  drawBuffers: number[] = [E.BACK];
  readBuffer = E.BACK;
  pack: PixelStore = defaultPixelStore();
  unpack: PixelStore = defaultPixelStore();
  queries = new Map<number, { q: WebGLQuery | null; target: number; result?: number }>();
  activeQueries = new Map<number, number>();
  primitiveRestart = false; restartIndex = 0;
  generic: Float32Array[] = Array.from({ length: 16 }, () => new Float32Array([0, 0, 0, 1]));
  hints = new Map<number, number>();
  attribStack: unknown[] = [];
  clientAttribStack: unknown[] = [];
  draw: Drawable | null = null;
  read: Drawable | null = null;
  initialized = false;
  // display lists
  listCompiling = 0;
  listMode = 0;
  listCmds: { op: number; args: Arg[] }[] = [];
  listBase = 0;
  // immediate mode
  begin: number | null = null;
  imm: number[] = [];
  immCount = 0;
  ffPrograms = new Map<string, FFProgram>();

  constructor(readonly id: number, readonly share: Share, readonly major: number, readonly minor: number, readonly core: boolean, readonly gl: GL) {
    const def: Vao = { vao: null, element: 0, attribs: Array.from({ length: 16 }, newArray) };
    this.vaos.set(0, def);
    this.vao = def;
  }
}

interface FFProgram { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null>; lights: number[] }

/** Floats per immediate-mode vertex: position 4, normal 3, color 4, secondary 4, fog 1, 4 texture coordinates of 4. */
const IMM_STRIDE = 4 + 3 + 4 + 4 + 1 + 4 * FF_TEXTURE_UNITS;
const IMM_OFF = { pos: 0, normal: 4, color: 7, secondary: 11, fog: 15, tc: 16 };

export class Executor {
  private contexts = new Map<number, Ctx>();
  private drawables = new Map<number, Drawable>();
  private configs = new Map<number, FBConfig>();
  private cur: Ctx | null = null;
  private handlers: (((args: Arg[]) => Uint8Array | void) | null)[] = [];
  private warned = new Set<string>();
  private immBuffer: WebGLBuffer;
  private immIndex: WebGLBuffer;
  private immVao: WebGLVertexArrayObject;
  private blitFbo: WebGLFramebuffer;
  readonly ext: Record<string, unknown> = {};
  frames = 0;
  /** commands executed (for tests and stats) */
  executed = 0;

  constructor(readonly gl: GL, readonly host: ExecHost) {
    this.immBuffer = gl.createBuffer()!;
    this.immIndex = gl.createBuffer()!;
    this.immVao = gl.createVertexArray()!;
    this.blitFbo = gl.createFramebuffer()!;
    for (const n of ['EXT_color_buffer_float', 'EXT_texture_filter_anisotropic', 'WEBGL_compressed_texture_s3tc', 'EXT_disjoint_timer_query_webgl2',
      'OES_texture_float_linear', 'EXT_color_buffer_half_float', 'WEBGL_debug_renderer_info', 'EXT_depth_clamp', 'WEBGL_clip_cull_distance',
      'EXT_texture_norm16', 'WEBGL_blend_func_extended', 'WEBGL_compressed_texture_s3tc_srgb', 'EXT_texture_compression_rgtc', 'EXT_texture_compression_bptc']) {
      const e = gl.getExtension(n);
      if (e) this.ext[n] = e;
    }
    // uploads are repacked here, so WebGL's own unpack state stays at tight defaults
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    for (let op = 1; op < OPS.length; op++) {
      const name = OPS[op][0];
      const fn = (this as unknown as Record<string, unknown>)[name];
      this.handlers[op] = typeof fn === 'function' ? (args) => (fn as (...a: Arg[]) => Uint8Array | void).apply(this, args) : this.variant(name);
    }
  }

  private log(msg: string) { this.host.log?.(msg); }
  private warnOnce(what: string) {
    if (this.warned.has(what)) return;
    this.warned.add(what);
    this.log(`glshiro: ${what}`);
  }

  // ── stream ──

  /** Runs a batch from the guest; returns false if the stream is broken. */
  run(buf: ArrayBuffer): boolean {
    try {
      decodeBatch(buf, (ctxId, op, args) => this.dispatch(ctxId, op, args));
      return true;
    } catch (e) {
      this.log(`glshiro: ${(e as Error).message}`);
      return false;
    }
  }

  private dispatch(ctxId: number, op: number, args: Arg[]) {
    const name = OPS[op][0];
    const replies = OPS[op][1].endsWith('>');
    if (ctxId && (!this.cur || this.cur.id !== ctxId) && !name.startsWith('tc')) {
      const c = this.contexts.get(ctxId);
      if (c) this.switchTo(c);
    }
    const c = this.cur;
    if (c && c.listCompiling && !name.startsWith('tc') && !NOT_IN_LISTS.has(name) && !replies) {
      c.listCmds.push({ op, args: args.map(copyArg) });
      if (c.listMode === E.COMPILE) return;
    }
    this.executed++;
    let out: Uint8Array | void;
    try {
      const h = this.handlers[op];
      out = h ? h(args) : undefined;
    } catch (e) {
      this.log(`glshiro: ${name}: ${(e as Error).stack ?? e}`);
      out = undefined;
    }
    if (replies) this.host.send(message(MSG_REPLY, out ?? new Uint8Array(0)));
  }

  private error(code: number) {
    const c = this.cur;
    if (!c) return;
    this.host.send(message(MSG_ERROR, u32s(c.id, code)));
  }

  /** Handlers for the many typed variants (glVertex3fv, glColor4ub, glUniform2iv, ...). */
  private variant(name: string): ((args: Arg[]) => void) | null {
    const m = name.match(/^gl(Vertex|Normal|Color|SecondaryColor|TexCoord|MultiTexCoord|FogCoord|VertexAttribI|VertexAttrib|RasterPos|WindowPos|Rect|EvalCoord)(\d)?(N)?(b|s|i|f|d|ub|us|ui|x|h)(v)?(ARB|EXT|NV)?$/);
    if (m) {
      const [, kind, nStr, norm, type, vec] = m;
      const n = nStr ? +nStr : 1;
      const conv = (v: number) => (kind === 'Color' || kind === 'SecondaryColor' || norm) ? normalize(type, v) : kind === 'Normal' ? normalize(type, v) : v;
      return (args) => {
        let lead: number[] = [];
        let vals: number[];
        if (kind === 'MultiTexCoord' || kind === 'VertexAttrib' || kind === 'VertexAttribI') { lead = [args[0] as number]; args = args.slice(1); }
        if (kind === 'Rect') {
          const a = vec ? [...Array.from(args[0] as unknown as ArrayLike<number>), ...Array.from(args[1] as unknown as ArrayLike<number>)] : (args as number[]);
          this.rect(a[0], a[1], a[2], a[3]);
          return;
        }
        if (vec) vals = Array.from((args[0] as unknown as ArrayLike<number>) ?? []).slice(0, n).map(Number);
        else vals = (args as number[]).slice(0, n);
        vals = vals.map(conv);
        this.attrib(kind, lead[0] ?? 0, vals, n, kind === 'VertexAttribI');
      };
    }
    const u = name.match(/^glUniform(Matrix)?(\d)(x\d)?(f|i|ui|d)(v)?(ARB)?$/);
    if (u) {
      const [, matrix, nStr, mx, type, vec] = u;
      return (args) => this.uniform(args, !!matrix, +nStr, mx ? +mx.slice(1) : 0, type, !!vec);
    }
    const pu = name.match(/^glProgramUniform(Matrix)?(\d)(x\d)?(f|i|ui|d)(v)?(EXT)?$/);
    if (pu) {
      const [, matrix, nStr, mx, type, vec] = pu;
      return (args) => {
        const prog = args[0] as number;
        const saved = this.cur?.program ?? 0;
        if (!this.cur) return;
        this.useProgramInternal(prog);
        this.uniform(args.slice(1), !!matrix, +nStr, mx ? +mx.slice(1) : 0, type, !!vec);
        this.useProgramInternal(saved);
      };
    }
    return null;
  }

  // ── contexts and drawables (tc*) ──

  tcHello(protocol: number, _pid: number, _name: ArrayBufferView): Uint8Array {
    return u32s(protocol === PROTOCOL ? 1 : 0);
  }
  tcCreateContext(id: number, shareId: number, major: number, minor: number, flags: number) {
    const shareWith = shareId ? this.contexts.get(shareId) : undefined;
    const share: Share = shareWith?.share ?? {
      textures: new Map(), buffers: new Map(), renderbuffers: new Map(), objects: new Map(), lists: new Map(), samplers: new Map(), refs: 0,
    };
    share.refs++;
    const core = (flags & 0xff & 1) !== 0 && major * 10 + minor >= 32;
    this.contexts.set(id, new Ctx(id, share, major, minor, core, this.gl));
  }
  tcDestroyContext(id: number) {
    const c = this.contexts.get(id);
    if (!c) return;
    this.contexts.delete(id);
    if (this.cur === c) this.cur = null;
    const gl = this.gl;
    for (const v of c.vaos.values()) if (v.vao) gl.deleteVertexArray(v.vao);
    for (const f of c.framebuffers.values()) gl.deleteFramebuffer(f);
    for (const p of c.ffPrograms.values()) gl.deleteProgram(p.prog);
    if (--c.share.refs === 0) {
      for (const t of c.share.textures.values()) gl.deleteTexture(t.tex);
      for (const b of c.share.buffers.values()) gl.deleteBuffer(b.buf);
      for (const r of c.share.renderbuffers.values()) gl.deleteRenderbuffer(r);
      for (const o of c.share.objects.values()) o.kind === 'shader' ? gl.deleteShader(o.sh) : gl.deleteProgram(o.prog);
      for (const s of c.share.samplers.values()) gl.deleteSampler(s);
    }
  }
  /** fbconfig ids are per display in the guest; the page only needs what they mean */
  private configOf(id: number): FBConfig {
    // ids from libGLX_tabcomputer's variant table: 0x100 + 5 × visual + variant
    const v = (id - 0x100) % 5;
    const variants: FBConfig[] = [
      { doublebuffer: true, depth: true, stencil: true, samples: 0, alpha: false },
      { doublebuffer: true, depth: true, stencil: true, samples: 4, alpha: false },
      { doublebuffer: false, depth: true, stencil: true, samples: 0, alpha: false },
      { doublebuffer: true, depth: false, stencil: false, samples: 0, alpha: false },
      { doublebuffer: true, depth: true, stencil: false, samples: 0, alpha: false },
    ];
    return this.configs.get(id) ?? variants[v >= 0 ? v : 0];
  }
  tcMakeCurrent(id: number, draw: number, read: number, fbconfig: number) {
    const c = this.contexts.get(id);
    if (!c) return;
    const cfg = this.configOf(fbconfig);
    c.draw = draw ? this.drawable(draw, cfg) : null;
    c.read = read === draw ? c.draw : read ? this.drawable(read, cfg) : null;
    this.switchTo(c, true);
    if (!c.initialized && c.draw) {
      c.initialized = true;
      c.viewport = [0, 0, c.draw.width, c.draw.height];
      c.scissor = [0, 0, c.draw.width, c.draw.height];
      this.gl.viewport(0, 0, c.draw.width, c.draw.height);
      this.gl.scissor(0, 0, c.draw.width, c.draw.height);
    }
  }
  tcDrawableGone(xid: number) {
    const d = this.drawables.get(xid);
    if (!d) return;
    this.freeDrawable(d);
    this.drawables.delete(xid);
  }

  private drawable(xid: number, cfg: FBConfig): Drawable {
    let d = this.drawables.get(xid);
    const size = this.host.drawableSize(xid) ?? { width: d?.width ?? 300, height: d?.height ?? 300 };
    if (d && d.width === size.width && d.height === size.height) return d;
    if (d) this.freeDrawable(d);
    d = this.makeDrawable(xid, Math.max(1, size.width), Math.max(1, size.height), cfg);
    this.drawables.set(xid, d);
    return d;
  }
  private makeDrawable(xid: number, width: number, height: number, cfg: FBConfig): Drawable {
    const gl = this.gl;
    const samples = cfg.samples ? Math.min(cfg.samples, gl.getParameter(gl.MAX_SAMPLES) as number) : 0;
    const fbo = gl.createFramebuffer()!;
    const color = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    else gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    let ds: WebGLRenderbuffer | null = null;
    // depth and stencil always exist: apps assume them more often than they ask
    ds = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, ds);
    if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, width, height);
    else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, ds);
    let resolveFbo: WebGLFramebuffer | null = null, resolveColor: WebGLRenderbuffer | null = null;
    if (samples) {
      resolveFbo = gl.createFramebuffer()!;
      resolveColor = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, resolveColor);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolveFbo);
      gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, resolveColor);
    }
    // a new window starts black, as X would show it
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
    this.withClearState(() => { gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.clearStencil(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT); });
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    return { xid, width, height, samples, depth: cfg.depth, stencil: cfg.stencil, fbo, color, ds, resolveFbo, resolveColor };
  }
  private freeDrawable(d: Drawable) {
    const gl = this.gl;
    gl.deleteFramebuffer(d.fbo); gl.deleteRenderbuffer(d.color);
    if (d.ds) gl.deleteRenderbuffer(d.ds);
    if (d.resolveFbo) gl.deleteFramebuffer(d.resolveFbo);
    if (d.resolveColor) gl.deleteRenderbuffer(d.resolveColor);
    for (const c of this.contexts.values()) {
      if (c.draw === d) c.draw = null;
      if (c.read === d) c.read = null;
    }
  }
  /** Runs `f` with the clear-affecting state at GL defaults, then restores the current context's. */
  private withClearState(f: () => void) {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xffffffff);
    f();
    const c = this.cur;
    if (c) {
      if (c.caps.has(E.SCISSOR_TEST)) gl.enable(gl.SCISSOR_TEST);
      gl.colorMask(c.colorMask[0], c.colorMask[1], c.colorMask[2], c.colorMask[3]);
      gl.depthMask(c.depthMask);
      gl.stencilMaskSeparate(gl.FRONT, c.stencil.front.writemask);
      gl.stencilMaskSeparate(gl.BACK, c.stencil.back.writemask);
      gl.clearColor(c.clearColor[0], c.clearColor[1], c.clearColor[2], c.clearColor[3]);
      gl.clearDepth(c.clearDepth);
      gl.clearStencil(c.clearStencil);
    }
  }

  /** Makes `c` current, re-applying its whole state to WebGL when it wasn't. */
  private switchTo(c: Ctx, force = false) {
    if (this.cur === c && !force) return;
    this.cur = c;
    this.applyAll(c);
  }

  private applyAll(c: Ctx) {
    const gl = this.gl;
    for (const cap of WEBGL_CAPS) (c.caps.has(cap) ? gl.enable(cap) : gl.disable(cap));
    gl.viewport(c.viewport[0], c.viewport[1], c.viewport[2], c.viewport[3]);
    gl.scissor(c.scissor[0], c.scissor[1], c.scissor[2], c.scissor[3]);
    gl.clearColor(c.clearColor[0], c.clearColor[1], c.clearColor[2], c.clearColor[3]);
    gl.clearDepth(c.clearDepth);
    gl.clearStencil(c.clearStencil);
    gl.colorMask(c.colorMask[0], c.colorMask[1], c.colorMask[2], c.colorMask[3]);
    gl.depthMask(c.depthMask);
    gl.depthFunc(c.depthFunc);
    gl.depthRange(c.depthRange[0], c.depthRange[1]);
    const b = c.blend;
    gl.blendFuncSeparate(b.srcRGB, b.dstRGB, b.srcA, b.dstA);
    gl.blendEquationSeparate(b.eqRGB, b.eqA);
    gl.blendColor(b.color[0], b.color[1], b.color[2], b.color[3]);
    gl.cullFace(c.cullFace);
    gl.frontFace(c.frontFace);
    gl.polygonOffset(c.polygonOffset[0], c.polygonOffset[1]);
    for (const [face, s] of [[gl.FRONT, c.stencil.front], [gl.BACK, c.stencil.back]] as const) {
      gl.stencilFuncSeparate(face, s.func, s.ref, s.mask);
      gl.stencilOpSeparate(face, s.fail, s.zfail, s.zpass);
      gl.stencilMaskSeparate(face, s.writemask);
    }
    gl.sampleCoverage(c.sampleCoverage[0], c.sampleCoverage[1]);
    for (let u = 0; u < c.textures.length; u++) {
      if (!c.textures[u].size && !c.samplers[u]) continue;
      gl.activeTexture(gl.TEXTURE0 + u);
      for (const [target, name] of c.textures[u]) {
        const t = c.share.textures.get(name);
        gl.bindTexture(webglTarget(target), t?.tex ?? null);
      }
      gl.bindSampler(u, c.share.samplers.get(c.samplers[u]) ?? null);
    }
    gl.activeTexture(gl.TEXTURE0 + c.activeUnit);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufObj(c.arrayBuffer));
    gl.bindBuffer(gl.COPY_READ_BUFFER, this.bufObj(c.copyRead));
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.bufObj(c.copyWrite));
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.bufObj(c.pixelPack));
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, this.bufObj(c.pixelUnpack));
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.bufObj(c.uniformBuffer));
    c.uniformBindings.forEach((ub, i) => { if (ub) gl.bindBufferRange(gl.UNIFORM_BUFFER, i, this.bufObj(ub[0]), ub[1], ub[2] || this.bufSize(ub[0])); });
    gl.bindVertexArray(c.vao.vao);
    this.useProgramInternal(c.program);
    this.bindDrawFb(c);
    this.bindReadFb(c);
    for (let i = 0; i < 16; i++) gl.vertexAttrib4fv(i, c.generic[i]);
  }

  private bufObj(name: number): WebGLBuffer | null {
    return name ? this.cur?.share.buffers.get(name)?.buf ?? null : null;
  }
  private bufSize(name: number): number { return this.cur?.share.buffers.get(name)?.size ?? 0; }

  private bindDrawFb(c: Ctx) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, c.drawFb ? c.framebuffers.get(c.drawFb) ?? null : c.draw?.fbo ?? null);
    if (!c.drawFb && c.draw) gl.drawBuffers([c.drawBuffers[0] === E.NONE ? gl.NONE : gl.COLOR_ATTACHMENT0]);
  }
  private bindReadFb(c: Ctx) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, c.readFb ? c.framebuffers.get(c.readFb) ?? null : c.read?.fbo ?? null);
  }

  tcContextInfo(): Uint8Array {
    const c = this.cur!;
    const gl = this.gl;
    const w = new ReplyWriter();
    const dbg = this.ext.WEBGL_debug_renderer_info as { UNMASKED_RENDERER_WEBGL: number } | undefined;
    const native = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    const version = c.core ? `${c.major}.${c.minor} (Core Profile) tabcomputer` : '2.1 tabcomputer';
    const glsl = c.core ? '3.30 tabcomputer' : '1.20 tabcomputer';
    w.str('tabcomputer');
    w.str(`tabcomputer WebGL2 (${native})`);
    w.str(version);
    w.str(glsl);
    w.str(this.extensions(c).join(' '));
    const limits: [number, number[]][] = [];
    const p = (pname: number) => gl.getParameter(pname);
    const num = (v: unknown): number[] => (v == null ? [0] : typeof v === 'number' ? [v] : typeof v === 'boolean' ? [v ? 1 : 0] : Array.from(v as ArrayLike<number>));
    const maxTex = p(gl.MAX_TEXTURE_SIZE) as number;
    const maxUnits = p(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
    const cfg = c.draw;
    limits.push(
      [E.MAX_TEXTURE_SIZE, [maxTex]], [E.MAX_3D_TEXTURE_SIZE, num(p(gl.MAX_3D_TEXTURE_SIZE))], [E.MAX_CUBE_MAP_TEXTURE_SIZE, num(p(gl.MAX_CUBE_MAP_TEXTURE_SIZE))],
      [E.MAX_ARRAY_TEXTURE_LAYERS, num(p(gl.MAX_ARRAY_TEXTURE_LAYERS))], [E.MAX_RENDERBUFFER_SIZE, num(p(gl.MAX_RENDERBUFFER_SIZE))],
      [E.MAX_VIEWPORT_DIMS, num(p(gl.MAX_VIEWPORT_DIMS))], [E.MAX_TEXTURE_IMAGE_UNITS, num(p(gl.MAX_TEXTURE_IMAGE_UNITS))],
      [E.MAX_COMBINED_TEXTURE_IMAGE_UNITS, [maxUnits]], [E.MAX_VERTEX_TEXTURE_IMAGE_UNITS, num(p(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS))],
      [E.MAX_VERTEX_ATTRIBS, num(p(gl.MAX_VERTEX_ATTRIBS))], [E.MAX_DRAW_BUFFERS, num(p(gl.MAX_DRAW_BUFFERS))],
      [E.MAX_COLOR_ATTACHMENTS, num(p(gl.MAX_COLOR_ATTACHMENTS))], [E.MAX_SAMPLES, num(p(gl.MAX_SAMPLES))],
      [E.MAX_ELEMENTS_VERTICES, num(p(gl.MAX_ELEMENTS_VERTICES))], [E.MAX_ELEMENTS_INDICES, num(p(gl.MAX_ELEMENTS_INDICES))],
      [E.MAX_VERTEX_UNIFORM_COMPONENTS, num(p(gl.MAX_VERTEX_UNIFORM_COMPONENTS))], [E.MAX_FRAGMENT_UNIFORM_COMPONENTS, num(p(gl.MAX_FRAGMENT_UNIFORM_COMPONENTS))],
      [E.MAX_VERTEX_UNIFORM_BLOCKS, num(p(gl.MAX_VERTEX_UNIFORM_BLOCKS))], [E.MAX_FRAGMENT_UNIFORM_BLOCKS, num(p(gl.MAX_FRAGMENT_UNIFORM_BLOCKS))],
      [E.MAX_COMBINED_UNIFORM_BLOCKS, num(p(gl.MAX_COMBINED_UNIFORM_BLOCKS))], [E.MAX_UNIFORM_BUFFER_BINDINGS, num(p(gl.MAX_UNIFORM_BUFFER_BINDINGS))],
      [E.MAX_UNIFORM_BLOCK_SIZE, num(p(gl.MAX_UNIFORM_BLOCK_SIZE))], [E.UNIFORM_BUFFER_OFFSET_ALIGNMENT, num(p(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT))],
      [E.MAX_VARYING_COMPONENTS, num(p(gl.MAX_VARYING_COMPONENTS))], [E.MAX_VARYING_FLOATS, num(p(gl.MAX_VARYING_COMPONENTS))],
      [E.MAX_VERTEX_OUTPUT_COMPONENTS, num(p(gl.MAX_VERTEX_OUTPUT_COMPONENTS))], [E.MAX_FRAGMENT_INPUT_COMPONENTS, num(p(gl.MAX_FRAGMENT_INPUT_COMPONENTS))],
      [E.MAX_TEXTURE_LOD_BIAS, num(p(gl.MAX_TEXTURE_LOD_BIAS))], [E.ALIASED_LINE_WIDTH_RANGE, num(p(gl.ALIASED_LINE_WIDTH_RANGE))],
      [E.ALIASED_POINT_SIZE_RANGE, num(p(gl.ALIASED_POINT_SIZE_RANGE))], [E.SMOOTH_LINE_WIDTH_RANGE, num(p(gl.ALIASED_LINE_WIDTH_RANGE))],
      [E.SMOOTH_POINT_SIZE_RANGE, num(p(gl.ALIASED_POINT_SIZE_RANGE))], [E.LINE_WIDTH_GRANULARITY, [0.125]], [E.POINT_SIZE_GRANULARITY, [0.125]],
      [E.SUBPIXEL_BITS, num(p(gl.SUBPIXEL_BITS))], [E.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS, num(p(gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS))],
      [E.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS, num(p(gl.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS))],
      [E.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS, num(p(gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS))],
      [E.MAX_PROGRAM_TEXEL_OFFSET, num(p(gl.MAX_PROGRAM_TEXEL_OFFSET))], [E.MIN_PROGRAM_TEXEL_OFFSET, num(p(gl.MIN_PROGRAM_TEXEL_OFFSET))],
      [E.MAX_SERVER_WAIT_TIMEOUT, [0]], [E.MAX_TEXTURE_BUFFER_SIZE, [65536]], [E.MAX_RECTANGLE_TEXTURE_SIZE, [maxTex]],
      [E.MAX_GEOMETRY_OUTPUT_VERTICES, [0]], [E.MAX_CLIP_DISTANCES, [FF_CLIP_PLANES]],
      [E.MAJOR_VERSION, [c.core ? c.major : 2]], [E.MINOR_VERSION, [c.core ? c.minor : 1]], [E.NUM_EXTENSIONS, [this.extensions(c).length]],
      [E.CONTEXT_PROFILE_MASK, [c.core ? 1 : 2]], [E.CONTEXT_FLAGS, [0]],
      [E.NUM_COMPRESSED_TEXTURE_FORMATS, [0]], [E.NUM_SHADING_LANGUAGE_VERSIONS, [1]], [E.NUM_PROGRAM_BINARY_FORMATS, [0]],
      [E.DOUBLEBUFFER, [1]], [E.STEREO, [0]], [E.SAMPLE_BUFFERS, [cfg?.samples ? 1 : 0]], [E.SAMPLES, [cfg?.samples ?? 0]],
    );
    if (!c.core) {
      limits.push(
        [E.MAX_LIGHTS, [FF_LIGHTS]], [E.MAX_CLIP_PLANES, [FF_CLIP_PLANES]], [E.MAX_TEXTURE_UNITS, [FF_TEXTURE_UNITS]], [E.MAX_TEXTURE_COORDS, [FF_TEXTURE_UNITS]],
        [E.MAX_MODELVIEW_STACK_DEPTH, [32]], [E.MAX_PROJECTION_STACK_DEPTH, [4]], [E.MAX_TEXTURE_STACK_DEPTH, [10]],
        [E.MAX_ATTRIB_STACK_DEPTH, [16]], [E.MAX_CLIENT_ATTRIB_STACK_DEPTH, [16]], [E.MAX_LIST_NESTING, [64]], [E.MAX_EVAL_ORDER, [8]],
        [E.MAX_NAME_STACK_DEPTH, [64]], [E.MAX_PIXEL_MAP_TABLE, [256]], [E.AUX_BUFFERS, [0]],
        [E.RED_BITS, [8]], [E.GREEN_BITS, [8]], [E.BLUE_BITS, [8]], [E.ALPHA_BITS, [8]], [E.DEPTH_BITS, [24]], [E.STENCIL_BITS, [8]],
        [E.INDEX_BITS, [0]], [E.ACCUM_RED_BITS, [0]], [E.ACCUM_GREEN_BITS, [0]], [E.ACCUM_BLUE_BITS, [0]], [E.ACCUM_ALPHA_BITS, [0]],
        [E.RGBA_MODE, [1]], [E.INDEX_MODE, [0]], [E.POINT_SIZE_RANGE, num(p(gl.ALIASED_POINT_SIZE_RANGE))], [E.LINE_WIDTH_RANGE, num(p(gl.ALIASED_LINE_WIDTH_RANGE))],
      );
    }
    if (this.ext.EXT_texture_filter_anisotropic) limits.push([E.MAX_TEXTURE_MAX_ANISOTROPY, num(p(0x84ff))]);
    w.u32(limits.length);
    for (const [pname, vals] of limits) { w.u32(pname).u32(vals.length); for (const v of vals) w.f64(v); }
    return w.finish();
  }

  private extensions(c: Ctx): string[] {
    const x = ['GL_ARB_vertex_buffer_object', 'GL_ARB_vertex_array_object', 'GL_ARB_framebuffer_object', 'GL_EXT_framebuffer_object',
      'GL_EXT_framebuffer_blit', 'GL_EXT_framebuffer_multisample', 'GL_EXT_packed_depth_stencil', 'GL_ARB_depth_texture',
      'GL_ARB_texture_non_power_of_two', 'GL_EXT_bgra', 'GL_ARB_map_buffer_range', 'GL_ARB_copy_buffer', 'GL_ARB_uniform_buffer_object',
      'GL_ARB_instanced_arrays', 'GL_ARB_draw_instanced', 'GL_ARB_texture_rg', 'GL_ARB_texture_float', 'GL_ARB_half_float_pixel',
      'GL_ARB_half_float_vertex', 'GL_EXT_texture_sRGB', 'GL_ARB_sync', 'GL_ARB_sampler_objects', 'GL_ARB_texture_storage',
      'GL_EXT_blend_func_separate', 'GL_EXT_blend_minmax', 'GL_EXT_blend_equation_separate', 'GL_EXT_blend_color', 'GL_EXT_blend_subtract',
      'GL_ARB_occlusion_query', 'GL_ARB_occlusion_query2', 'GL_ARB_explicit_attrib_location', 'GL_ARB_texture_swizzle',
      'GL_EXT_texture_swizzle', 'GL_ARB_pixel_buffer_object', 'GL_EXT_texture_edge_clamp', 'GL_SGIS_texture_edge_clamp',
      'GL_ARB_texture_mirrored_repeat', 'GL_ARB_vertex_type_2_10_10_10_rev', 'GL_EXT_texture3D', 'GL_ARB_texture_cube_map',
      'GL_EXT_texture_array', 'GL_ARB_draw_buffers', 'GL_ARB_multisample', 'GL_ARB_fragment_coord_conventions'];
    if (!c.core) {
      x.push('GL_ARB_multitexture', 'GL_ARB_texture_env_combine', 'GL_EXT_texture_env_combine', 'GL_ARB_texture_env_add', 'GL_EXT_texture_env_add',
        'GL_ARB_texture_env_dot3', 'GL_ARB_texture_env_crossbar', 'GL_ARB_shader_objects', 'GL_ARB_vertex_shader', 'GL_ARB_fragment_shader',
        'GL_ARB_shading_language_100', 'GL_ARB_point_parameters', 'GL_EXT_point_parameters', 'GL_ARB_point_sprite', 'GL_EXT_secondary_color',
        'GL_EXT_fog_coord', 'GL_ARB_window_pos', 'GL_EXT_rescale_normal', 'GL_EXT_separate_specular_color', 'GL_EXT_texture_object',
        'GL_EXT_vertex_array', 'GL_EXT_draw_range_elements', 'GL_EXT_compiled_vertex_array', 'GL_ARB_transpose_matrix', 'GL_EXT_abgr',
        'GL_EXT_texture_lod_bias', 'GL_SGIS_generate_mipmap', 'GL_SGIS_texture_lod', 'GL_EXT_stencil_wrap', 'GL_EXT_stencil_two_side',
        'GL_ARB_texture_compression', 'GL_EXT_multi_draw_arrays', 'GL_ARB_texture_border_clamp');
    }
    if (this.ext.EXT_texture_filter_anisotropic) x.push('GL_EXT_texture_filter_anisotropic', 'GL_ARB_texture_filter_anisotropic');
    if (this.ext.WEBGL_compressed_texture_s3tc) x.push('GL_EXT_texture_compression_s3tc');
    if (this.ext.EXT_depth_clamp) x.push('GL_ARB_depth_clamp');
    if (this.ext.EXT_disjoint_timer_query_webgl2) x.push('GL_ARB_timer_query', 'GL_EXT_timer_query');
    if (this.ext.EXT_color_buffer_float) x.push('GL_ARB_color_buffer_float');
    return x;
  }

  tcSwapBuffers(xid: number, frame: number) {
    const d = this.drawables.get(xid);
    if (d) this.present(d);
    this.frames++;
    this.host.send(message(MSG_FRAME, u32s(frame)));
    // follow the window's size, as DRI does at swap
    if (d) {
      const size = this.host.drawableSize(xid);
      if (size && (size.width !== d.width || size.height !== d.height)) this.resizeDrawable(d, size.width, size.height);
    }
  }

  private resizeDrawable(old: Drawable, width: number, height: number) {
    const cfg: FBConfig = { depth: old.depth, stencil: old.stencil, samples: old.samples, alpha: false, doublebuffer: true };
    const d = this.makeDrawable(old.xid, Math.max(1, width), Math.max(1, height), cfg);
    // keep the old contents in the corner, as a resized X window would
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, old.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, d.fbo);
    gl.disable(gl.SCISSOR_TEST);
    if (!old.samples && !d.samples) gl.blitFramebuffer(0, 0, old.width, old.height, 0, 0, old.width, old.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.drawables.set(old.xid, d);
    for (const c of this.contexts.values()) {
      if (c.draw === old) c.draw = d;
      if (c.read === old) c.read = d;
    }
    this.freeDrawable(old);
    for (const c of this.contexts.values()) { if (c.draw === null && c.read === null) continue; }
    if (this.cur) {
      if (this.cur.caps.has(E.SCISSOR_TEST)) gl.enable(gl.SCISSOR_TEST);
      this.bindDrawFb(this.cur);
      this.bindReadFb(this.cur);
    }
  }

  /** The drawable's color buffer, single-sampled. */
  private resolved(d: Drawable): WebGLFramebuffer {
    if (!d.samples) return d.fbo;
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, d.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, d.resolveFbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, d.width, d.height, 0, 0, d.width, d.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (this.cur?.caps.has(E.SCISSOR_TEST)) gl.enable(gl.SCISSOR_TEST);
    return d.resolveFbo!;
  }

  private present(d: Drawable) {
    const gl = this.gl;
    const src = this.resolved(d);
    if (this.host.presentMode === 'bitmap' && 'transferToImageBitmap' in gl.canvas) {
      const canvas = gl.canvas as OffscreenCanvas;
      if (canvas.width !== d.width || canvas.height !== d.height) { canvas.width = d.width; canvas.height = d.height; }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.blitFramebuffer(0, 0, d.width, d.height, 0, 0, d.width, d.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      const bitmap = canvas.transferToImageBitmap();
      this.host.present(d.xid, { bitmap, width: d.width, height: d.height });
    } else {
      const pixels = new Uint8Array(d.width * d.height * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.readPixels(0, 0, d.width, d.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (this.cur) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.bufObj(this.cur.pixelPack));
      this.host.present(d.xid, { pixels, width: d.width, height: d.height });
    }
    if (this.cur) {
      if (this.cur.caps.has(E.SCISSOR_TEST)) gl.enable(gl.SCISSOR_TEST);
      this.bindDrawFb(this.cur);
      this.bindReadFb(this.cur);
    }
  }

  // ── simple state ──

  glEnable(cap: number) { this.setCap(cap, true); }
  glDisable(cap: number) { this.setCap(cap, false); }
  glEnablei(cap: number, _i: number) { this.setCap(cap, true); }
  glDisablei(cap: number, _i: number) { this.setCap(cap, false); }
  private setCap(cap: number, on: boolean) {
    const c = this.cur;
    if (!c) return;
    on ? c.caps.add(cap) : c.caps.delete(cap);
    const gl = this.gl;
    if (WEBGL_CAPS.has(cap)) { on ? gl.enable(cap) : gl.disable(cap); return; }
    const ff = c.ff;
    if (cap >= E.LIGHT0 && cap < E.LIGHT0 + FF_LIGHTS) { ff.lights[cap - E.LIGHT0].enabled = on; return; }
    if (cap >= E.CLIP_PLANE0 && cap < E.CLIP_PLANE0 + FF_CLIP_PLANES) { ff.clipEnabled = on ? ff.clipEnabled | (1 << (cap - E.CLIP_PLANE0)) : ff.clipEnabled & ~(1 << (cap - E.CLIP_PLANE0)); return; }
    const unit = ff.units[c.activeUnit];
    const texBit = cap === E.TEXTURE_1D ? 1 : cap === E.TEXTURE_2D ? 2 : cap === E.TEXTURE_3D ? 4 : cap === E.TEXTURE_CUBE_MAP ? 8 : cap === E.TEXTURE_RECTANGLE ? 16 : 0;
    if (texBit) { if (unit) unit.enabled = on ? unit.enabled | texBit : unit.enabled & ~texBit; return; }
    const gen = cap === E.TEXTURE_GEN_S ? 1 : cap === E.TEXTURE_GEN_T ? 2 : cap === E.TEXTURE_GEN_R ? 4 : cap === E.TEXTURE_GEN_Q ? 8 : 0;
    if (gen) { if (unit) unit.texGen = on ? unit.texGen | gen : unit.texGen & ~gen; return; }
    switch (cap) {
      case E.LIGHTING: ff.lighting = on; break;
      case E.COLOR_MATERIAL: ff.colorMaterial = on; if (on) this.applyColorMaterial(); break;
      case E.NORMALIZE: ff.normalize = on; break;
      case E.RESCALE_NORMAL: ff.rescaleNormal = on; break;
      case E.FOG: ff.fog = on; break;
      case E.ALPHA_TEST: ff.alphaTest = on; break;
      case E.COLOR_SUM: ff.colorSum = on; break;
      case E.POINT_SPRITE: ff.pointSprite = on; break;
      case E.PRIMITIVE_RESTART: c.primitiveRestart = on; break;
      case E.DEPTH_CLAMP: {
        const ext = this.ext.EXT_depth_clamp as { DEPTH_CLAMP_EXT: number } | undefined;
        if (ext) on ? gl.enable(ext.DEPTH_CLAMP_EXT) : gl.disable(ext.DEPTH_CLAMP_EXT);
        break;
      }
      case E.MULTISAMPLE: case E.POINT_SMOOTH: case E.LINE_SMOOTH: case E.POLYGON_SMOOTH: case E.LINE_STIPPLE: case E.POLYGON_STIPPLE:
      case E.PROGRAM_POINT_SIZE: case E.VERTEX_PROGRAM_TWO_SIDE: case E.TEXTURE_CUBE_MAP_SEAMLESS: case E.FRAMEBUFFER_SRGB:
      case E.POLYGON_OFFSET_LINE: case E.POLYGON_OFFSET_POINT: case E.AUTO_NORMAL: case E.MAP1_VERTEX_3: case E.MAP2_VERTEX_3:
      case E.DEBUG_OUTPUT: case E.DEBUG_OUTPUT_SYNCHRONOUS: case E.COLOR_LOGIC_OP: case E.INDEX_LOGIC_OP: case E.SAMPLE_ALPHA_TO_ONE:
        break;
      default:
        if (on) this.warnOnce(`glEnable(0x${cap.toString(16)}) is ignored`);
    }
  }
  glIsEnabled(cap: number): Uint8Array {
    const c = this.cur;
    if (!c) return u32s(0);
    if (cap >= E.LIGHT0 && cap < E.LIGHT0 + FF_LIGHTS) return u32s(c.ff.lights[cap - E.LIGHT0].enabled ? 1 : 0);
    return u32s(c.caps.has(cap) ? 1 : 0);
  }
  glIsEnabledi(cap: number, _i: number): Uint8Array { return this.glIsEnabled(cap); }

  glViewport(x: number, y: number, w: number, h: number) { const c = this.cur; if (!c) return; c.viewport = [x, y, w, h]; this.gl.viewport(x, y, w, h); }
  glScissor(x: number, y: number, w: number, h: number) { const c = this.cur; if (!c) return; c.scissor = [x, y, w, h]; this.gl.scissor(x, y, w, h); }
  glClearColor(r: number, g: number, b: number, a: number) { const c = this.cur; if (!c) return; c.clearColor = [r, g, b, a]; this.gl.clearColor(r, g, b, a); }
  glClearDepth(d: number) { const c = this.cur; if (!c) return; c.clearDepth = d; this.gl.clearDepth(d); }
  glClearDepthf(d: number) { this.glClearDepth(d); }
  glClearStencil(s: number) { const c = this.cur; if (!c) return; c.clearStencil = s; this.gl.clearStencil(s); }
  glClearIndex() { /* color index mode doesn't exist here */ }
  glClearAccum() { /* no accumulation buffer */ }
  glColorMask(r: number, g: number, b: number, a: number) { const c = this.cur; if (!c) return; c.colorMask = [!!r, !!g, !!b, !!a]; this.gl.colorMask(!!r, !!g, !!b, !!a); }
  glColorMaski(_i: number, r: number, g: number, b: number, a: number) { this.glColorMask(r, g, b, a); }
  glDepthMask(f: number) { const c = this.cur; if (!c) return; c.depthMask = !!f; this.gl.depthMask(!!f); }
  glDepthFunc(f: number) { const c = this.cur; if (!c) return; c.depthFunc = f; this.gl.depthFunc(f); }
  glDepthRange(n: number, f: number) { const c = this.cur; if (!c) return; c.depthRange = [n, f]; this.gl.depthRange(n, f); }
  glDepthRangef(n: number, f: number) { this.glDepthRange(n, f); }
  glBlendFunc(s: number, d: number) { this.glBlendFuncSeparate(s, d, s, d); }
  glBlendFuncSeparate(sr: number, dr: number, sa: number, da: number) {
    const c = this.cur; if (!c) return;
    Object.assign(c.blend, { srcRGB: sr, dstRGB: dr, srcA: sa, dstA: da });
    this.gl.blendFuncSeparate(sr, dr, sa, da);
  }
  glBlendFunci(_i: number, s: number, d: number) { this.glBlendFunc(s, d); }
  glBlendEquation(m: number) { this.glBlendEquationSeparate(m, m); }
  glBlendEquationSeparate(r: number, a: number) {
    const c = this.cur; if (!c) return;
    c.blend.eqRGB = r; c.blend.eqA = a;
    this.gl.blendEquationSeparate(r, a);
  }
  glBlendColor(r: number, g: number, b: number, a: number) { const c = this.cur; if (!c) return; c.blend.color = [r, g, b, a]; this.gl.blendColor(r, g, b, a); }
  glCullFace(m: number) { const c = this.cur; if (!c) return; c.cullFace = m; this.gl.cullFace(m); }
  glFrontFace(m: number) { const c = this.cur; if (!c) return; c.frontFace = m; this.gl.frontFace(m); }
  glPolygonOffset(f: number, u: number) { const c = this.cur; if (!c) return; c.polygonOffset = [f, u]; this.gl.polygonOffset(f, u); }
  glPolygonMode(face: number, mode: number) {
    const c = this.cur; if (!c) return;
    if (face === E.FRONT || face === E.FRONT_AND_BACK) c.polygonMode[0] = mode;
    if (face === E.BACK || face === E.FRONT_AND_BACK) c.polygonMode[1] = mode;
  }
  glLineWidth(w: number) { const c = this.cur; if (!c) return; c.lineWidth = w; this.gl.lineWidth(w); }
  glPointSize(s: number) { const c = this.cur; if (!c) return; c.ff.pointSize = s; }
  glLineStipple() { /* not drawn */ }
  glPolygonStipple() { /* not drawn */ }
  glSampleCoverage(v: number, inv: number) { const c = this.cur; if (!c) return; c.sampleCoverage = [v, !!inv]; this.gl.sampleCoverage(v, !!inv); }
  glHint(target: number, mode: number) {
    const c = this.cur; if (!c) return;
    c.hints.set(target, mode);
    if (target === E.GENERATE_MIPMAP_HINT || target === E.FRAGMENT_SHADER_DERIVATIVE_HINT) this.gl.hint(target, mode);
  }
  glStencilFunc(f: number, r: number, m: number) { this.glStencilFuncSeparate(E.FRONT_AND_BACK, f, r, m); }
  glStencilFuncSeparate(face: number, f: number, r: number, m: number) {
    const c = this.cur; if (!c) return;
    for (const s of this.faces(c, face)) Object.assign(s, { func: f, ref: r, mask: m });
    this.gl.stencilFuncSeparate(face, f, r, m);
  }
  glStencilOp(f: number, zf: number, zp: number) { this.glStencilOpSeparate(E.FRONT_AND_BACK, f, zf, zp); }
  glStencilOpSeparate(face: number, f: number, zf: number, zp: number) {
    const c = this.cur; if (!c) return;
    for (const s of this.faces(c, face)) Object.assign(s, { fail: f, zfail: zf, zpass: zp });
    this.gl.stencilOpSeparate(face, f, zf, zp);
  }
  glStencilMask(m: number) { this.glStencilMaskSeparate(E.FRONT_AND_BACK, m); }
  glStencilMaskSeparate(face: number, m: number) {
    const c = this.cur; if (!c) return;
    for (const s of this.faces(c, face)) s.writemask = m;
    this.gl.stencilMaskSeparate(face, m);
  }
  private faces(c: Ctx, face: number) {
    return face === E.FRONT ? [c.stencil.front] : face === E.BACK ? [c.stencil.back] : [c.stencil.front, c.stencil.back];
  }
  glShadeModel(m: number) { const c = this.cur; if (!c) return; c.ff.flat = m === E.FLAT; }
  glLogicOp() { this.warnOnce('glLogicOp is ignored'); }
  glPrimitiveRestartIndex(i: number) { const c = this.cur; if (!c) return; c.restartIndex = i; }
  glProvokingVertex() { /* last vertex, as WebGL */ }
  glClampColor() { /* colors are clamped where GL clamps them */ }
  glPixelZoom() { /* glDrawPixels at zoom 1 */ }
  glPixelTransferf() { /* identity transfer */ }
  glPixelTransferi() { /* identity transfer */ }

  glClear(mask: number) {
    const c = this.cur; if (!c) return;
    this.syncFbDrawBuffers();
    this.gl.clear(mask & (E.COLOR_BUFFER_BIT | E.DEPTH_BUFFER_BIT | E.STENCIL_BUFFER_BIT));
  }
  glClearBufferfv(buffer: number, drawbuffer: number, value: Float32Array) { this.gl.clearBufferfv(buffer, drawbuffer, value); }
  glClearBufferiv(buffer: number, drawbuffer: number, value: Int32Array) { this.gl.clearBufferiv(buffer, drawbuffer, value); }
  glClearBufferuiv(buffer: number, drawbuffer: number, value: Uint32Array) { this.gl.clearBufferuiv(buffer, drawbuffer, value); }
  glClearBufferfi(buffer: number, drawbuffer: number, depth: number, stencil: number) { this.gl.clearBufferfi(buffer, drawbuffer, depth, stencil); }
  private syncFbDrawBuffers() { /* the default framebuffer always draws to its one color buffer */ }

  glFlush() {
    const c = this.cur;
    // single-buffered windows show what was drawn at glFlush/glFinish
    if (c?.draw && !c.drawFb && (c.drawBuffers[0] === E.FRONT || c.drawBuffers[0] === E.FRONT_LEFT)) this.present(c.draw);
    this.gl.flush();
  }
  glFinish(): Uint8Array {
    this.glFlush();
    return new Uint8Array(0);
  }
  glGetError(): Uint8Array { return u32s(0); }

  glDrawBuffer(b: number) {
    const c = this.cur; if (!c) return;
    if (c.drawFb) { this.gl.drawBuffers([b === E.NONE ? E.NONE : b]); return; }
    c.drawBuffers = [b];
    this.bindDrawFb(c);
  }
  glDrawBuffers(bufs: Uint32Array) {
    const c = this.cur; if (!c) return;
    if (c.drawFb) this.gl.drawBuffers(Array.from(bufs));
    else { c.drawBuffers = [bufs[0] ?? E.BACK]; this.bindDrawFb(c); }
  }
  glReadBuffer(b: number) {
    const c = this.cur; if (!c) return;
    if (c.readFb) this.gl.readBuffer(b);
    else c.readBuffer = b;
  }

  // ── matrices ──

  glMatrixMode(m: number) { const c = this.cur; if (c) c.ff.matrixMode = m; }
  glLoadIdentity() { this.cur?.ff.top().set(identity()); }
  glLoadMatrixf(m: Float32Array) { this.cur?.ff.top().set(m.subarray(0, 16)); }
  glLoadMatrixd(m: Float64Array) { this.cur?.ff.top().set(Array.from(m).slice(0, 16)); }
  glLoadTransposeMatrixf(m: Float32Array) { this.cur?.ff.top().set(transpose(m)); }
  glLoadTransposeMatrixd(m: Float64Array) { this.cur?.ff.top().set(transpose(m)); }
  glMultMatrixf(m: Float32Array) { this.mult(m); }
  glMultMatrixd(m: Float64Array) { this.mult(m); }
  glMultTransposeMatrixf(m: Float32Array) { this.mult(transpose(m)); }
  glMultTransposeMatrixd(m: Float64Array) { this.mult(transpose(m)); }
  private mult(m: ArrayLike<number>) { const c = this.cur; if (!c) return; const t = c.ff.top(); mul(t, t, m); }
  glPushMatrix() {
    const c = this.cur; if (!c) return;
    const s = c.ff.stack();
    if (s.length >= 32) { this.error(E.STACK_OVERFLOW); return; }
    s.push(new Float32Array(s[s.length - 1]));
  }
  glPopMatrix() {
    const c = this.cur; if (!c) return;
    const s = c.ff.stack();
    if (s.length <= 1) { this.error(E.STACK_UNDERFLOW); return; }
    s.pop();
  }
  glRotatef(a: number, x: number, y: number, z: number) { this.mult(rotation(a, x, y, z)); }
  glRotated(a: number, x: number, y: number, z: number) { this.mult(rotation(a, x, y, z)); }
  glTranslatef(x: number, y: number, z: number) { this.mult(translation(x, y, z)); }
  glTranslated(x: number, y: number, z: number) { this.mult(translation(x, y, z)); }
  glScalef(x: number, y: number, z: number) { this.mult(scaling(x, y, z)); }
  glScaled(x: number, y: number, z: number) { this.mult(scaling(x, y, z)); }
  glFrustum(l: number, r: number, b: number, t: number, n: number, f: number) { this.mult(frustum(l, r, b, t, n, f)); }
  glOrtho(l: number, r: number, b: number, t: number, n: number, f: number) { this.mult(ortho(l, r, b, t, n, f)); }

  // ── lighting, materials, fog, texture environment ──

  glLightfv(light: number, pname: number, v: Float32Array) { this.light(light, pname, Array.from(v)); }
  glLightiv(light: number, pname: number, v: Int32Array) {
    const colors = pname === E.AMBIENT || pname === E.DIFFUSE || pname === E.SPECULAR;
    this.light(light, pname, Array.from(v).map((x) => (colors ? normalize('i', x) : x)));
  }
  glLightf(light: number, pname: number, v: number) { this.light(light, pname, [v]); }
  glLighti(light: number, pname: number, v: number) { this.light(light, pname, [v]); }
  private light(light: number, pname: number, v: number[]) {
    const c = this.cur; if (!c) return;
    const l = c.ff.lights[light - E.LIGHT0];
    if (!l) { this.error(E.INVALID_ENUM); return; }
    switch (pname) {
      case E.AMBIENT: l.ambient.set(v.slice(0, 4)); break;
      case E.DIFFUSE: l.diffuse.set(v.slice(0, 4)); break;
      case E.SPECULAR: l.specular.set(v.slice(0, 4)); break;
      case E.POSITION: l.position.set(transformVec4(c.ff.mv, [v[0], v[1], v[2], v[3] ?? 1])); break;
      case E.SPOT_DIRECTION: {
        const m = c.ff.mv;
        l.spotDirection.set([m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]]);
        break;
      }
      case E.SPOT_EXPONENT: l.spotExponent = v[0]; break;
      case E.SPOT_CUTOFF: l.spotCutoff = v[0]; break;
      case E.CONSTANT_ATTENUATION: l.attenuation[0] = v[0]; break;
      case E.LINEAR_ATTENUATION: l.attenuation[1] = v[0]; break;
      case E.QUADRATIC_ATTENUATION: l.attenuation[2] = v[0]; break;
      default: this.error(E.INVALID_ENUM);
    }
  }
  glLightModelfv(pname: number, v: Float32Array) { this.lightModel(pname, Array.from(v)); }
  glLightModeliv(pname: number, v: Int32Array) { this.lightModel(pname, Array.from(v).map((x) => (pname === E.LIGHT_MODEL_AMBIENT ? normalize('i', x) : x))); }
  glLightModelf(pname: number, v: number) { this.lightModel(pname, [v]); }
  glLightModeli(pname: number, v: number) { this.lightModel(pname, [v]); }
  private lightModel(pname: number, v: number[]) {
    const ff = this.cur?.ff; if (!ff) return;
    switch (pname) {
      case E.LIGHT_MODEL_AMBIENT: ff.lightModelAmbient.set(v.slice(0, 4)); break;
      case E.LIGHT_MODEL_LOCAL_VIEWER: ff.localViewer = v[0] !== 0; break;
      case E.LIGHT_MODEL_TWO_SIDE: ff.twoSide = v[0] !== 0; break;
      case E.LIGHT_MODEL_COLOR_CONTROL: ff.separateSpecular = v[0] === E.SEPARATE_SPECULAR_COLOR; break;
    }
  }
  glMaterialfv(face: number, pname: number, v: Float32Array) { this.material(face, pname, Array.from(v)); }
  glMaterialiv(face: number, pname: number, v: Int32Array) { this.material(face, pname, Array.from(v).map((x) => (pname === E.SHININESS ? x : normalize('i', x)))); }
  glMaterialf(face: number, pname: number, v: number) { this.material(face, pname, [v]); }
  glMateriali(face: number, pname: number, v: number) { this.material(face, pname, [v]); }
  private material(face: number, pname: number, v: number[]) {
    const ff = this.cur?.ff; if (!ff) return;
    const mats = face === E.FRONT ? [ff.front] : face === E.BACK ? [ff.back] : [ff.front, ff.back];
    for (const m of mats) {
      switch (pname) {
        case E.AMBIENT: m.ambient.set(v.slice(0, 4)); break;
        case E.DIFFUSE: m.diffuse.set(v.slice(0, 4)); break;
        case E.SPECULAR: m.specular.set(v.slice(0, 4)); break;
        case E.EMISSION: m.emission.set(v.slice(0, 4)); break;
        case E.SHININESS: m.shininess = v[0]; break;
        case E.AMBIENT_AND_DIFFUSE: m.ambient.set(v.slice(0, 4)); m.diffuse.set(v.slice(0, 4)); break;
        case E.COLOR_INDEXES: break;
      }
    }
  }
  glColorMaterial(face: number, mode: number) { const ff = this.cur?.ff; if (!ff) return; ff.colorMaterialFace = face; ff.colorMaterialMode = mode; }
  /** With COLOR_MATERIAL on, the current color also changes the material (GL keeps them in step). */
  private applyColorMaterial() {
    const ff = this.cur?.ff; if (!ff || !ff.colorMaterial) return;
    const col = Array.from(ff.current.color);
    const mode = ff.colorMaterialMode;
    const pname = mode === E.AMBIENT_AND_DIFFUSE ? E.AMBIENT_AND_DIFFUSE : mode;
    this.material(ff.colorMaterialFace, pname, col);
  }
  glFogf(pname: number, v: number) { this.fog(pname, [v]); }
  glFogi(pname: number, v: number) { this.fog(pname, [v]); }
  glFogfv(pname: number, v: Float32Array) { this.fog(pname, Array.from(v)); }
  glFogiv(pname: number, v: Int32Array) { this.fog(pname, Array.from(v).map((x) => (pname === E.FOG_COLOR ? normalize('i', x) : x))); }
  private fog(pname: number, v: number[]) {
    const ff = this.cur?.ff; if (!ff) return;
    switch (pname) {
      case E.FOG_MODE: ff.fogMode = v[0]; break;
      case E.FOG_DENSITY: ff.fogDensity = v[0]; break;
      case E.FOG_START: ff.fogStart = v[0]; break;
      case E.FOG_END: ff.fogEnd = v[0]; break;
      case E.FOG_COLOR: ff.fogColor.set(v.slice(0, 4)); break;
      case E.FOG_COORD_SRC: ff.fogCoordSrc = v[0]; break;
    }
  }
  glAlphaFunc(f: number, ref: number) { const ff = this.cur?.ff; if (!ff) return; ff.alphaFunc = f; ff.alphaRef = Math.min(Math.max(ref, 0), 1); }
  glClipPlane(plane: number, eq: Float64Array) {
    const c = this.cur; if (!c) return;
    const i = plane - E.CLIP_PLANE0;
    if (i < 0 || i >= FF_CLIP_PLANES) { this.error(E.INVALID_ENUM); return; }
    // planes are kept in eye coordinates: p_eye = p × inverse(modelview)
    const inv = invert(c.ff.mv);
    const p = [eq[0], eq[1], eq[2], eq[3]];
    const r = new Float32Array(4);
    for (let k = 0; k < 4; k++) r[k] = p[0] * inv[k * 4] + p[1] * inv[k * 4 + 1] + p[2] * inv[k * 4 + 2] + p[3] * inv[k * 4 + 3];
    c.ff.clipPlanes[i] = r;
  }
  glTexEnvf(target: number, pname: number, v: number) { this.texEnv(target, pname, [v]); }
  glTexEnvi(target: number, pname: number, v: number) { this.texEnv(target, pname, [v]); }
  glTexEnvfv(target: number, pname: number, v: Float32Array) { this.texEnv(target, pname, Array.from(v)); }
  glTexEnviv(target: number, pname: number, v: Int32Array) { this.texEnv(target, pname, Array.from(v).map((x) => (pname === E.TEXTURE_ENV_COLOR ? normalize('i', x) : x))); }
  private texEnv(target: number, pname: number, v: number[]) {
    const c = this.cur; if (!c) return;
    if (target === E.POINT_SPRITE) return; // COORD_REPLACE: point sprites always replace
    const u = c.ff.units[c.activeUnit];
    if (!u) return;
    if (target === E.TEXTURE_FILTER_CONTROL) { if (pname === E.TEXTURE_LOD_BIAS) u.lodBias = v[0]; return; }
    switch (pname) {
      case E.TEXTURE_ENV_MODE: u.envMode = v[0]; break;
      case E.TEXTURE_ENV_COLOR: u.envColor.set(v.slice(0, 4)); break;
      case E.COMBINE_RGB: u.combineRGB = v[0]; break;
      case E.COMBINE_ALPHA: u.combineAlpha = v[0]; break;
      case E.SRC0_RGB: case E.SRC1_RGB: case E.SRC2_RGB: u.srcRGB[pname - E.SRC0_RGB] = v[0]; break;
      case E.SRC0_ALPHA: case E.SRC1_ALPHA: case E.SRC2_ALPHA: u.srcAlpha[pname - E.SRC0_ALPHA] = v[0]; break;
      case E.OPERAND0_RGB: case E.OPERAND1_RGB: case E.OPERAND2_RGB: u.operandRGB[pname - E.OPERAND0_RGB] = v[0]; break;
      case E.OPERAND0_ALPHA: case E.OPERAND1_ALPHA: case E.OPERAND2_ALPHA: u.operandAlpha[pname - E.OPERAND0_ALPHA] = v[0]; break;
      case E.RGB_SCALE: u.rgbScale = v[0]; break;
      case E.ALPHA_SCALE: u.alphaScale = v[0]; break;
    }
  }
  glTexGeni(coord: number, pname: number, v: number) { this.texGen(coord, pname, [v]); }
  glTexGenf(coord: number, pname: number, v: number) { this.texGen(coord, pname, [v]); }
  glTexGend(coord: number, pname: number, v: number) { this.texGen(coord, pname, [v]); }
  glTexGenfv(coord: number, pname: number, v: Float32Array) { this.texGen(coord, pname, Array.from(v)); }
  glTexGeniv(coord: number, pname: number, v: Int32Array) { this.texGen(coord, pname, Array.from(v)); }
  glTexGendv(coord: number, pname: number, v: Float64Array) { this.texGen(coord, pname, Array.from(v)); }
  private texGen(coord: number, pname: number, v: number[]) {
    const c = this.cur; if (!c) return;
    const u = c.ff.units[c.activeUnit];
    const k = coord - E.S;
    if (!u || k < 0 || k > 3) return;
    if (pname === E.TEXTURE_GEN_MODE) u.texGenMode[k] = v[0];
    else if (pname === E.OBJECT_PLANE) u.objectPlane[k] = new Float32Array(v.slice(0, 4));
    else if (pname === E.EYE_PLANE) {
      const inv = invert(c.ff.mv);
      const r = new Float32Array(4);
      for (let i = 0; i < 4; i++) r[i] = v[0] * inv[i * 4] + v[1] * inv[i * 4 + 1] + v[2] * inv[i * 4 + 2] + v[3] * inv[i * 4 + 3];
      u.eyePlane[k] = r;
    }
  }
  glPointParameterf(pname: number, v: number) { this.pointParam(pname, [v]); }
  glPointParameteri(pname: number, v: number) { this.pointParam(pname, [v]); }
  glPointParameterfv(pname: number, v: Float32Array) { this.pointParam(pname, Array.from(v)); }
  glPointParameteriv(pname: number, v: Int32Array) { this.pointParam(pname, Array.from(v)); }
  private pointParam(pname: number, v: number[]) {
    const ff = this.cur?.ff; if (!ff) return;
    if (pname === E.POINT_SIZE_MIN) ff.pointSizeMin = v[0];
    else if (pname === E.POINT_SIZE_MAX) ff.pointSizeMax = v[0];
    else if (pname === E.POINT_FADE_THRESHOLD_SIZE) ff.pointFadeThreshold = v[0];
    else if (pname === E.POINT_DISTANCE_ATTENUATION) ff.pointDistanceAttenuation.set(v.slice(0, 3));
  }

  // ── current vertex attributes and immediate mode ──

  private attrib(kind: string, index: number, v: number[], n: number, integer: boolean) {
    const c = this.cur; if (!c) return;
    const ff = c.ff;
    const full = (def: number[]) => { const r = def.slice(); for (let i = 0; i < n && i < 4; i++) r[i] = v[i]; return r; };
    switch (kind) {
      case 'Vertex': {
        const p = full([0, 0, 0, 1]);
        if (c.begin !== null) this.emitVertex(c, p);
        return;
      }
      case 'Normal': ff.current.normal.set(full([0, 0, 1]).slice(0, 3)); return;
      case 'Color': ff.current.color.set(full([0, 0, 0, 1])); if (ff.colorMaterial) this.applyColorMaterial(); return;
      case 'SecondaryColor': ff.current.secondaryColor.set([...full([0, 0, 0, 1]).slice(0, 3), 1]); return;
      case 'TexCoord': ff.current.texCoord[0].set(full([0, 0, 0, 1])); return;
      case 'MultiTexCoord': { const u = index - E.TEXTURE0; if (u >= 0 && u < FF_TEXTURE_UNITS) ff.current.texCoord[u].set(full([0, 0, 0, 1])); return; }
      case 'FogCoord': ff.current.fogCoord = v[0]; return;
      case 'VertexAttrib': case 'VertexAttribI': {
        if (index >= 16) { this.error(E.INVALID_VALUE); return; }
        const val = full([0, 0, 0, 1]);
        // in the compatibility profile generic attribute 0 is the vertex position
        if (index === 0 && !c.core && c.begin !== null) { this.emitVertex(c, val); return; }
        c.generic[index].set(val);
        if (integer) this.gl.vertexAttribI4i(index, val[0], val[1], val[2], val[3]);
        else this.gl.vertexAttrib4f(index, val[0], val[1], val[2], val[3]);
        return;
      }
      case 'RasterPos': case 'WindowPos': this.warnOnce(`gl${kind} is ignored`); return;
      case 'EvalCoord': return;
    }
  }

  private emitVertex(c: Ctx, p: number[]) {
    const ff = c.ff;
    const a = c.imm;
    const cur = ff.current;
    a.push(p[0], p[1], p[2], p[3], cur.normal[0], cur.normal[1], cur.normal[2],
      cur.color[0], cur.color[1], cur.color[2], cur.color[3],
      cur.secondaryColor[0], cur.secondaryColor[1], cur.secondaryColor[2], cur.secondaryColor[3], cur.fogCoord);
    for (let u = 0; u < FF_TEXTURE_UNITS; u++) { const t = cur.texCoord[u]; a.push(t[0], t[1], t[2], t[3]); }
    c.immCount++;
  }

  glBegin(mode: number) {
    const c = this.cur; if (!c) return;
    if (c.begin !== null) { this.error(E.INVALID_OPERATION); return; }
    c.begin = mode;
    c.imm = [];
    c.immCount = 0;
  }
  glEnd() {
    const c = this.cur; if (!c) return;
    if (c.begin === null) { this.error(E.INVALID_OPERATION); return; }
    const mode = c.begin;
    c.begin = null;
    if (!c.immCount) return;
    const data = new Float32Array(c.imm);
    c.imm = [];
    this.drawImmediate(c, mode, data, c.immCount);
  }
  private rect(x1: number, y1: number, x2: number, y2: number) {
    const c = this.cur; if (!c) return;
    this.glBegin(E.POLYGON);
    this.emitVertex(c, [x1, y1, 0, 1]); this.emitVertex(c, [x2, y1, 0, 1]);
    this.emitVertex(c, [x2, y2, 0, 1]); this.emitVertex(c, [x1, y2, 0, 1]);
    this.glEnd();
  }

  /** Draws vertices assembled by glBegin/glEnd (IMM_STRIDE floats each). */
  private drawImmediate(c: Ctx, mode: number, data: Float32Array, count: number) {
    const gl = this.gl;
    const prim = toWebGLPrimitive(mode, count, c.polygonMode[0]);
    if (!prim) return;
    gl.bindVertexArray(this.immVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.immBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    const S = IMM_STRIDE * 4;
    const ptr = (slot: number, size: number, off: number) => { gl.enableVertexAttribArray(slot); gl.vertexAttribPointer(slot, size, gl.FLOAT, false, S, off * 4); };
    // which slots the program reads decides what is bound; ff slots by default
    const slots = this.programAttribSlots(c);
    for (let i = 0; i < 16; i++) gl.disableVertexAttribArray(i);
    ptr(slots.Vertex, 4, IMM_OFF.pos);
    if (slots.Normal >= 0) ptr(slots.Normal, 3, IMM_OFF.normal);
    if (slots.Color >= 0) ptr(slots.Color, 4, IMM_OFF.color);
    if (slots.SecondaryColor >= 0) ptr(slots.SecondaryColor, 4, IMM_OFF.secondary);
    if (slots.FogCoord >= 0) ptr(slots.FogCoord, 1, IMM_OFF.fog);
    for (let u = 0; u < FF_TEXTURE_UNITS; u++) if (slots.TexCoord[u] >= 0) ptr(slots.TexCoord[u], 4, IMM_OFF.tc + 4 * u);
    if (this.prepareDraw(c, prim.mode === gl.POINTS)) {
      if (prim.indices) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.immIndex);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, prim.indices, gl.STREAM_DRAW);
        gl.drawElements(prim.mode, prim.indices.length, gl.UNSIGNED_INT, 0);
      } else gl.drawArrays(prim.mode, 0, count);
    }
    gl.bindVertexArray(c.vao.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufObj(c.arrayBuffer));
    this.finishDraw(c);
  }

  /** Attribute slots of the compatibility built-ins for the current program (fixed function: ATTR). */
  private programAttribSlots(c: Ctx) {
    const p = c.program ? (c.share.objects.get(c.program) as ProgObj | undefined) : undefined;
    if (!p || p.kind !== 'program') {
      return { Vertex: ATTR.Vertex, Normal: ATTR.Normal, Color: ATTR.Color, SecondaryColor: ATTR.SecondaryColor, FogCoord: ATTR.FogCoord,
        TexCoord: Array.from({ length: FF_TEXTURE_UNITS }, (_, i) => ATTR.TexCoord0 + i) };
    }
    const b = p.builtinAttribs;
    return {
      Vertex: b.get('Vertex') ?? 0, Normal: b.get('Normal') ?? -1, Color: b.get('Color') ?? -1, SecondaryColor: b.get('SecondaryColor') ?? -1,
      FogCoord: b.get('FogCoord') ?? -1, TexCoord: Array.from({ length: FF_TEXTURE_UNITS }, (_, i) => b.get(`MultiTexCoord${i}`) ?? -1),
    };
  }

  /**
   * Before a draw: the fixed-function program (when no program is in use) or
   * the built-in uniforms of the app's program. False to skip the draw.
   */
  private prepareDraw(c: Ctx, points: boolean): boolean {
    if (c.program) {
      const p = c.share.objects.get(c.program) as ProgObj | undefined;
      if (!p || p.kind !== 'program' || !p.linked) return false;
      if (p.builtins.size) this.setBuiltinUniforms(c, p);
      return true;
    }
    if (c.core) return false;
    const units = this.unitInfos(c);
    const key = ffKey(c.ff, units, points);
    let fp = c.ffPrograms.get(key);
    if (!fp) {
      const built = this.buildFF(c, units, points);
      if (!built) return false;
      fp = built;
      c.ffPrograms.set(key, fp);
    }
    this.gl.useProgram(fp.prog);
    this.setFFUniforms(c, fp, units);
    return true;
  }
  private finishDraw(c: Ctx) {
    if (!c.program) this.gl.useProgram(null);
  }

  private unitInfos(c: Ctx): (UnitInfo | null)[] {
    const out: (UnitInfo | null)[] = [];
    for (let u = 0; u < FF_TEXTURE_UNITS; u++) {
      const en = c.ff.units[u].enabled;
      if (!en) { out.push(null); continue; }
      // precedence: cube > 3D > 2D (rectangle) > 1D
      const target = en & 8 ? E.TEXTURE_CUBE_MAP : en & 4 ? E.TEXTURE_3D : en & 16 ? E.TEXTURE_RECTANGLE : en & 2 ? E.TEXTURE_2D : E.TEXTURE_1D;
      const name = c.textures[u].get(target) ?? 0;
      const t = c.share.textures.get(name);
      const base = t?.levels[0]?.fmt.base ?? 'rgba';
      if (!t || !t.levels[0]) { out.push(null); continue; }
      out.push({ target: target === E.TEXTURE_1D || target === E.TEXTURE_RECTANGLE ? E.TEXTURE_2D : target, base });
    }
    return out;
  }

  private buildFF(c: Ctx, units: (UnitInfo | null)[], points: boolean): FFProgram | null {
    const gl = this.gl;
    const { vs, fs } = ffSource(c.ff, units, points);
    const prog = this.compileProgram(vs, fs, (p) => {
      gl.bindAttribLocation(p, ATTR.Vertex, 'a_Vertex');
      gl.bindAttribLocation(p, ATTR.Normal, 'a_Normal');
      gl.bindAttribLocation(p, ATTR.Color, 'a_Color');
      gl.bindAttribLocation(p, ATTR.SecondaryColor, 'a_SecondaryColor');
      gl.bindAttribLocation(p, ATTR.FogCoord, 'a_FogCoord');
      for (let i = 0; i < FF_TEXTURE_UNITS; i++) gl.bindAttribLocation(p, ATTR.TexCoord0 + i, `a_TexCoord${i}`);
    });
    if (!prog) return null;
    return { prog, loc: new Map(), lights: enabledLights(c.ff) };
  }

  private compileProgram(vs: string, fs: string, beforeLink?: (p: WebGLProgram) => void): WebGLProgram | null {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) this.log(`glshiro: fixed-function shader: ${gl.getShaderInfoLog(s)}\n${src}`);
      return s;
    };
    const p = gl.createProgram()!;
    const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v); gl.attachShader(p, f);
    beforeLink?.(p);
    gl.linkProgram(p);
    gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      this.log(`glshiro: fixed-function program: ${gl.getProgramInfoLog(p)}`);
      gl.deleteProgram(p);
      return null;
    }
    return p;
  }

  private setFFUniforms(c: Ctx, fp: FFProgram, units: (UnitInfo | null)[]) {
    const gl = this.gl;
    const ff = c.ff;
    const L = (name: string) => {
      let l = fp.loc.get(name);
      if (l === undefined) { l = gl.getUniformLocation(fp.prog, name); fp.loc.set(name, l); }
      return l;
    };
    const mv = ff.mv;
    gl.uniformMatrix4fv(L('u_mv'), false, mv);
    gl.uniformMatrix4fv(L('u_mvp'), false, mul(new Float32Array(16), ff.proj, mv));
    const nmL = L('u_nm');
    if (nmL) {
      const nm = normalMatrix(mv);
      if (ff.rescaleNormal && !ff.normalize) {
        const s = 1 / Math.hypot(nm[2], nm[5], nm[8]) || 1;
        for (let i = 0; i < 9; i++) nm[i] *= s;
      }
      gl.uniformMatrix3fv(nmL, false, nm);
    }
    gl.uniform1f(L('u_pointSize'), ff.pointSize);
    if (ff.lighting) {
      fp.lights.forEach((li, k) => {
        const l = ff.lights[li];
        const b = `u_light[${k}].`;
        gl.uniform4fv(L(b + 'ambient'), l.ambient);
        gl.uniform4fv(L(b + 'diffuse'), l.diffuse);
        gl.uniform4fv(L(b + 'specular'), l.specular);
        gl.uniform4fv(L(b + 'position'), l.position);
        gl.uniform3fv(L(b + 'spotDirection'), l.spotDirection);
        gl.uniform1f(L(b + 'spotExponent'), l.spotExponent);
        gl.uniform1f(L(b + 'spotCosCutoff'), Math.cos((l.spotCutoff * Math.PI) / 180));
        gl.uniform3fv(L(b + 'attenuation'), l.attenuation);
      });
      for (const [name, m] of [['u_front', ff.front], ['u_back', ff.back]] as const) {
        gl.uniform4fv(L(`${name}.ambient`), m.ambient);
        gl.uniform4fv(L(`${name}.diffuse`), m.diffuse);
        gl.uniform4fv(L(`${name}.specular`), m.specular);
        gl.uniform4fv(L(`${name}.emission`), m.emission);
        gl.uniform1f(L(`${name}.shininess`), m.shininess);
      }
      gl.uniform4fv(L('u_lightModelAmbient'), ff.lightModelAmbient);
    }
    for (let u = 0; u < FF_TEXTURE_UNITS; u++) {
      if (!units[u] || !ff.units[u].enabled) continue;
      gl.uniform1i(L(`u_tex${u}`), u);
      gl.uniformMatrix4fv(L(`u_tm${u}`), false, ff.texture[u][ff.texture[u].length - 1]);
      gl.uniform4fv(L(`u_envColor${u}`), ff.units[u].envColor);
      const cs = L(`u_combineScale${u}`);
      if (cs) gl.uniform2f(cs, ff.units[u].rgbScale, ff.units[u].alphaScale);
      if (ff.units[u].texGen) {
        gl.uniform4fv(L(`u_objPlane${u}`), concat(ff.units[u].objectPlane));
        gl.uniform4fv(L(`u_eyePlane${u}`), concat(ff.units[u].eyePlane));
      }
    }
    if (ff.fog) {
      gl.uniform4fv(L('u_fogColor'), ff.fogColor);
      gl.uniform3f(L('u_fogParams'), ff.fogDensity, ff.fogStart, ff.fogEnd);
    }
    if (ff.alphaTest) gl.uniform1f(L('u_alphaRef'), ff.alphaRef);
    if (ff.clipEnabled) gl.uniform4fv(L('u_clipPlane'), concat(ff.clipPlanes));
  }

  /** Current values for the fixed-function attribute slots a draw doesn't feed from arrays. */
  private setConstantAttribs(c: Ctx) {
    const gl = this.gl;
    const cur = c.ff.current;
    const slots = this.programAttribSlots(c);
    const a = c.vao.attribs;
    if (slots.Normal >= 0 && !a[slots.Normal].enabled) gl.vertexAttrib4f(slots.Normal, cur.normal[0], cur.normal[1], cur.normal[2], 1);
    if (slots.Color >= 0 && !a[slots.Color].enabled) gl.vertexAttrib4fv(slots.Color, cur.color);
    if (slots.SecondaryColor >= 0 && !a[slots.SecondaryColor].enabled) gl.vertexAttrib4fv(slots.SecondaryColor, cur.secondaryColor);
    if (slots.FogCoord >= 0 && !a[slots.FogCoord].enabled) gl.vertexAttrib1f(slots.FogCoord, cur.fogCoord);
    for (let u = 0; u < FF_TEXTURE_UNITS; u++) if (slots.TexCoord[u] >= 0 && !a[slots.TexCoord[u]].enabled) gl.vertexAttrib4fv(slots.TexCoord[u], cur.texCoord[u]);
  }

  // ── display lists ──

  glGenLists(range: number, first: number) {
    const c = this.cur; if (!c) return;
    for (let i = 0; i < range; i++) c.share.lists.set(first + i, { cmds: [] });
  }
  glNewList(list: number, mode: number) {
    const c = this.cur; if (!c) return;
    if (c.listCompiling) { this.error(E.INVALID_OPERATION); return; }
    c.listCompiling = list;
    c.listMode = mode;
    c.listCmds = [];
  }
  glEndList() {
    const c = this.cur; if (!c) return;
    if (!c.listCompiling) { this.error(E.INVALID_OPERATION); return; }
    c.share.lists.set(c.listCompiling, { cmds: c.listCmds });
    c.listCompiling = 0;
    c.listCmds = [];
  }
  glCallList(list: number) { this.callList(list, 0); }
  private callList(list: number, depth: number) {
    const c = this.cur; if (!c || depth > 64) return;
    const l = c.share.lists.get(list);
    if (!l) return;
    for (const { op, args } of l.cmds) {
      const name = OPS[op][0];
      if (name === 'glCallList') { this.callList(args[0] as number, depth + 1); continue; }
      if (name === 'glCallLists') { this.callLists(args[0] as number, args[1] as number, args[2] as Uint8Array, depth + 1); continue; }
      this.handlers[op]?.(args);
    }
  }
  glCallLists(n: number, type: number, lists: Uint8Array) { this.callLists(n, type, lists, 0); }
  private callLists(n: number, type: number, lists: Uint8Array, depth: number) {
    const c = this.cur; if (!c || !lists) return;
    const dv = new DataView(lists.buffer, lists.byteOffset, lists.byteLength);
    for (let i = 0; i < n; i++) {
      let id: number;
      switch (type) {
        case E.BYTE: id = dv.getInt8(i); break;
        case E.UNSIGNED_BYTE: id = dv.getUint8(i); break;
        case E.SHORT: id = dv.getInt16(i * 2, true); break;
        case E.UNSIGNED_SHORT: id = dv.getUint16(i * 2, true); break;
        case E.INT: id = dv.getInt32(i * 4, true); break;
        case E.FLOAT: id = dv.getFloat32(i * 4, true); break;
        case E._2_BYTES: id = (dv.getUint8(i * 2) << 8) | dv.getUint8(i * 2 + 1); break;
        case E._3_BYTES: id = (dv.getUint8(i * 3) << 16) | (dv.getUint8(i * 3 + 1) << 8) | dv.getUint8(i * 3 + 2); break;
        default: id = dv.getUint32(i * 4, true);
      }
      this.callList(c.listBase + id, depth);
    }
  }
  glListBase(base: number) { const c = this.cur; if (c) c.listBase = base; }
  glDeleteLists(list: number, range: number) {
    const c = this.cur; if (!c) return;
    for (let i = 0; i < range; i++) c.share.lists.delete(list + i);
  }
  glIsList(list: number): Uint8Array { return u32s(this.cur?.share.lists.has(list) ? 1 : 0); }

  // ── attribute stacks (the parts apps use around their own drawing) ──

  glPushAttrib(_mask: number) {
    const c = this.cur; if (!c) return;
    c.attribStack.push(snapshot(c));
  }
  glPopAttrib() {
    const c = this.cur; if (!c) return;
    const s = c.attribStack.pop() as ReturnType<typeof snapshot> | undefined;
    if (!s) { this.error(E.STACK_UNDERFLOW); return; }
    restore(c, s);
    this.applyAll(c);
  }
  glPushClientAttrib() { this.cur?.clientAttribStack.push(null); }
  glPopClientAttrib() { this.cur?.clientAttribStack.pop(); }

  // ── textures ──

  glActiveTexture(unit: number) {
    const c = this.cur; if (!c) return;
    c.activeUnit = unit - E.TEXTURE0;
    c.ff.activeTexture = Math.min(c.activeUnit, FF_TEXTURE_UNITS - 1);
    this.gl.activeTexture(unit);
  }
  glClientActiveTexture(unit: number) { const c = this.cur; if (c) c.ff.clientActiveTexture = unit - E.TEXTURE0; }
  glGenTextures(names: Uint32Array) { for (const n of names) this.texObj(n, 0); }
  private texObj(name: number, target: number): Tex | null {
    const c = this.cur; if (!c) return null;
    let t = c.share.textures.get(name);
    if (!t) {
      t = { tex: this.gl.createTexture()!, target, webglTarget: target ? webglTarget(target) : 0, levels: [], immutable: false, params: new Map() };
      c.share.textures.set(name, t);
    }
    if (!t.target && target) {
      t.target = target; t.webglTarget = webglTarget(target);
      // GL's default minification filter needs mipmaps; WebGL's is the same, but a texture without them is incomplete in both
    }
    return t;
  }
  glBindTexture(target: number, name: number) {
    const c = this.cur; if (!c) return;
    const gl = this.gl;
    if (name === 0) { c.textures[c.activeUnit].delete(target); gl.bindTexture(webglTarget(target), null); return; }
    const t = this.texObj(name, target)!;
    c.textures[c.activeUnit].set(target, name);
    gl.bindTexture(t.webglTarget || webglTarget(target), t.tex);
    if (target === E.TEXTURE_1D || target === E.TEXTURE_RECTANGLE) this.ensureSampling(t);
  }
  private ensureSampling(t: Tex) {
    // 1D and rectangle textures are 2D here; rectangles never mipmap
    if (t.target === E.TEXTURE_RECTANGLE && !t.params.has(E.TEXTURE_MIN_FILTER)) {
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      t.params.set(E.TEXTURE_MIN_FILTER, E.LINEAR);
    }
  }
  glDeleteTextures(n: number, names: Uint32Array) {
    const c = this.cur; if (!c || !names) return;
    for (const name of names.subarray(0, n)) {
      const t = c.share.textures.get(name);
      if (!t) continue;
      this.gl.deleteTexture(t.tex);
      c.share.textures.delete(name);
      for (const unit of c.textures) for (const [k, v] of unit) if (v === name) unit.delete(k);
    }
  }
  glIsTexture(name: number): Uint8Array { return u32s(this.cur?.share.textures.has(name) ? 1 : 0); }
  glAreTexturesResident(): Uint8Array { return u32s(1); }
  glPrioritizeTextures() { /* no residency here */ }

  private boundTex(target: number): Tex | null {
    const c = this.cur; if (!c) return null;
    const base = target >= E.TEXTURE_CUBE_MAP_POSITIVE_X && target <= E.TEXTURE_CUBE_MAP_NEGATIVE_Z ? E.TEXTURE_CUBE_MAP
      : target === E.PROXY_TEXTURE_2D ? 0 : target;
    const name = c.textures[c.activeUnit].get(base);
    if (name === undefined) {
      // texture object 0 is a real texture in GL: give each unit/target one
      const key = -(base * 64 + c.activeUnit);
      return this.texObj(key, base) && (c.textures[c.activeUnit].set(base, key), this.gl.bindTexture(webglTarget(base), c.share.textures.get(key)!.tex), c.share.textures.get(key)!);
    }
    return c.share.textures.get(name) ?? null;
  }

  /** The client pixels of an upload, tightly packed, or a pixel unpack buffer offset. */
  private unpackSource(data: Arg, w: number, h: number, d: number, format: number, type: number): Uint8Array | BufferOffset | null {
    const c = this.cur!;
    if (data instanceof BufferOffset) return data;
    if (!data) return null;
    const bytes = new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    return tighten(bytes, c.unpack, w, h, d, format, type);
  }

  glTexImage1D(target: number, level: number, ifmt: number, w: number, border: number, format: number, type: number, data: Arg) {
    if (target === E.PROXY_TEXTURE_1D) return;
    this.texImage(E.TEXTURE_1D, E.TEXTURE_2D, level, ifmt, w, 1, 1, border, format, type, data);
  }
  glTexImage2D(target: number, level: number, ifmt: number, w: number, h: number, border: number, format: number, type: number, data: Arg) {
    if (target === E.PROXY_TEXTURE_2D || target === E.PROXY_TEXTURE_CUBE_MAP || target === E.PROXY_TEXTURE_RECTANGLE) return;
    this.texImage(target, target === E.TEXTURE_RECTANGLE ? E.TEXTURE_2D : target, level, ifmt, w, h, 1, border, format, type, data);
  }
  glTexImage3D(target: number, level: number, ifmt: number, w: number, h: number, d: number, border: number, format: number, type: number, data: Arg) {
    if (target === E.PROXY_TEXTURE_3D || target === E.PROXY_TEXTURE_2D_ARRAY) return;
    this.texImage(target, target, level, ifmt, w, h, d, border, format, type, data);
  }
  private texImage(glTarget: number, wTarget: number, level: number, ifmt: number, w: number, h: number, d: number, _border: number, format: number, type: number, data: Arg) {
    const c = this.cur; if (!c) return;
    const gl = this.gl;
    const t = this.boundTex(glTarget);
    if (!t) { this.error(E.INVALID_OPERATION); return; }
    if (t.immutable) { this.error(E.INVALID_OPERATION); return; }
    const tf = texFormat(ifmt, format, type);
    const face = glTarget >= E.TEXTURE_CUBE_MAP_POSITIVE_X && glTarget <= E.TEXTURE_CUBE_MAP_NEGATIVE_Z ? glTarget - E.TEXTURE_CUBE_MAP_POSITIVE_X : 0;
    t.levels[level * 6 + face] = { w, h, d, fmt: tf, internal: ifmt };
    if (level === 0 && !face) t.levels[0] = { w, h, d, fmt: tf, internal: ifmt };
    const target = glTarget >= E.TEXTURE_CUBE_MAP_POSITIVE_X && glTarget <= E.TEXTURE_CUBE_MAP_NEGATIVE_Z ? glTarget : wTarget;
    const src = this.unpackSource(data, w, h, d, format, type);
    const is3D = wTarget === E.TEXTURE_3D || wTarget === E.TEXTURE_2D_ARRAY;
    if (src instanceof BufferOffset) {
      this.withUnpackState(c, () => {
        if (is3D) gl.texImage3D(target, level, tf.internal, w, h, d, 0, format, type, src.offset);
        else gl.texImage2D(target, level, tf.internal, w, h, 0, format, type, src.offset);
      });
      return;
    }
    const up = src ? convertForUpload(tf, src, w * h * d, format, type) : { format: tf.format, type: tf.type, data: null };
    if (is3D) gl.texImage3D(target, level, tf.internal, w, h, d, 0, up.format, up.type, up.data);
    else gl.texImage2D(target, level, tf.internal, w, h, 0, up.format, up.type, up.data);
    if (t.params.get(E.GENERATE_MIPMAP) && level === 0) gl.generateMipmap(wTarget);
  }
  glTexSubImage1D(target: number, level: number, x: number, w: number, format: number, type: number, data: Arg) {
    this.texSubImage(E.TEXTURE_1D, level, x, 0, 0, w, 1, 1, format, type, data);
  }
  glTexSubImage2D(target: number, level: number, x: number, y: number, w: number, h: number, format: number, type: number, data: Arg) {
    this.texSubImage(target, level, x, y, 0, w, h, 1, format, type, data);
  }
  glTexSubImage3D(target: number, level: number, x: number, y: number, z: number, w: number, h: number, d: number, format: number, type: number, data: Arg) {
    this.texSubImage(target, level, x, y, z, w, h, d, format, type, data);
  }
  private texSubImage(glTarget: number, level: number, x: number, y: number, z: number, w: number, h: number, d: number, format: number, type: number, data: Arg) {
    const c = this.cur; if (!c) return;
    const gl = this.gl;
    const t = this.boundTex(glTarget);
    if (!t) { this.error(E.INVALID_OPERATION); return; }
    const face = glTarget >= E.TEXTURE_CUBE_MAP_POSITIVE_X && glTarget <= E.TEXTURE_CUBE_MAP_NEGATIVE_Z ? glTarget - E.TEXTURE_CUBE_MAP_POSITIVE_X : 0;
    const lv = t.levels[level * 6 + face] ?? t.levels[level];
    const tf = lv?.fmt ?? texFormat(format, format, type);
    const target = face || glTarget === E.TEXTURE_CUBE_MAP_POSITIVE_X ? glTarget : t.webglTarget;
    const is3D = t.webglTarget === E.TEXTURE_3D || t.webglTarget === E.TEXTURE_2D_ARRAY;
    const src = this.unpackSource(data, w, h, d, format, type);
    if (src instanceof BufferOffset) {
      this.withUnpackState(c, () => {
        if (is3D) gl.texSubImage3D(target, level, x, y, z, w, h, d, format, type, src.offset);
        else gl.texSubImage2D(target, level, x, y, w, h, format, type, src.offset);
      });
      return;
    }
    if (!src) return;
    const up = convertForUpload(tf, src, w * h * d, format, type);
    if (is3D) gl.texSubImage3D(target, level, x, y, z, w, h, d, up.format, up.type, up.data);
    else gl.texSubImage2D(target, level, x, y, w, h, up.format, up.type, up.data);
    if (t.params.get(E.GENERATE_MIPMAP) && level === 0) gl.generateMipmap(t.webglTarget);
  }
  private withUnpackState(c: Ctx, f: () => void) {
    const gl = this.gl, u = c.unpack;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, u.alignment); gl.pixelStorei(gl.UNPACK_ROW_LENGTH, u.rowLength);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, u.skipPixels); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, u.skipRows);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, u.imageHeight); gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, u.skipImages);
    try { f(); } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0); gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    }
  }
  glTexStorage2D(target: number, levels: number, ifmt: number, w: number, h: number) {
    const t = this.boundTex(target); if (!t) return;
    const tf = texFormat(ifmt, 0, 0);
    this.gl.texStorage2D(t.webglTarget, levels, tf.internal, w, h);
    for (let l = 0; l < levels; l++) t.levels[l * 6] = { w: Math.max(1, w >> l), h: Math.max(1, h >> l), d: 1, fmt: tf, internal: ifmt };
    t.immutable = true;
  }
  glTexStorage3D(target: number, levels: number, ifmt: number, w: number, h: number, d: number) {
    const t = this.boundTex(target); if (!t) return;
    const tf = texFormat(ifmt, 0, 0);
    this.gl.texStorage3D(t.webglTarget, levels, tf.internal, w, h, d);
    for (let l = 0; l < levels; l++) t.levels[l * 6] = { w: Math.max(1, w >> l), h: Math.max(1, h >> l), d, fmt: tf, internal: ifmt };
    t.immutable = true;
  }
  glTexStorage1D(target: number, levels: number, ifmt: number, w: number) { this.glTexStorage2D(target === E.TEXTURE_1D ? E.TEXTURE_1D : target, levels, ifmt, w, 1); }
  glCompressedTexImage2D(target: number, level: number, ifmt: number, w: number, h: number, _border: number, _size: number, data: Arg) {
    const t = this.boundTex(target); if (!t) return;
    const gl = this.gl;
    t.levels[level * 6] = { w, h, d: 1, fmt: { internal: ifmt, format: 0, type: 0, base: 'rgba', bits: [8, 8, 8, 8, 0, 0] }, internal: ifmt };
    if (data instanceof BufferOffset) { this.warnOnce('compressed uploads from a pixel unpack buffer'); return; }
    if (!this.ext.WEBGL_compressed_texture_s3tc) { this.warnOnce('compressed textures are not supported by this browser'); return; }
    gl.compressedTexImage2D(target === E.TEXTURE_RECTANGLE ? E.TEXTURE_2D : target, level, ifmt, w, h, 0, data as ArrayBufferView);
  }
  glCompressedTexSubImage2D(target: number, level: number, x: number, y: number, w: number, h: number, format: number, _size: number, data: Arg) {
    if (!this.ext.WEBGL_compressed_texture_s3tc || data instanceof BufferOffset || !data) return;
    this.gl.compressedTexSubImage2D(target, level, x, y, w, h, format, data as ArrayBufferView);
  }
  glCopyTexImage2D(target: number, level: number, ifmt: number, x: number, y: number, w: number, h: number, _border: number) {
    const t = this.boundTex(target); if (!t) return;
    const tf = texFormat(ifmt, E.RGBA, E.UNSIGNED_BYTE);
    t.levels[level * 6] = { w, h, d: 1, fmt: tf, internal: ifmt };
    // WebGL copies only into formats matching the framebuffer's: copy via RGBA8 when it differs
    const internal = tf.internal === E.RGB8 || tf.internal === E.RGBA8 || tf.internal === E.LUMINANCE || tf.internal === E.ALPHA || tf.internal === E.LUMINANCE_ALPHA ? tf.internal : E.RGBA8;
    this.gl.copyTexImage2D(target === E.TEXTURE_RECTANGLE ? E.TEXTURE_2D : target, level, internal, x, y, w, h, 0);
  }
  glCopyTexSubImage2D(target: number, level: number, xo: number, yo: number, x: number, y: number, w: number, h: number) {
    this.gl.copyTexSubImage2D(target === E.TEXTURE_RECTANGLE ? E.TEXTURE_2D : target, level, xo, yo, x, y, w, h);
  }
  glCopyTexSubImage3D(target: number, level: number, xo: number, yo: number, zo: number, x: number, y: number, w: number, h: number) {
    this.gl.copyTexSubImage3D(target, level, xo, yo, zo, x, y, w, h);
  }
  glGenerateMipmap(target: number) { const t = this.boundTex(target); if (t) this.gl.generateMipmap(t.webglTarget); }

  glTexParameteri(target: number, pname: number, v: number) { this.texParam(target, pname, [v]); }
  glTexParameterf(target: number, pname: number, v: number) { this.texParam(target, pname, [v]); }
  glTexParameteriv(target: number, pname: number, v: Int32Array) { this.texParam(target, pname, Array.from(v)); }
  glTexParameterfv(target: number, pname: number, v: Float32Array) { this.texParam(target, pname, Array.from(v)); }
  glTexParameterIiv(target: number, pname: number, v: Int32Array) { this.texParam(target, pname, Array.from(v)); }
  glTexParameterIuiv(target: number, pname: number, v: Uint32Array) { this.texParam(target, pname, Array.from(v)); }
  private texParam(target: number, pname: number, v: number[]) {
    const t = this.boundTex(target); if (!t) return;
    const gl = this.gl;
    const wt = t.webglTarget || webglTarget(target);
    t.params.set(pname, v.length > 1 ? new Float32Array(v) : v[0]);
    switch (pname) {
      case E.TEXTURE_WRAP_S: case E.TEXTURE_WRAP_T: case E.TEXTURE_WRAP_R:
        gl.texParameteri(wt, pname, wrapMode(v[0]));
        break;
      case E.TEXTURE_MIN_FILTER: case E.TEXTURE_MAG_FILTER: case E.TEXTURE_COMPARE_MODE: case E.TEXTURE_COMPARE_FUNC:
      case E.TEXTURE_BASE_LEVEL: case E.TEXTURE_MAX_LEVEL:
        gl.texParameteri(wt, pname, v[0]);
        break;
      case E.TEXTURE_MIN_LOD: case E.TEXTURE_MAX_LOD:
        gl.texParameterf(wt, pname, v[0]);
        break;
      case E.TEXTURE_MAX_ANISOTROPY:
        if (this.ext.EXT_texture_filter_anisotropic) gl.texParameterf(wt, 0x84fe, v[0]);
        break;
      case E.GENERATE_MIPMAP:
        if (v[0] && t.levels[0]) gl.generateMipmap(wt);
        break;
      case E.DEPTH_TEXTURE_MODE: case E.TEXTURE_BORDER_COLOR: case E.TEXTURE_PRIORITY: case E.TEXTURE_LOD_BIAS:
      case E.TEXTURE_SWIZZLE_R: case E.TEXTURE_SWIZZLE_G: case E.TEXTURE_SWIZZLE_B: case E.TEXTURE_SWIZZLE_A: case E.TEXTURE_SWIZZLE_RGBA:
        break;
      default:
        this.warnOnce(`glTexParameter(0x${pname.toString(16)}) is ignored`);
    }
  }

  // ── samplers ──

  glGenSamplers(names: Uint32Array) { const c = this.cur; if (!c) return; for (const n of names) c.share.samplers.set(n, this.gl.createSampler()!); }
  glDeleteSamplers(n: number, names: Uint32Array) {
    const c = this.cur; if (!c) return;
    for (const name of names.subarray(0, n)) { const s = c.share.samplers.get(name); if (s) this.gl.deleteSampler(s); c.share.samplers.delete(name); }
  }
  glBindSampler(unit: number, name: number) {
    const c = this.cur; if (!c) return;
    c.samplers[unit] = name;
    this.gl.bindSampler(unit, c.share.samplers.get(name) ?? null);
  }
  glSamplerParameteri(s: number, pname: number, v: number) { this.samplerParam(s, pname, v); }
  glSamplerParameterf(s: number, pname: number, v: number) { this.samplerParam(s, pname, v); }
  glSamplerParameteriv(s: number, pname: number, v: Int32Array) { this.samplerParam(s, pname, v[0]); }
  glSamplerParameterfv(s: number, pname: number, v: Float32Array) { this.samplerParam(s, pname, v[0]); }
  private samplerParam(s: number, pname: number, v: number) {
    const smp = this.cur?.share.samplers.get(s); if (!smp) return;
    const gl = this.gl;
    if (pname === E.TEXTURE_WRAP_S || pname === E.TEXTURE_WRAP_T || pname === E.TEXTURE_WRAP_R) gl.samplerParameteri(smp, pname, wrapMode(v));
    else if (pname === E.TEXTURE_MIN_LOD || pname === E.TEXTURE_MAX_LOD) gl.samplerParameterf(smp, pname, v);
    else if (pname === E.TEXTURE_MAX_ANISOTROPY) { if (this.ext.EXT_texture_filter_anisotropic) gl.samplerParameterf(smp, 0x84fe, v); }
    else if (pname === E.TEXTURE_BORDER_COLOR || pname === E.TEXTURE_LOD_BIAS) { /* no border color, no bias */ }
    else gl.samplerParameteri(smp, pname, v);
  }

  // ── buffers ──

  glGenBuffers(names: Uint32Array) { for (const n of names) this.bufferObj(n, E.ARRAY_BUFFER); }
  private bufferObj(name: number, target: number): Buf | null {
    const c = this.cur; if (!c || !name) return null;
    let b = c.share.buffers.get(name);
    if (!b) { b = { buf: this.gl.createBuffer()!, size: 0, usage: E.STATIC_DRAW, target }; c.share.buffers.set(name, b); }
    return b;
  }
  glBindBuffer(target: number, name: number) {
    const c = this.cur; if (!c) return;
    const b = this.bufferObj(name, target);
    switch (target) {
      case E.ARRAY_BUFFER: c.arrayBuffer = name; break;
      case E.ELEMENT_ARRAY_BUFFER: c.vao.element = name; break;
      case E.COPY_READ_BUFFER: c.copyRead = name; break;
      case E.COPY_WRITE_BUFFER: c.copyWrite = name; break;
      case E.PIXEL_PACK_BUFFER: c.pixelPack = name; break;
      case E.PIXEL_UNPACK_BUFFER: c.pixelUnpack = name; break;
      case E.UNIFORM_BUFFER: c.uniformBuffer = name; break;
      case E.TRANSFORM_FEEDBACK_BUFFER: c.tfBuffer = name; break;
      case E.TEXTURE_BUFFER: c.textureBuffer = name; return; // not a WebGL target
      default: this.warnOnce(`glBindBuffer(0x${target.toString(16)})`); return;
    }
    // WebGL binds a buffer to ELEMENT_ARRAY_BUFFER or to the other targets, never both
    if (b && b.size === 0 && target !== b.target) b.target = target;
    this.gl.bindBuffer(target, b?.buf ?? null);
  }
  glBindBufferBase(target: number, index: number, name: number) {
    const c = this.cur; if (!c) return;
    const b = this.bufferObj(name, target);
    if (target === E.UNIFORM_BUFFER) { c.uniformBindings[index] = [name, 0, 0]; c.uniformBuffer = name; }
    else if (target === E.TRANSFORM_FEEDBACK_BUFFER) { c.tfBindings[index] = [name, 0, 0]; c.tfBuffer = name; }
    this.gl.bindBufferBase(target, index, b?.buf ?? null);
  }
  glBindBufferRange(target: number, index: number, name: number, offset: number, size: number) {
    const c = this.cur; if (!c) return;
    const b = this.bufferObj(name, target);
    if (target === E.UNIFORM_BUFFER) { c.uniformBindings[index] = [name, offset, size]; c.uniformBuffer = name; }
    else if (target === E.TRANSFORM_FEEDBACK_BUFFER) { c.tfBindings[index] = [name, offset, size]; c.tfBuffer = name; }
    this.gl.bindBufferRange(target, index, b?.buf ?? null, offset, size);
  }
  private boundBufferName(target: number): number {
    const c = this.cur!;
    switch (target) {
      case E.ARRAY_BUFFER: return c.arrayBuffer;
      case E.ELEMENT_ARRAY_BUFFER: return c.vao.element;
      case E.COPY_READ_BUFFER: return c.copyRead;
      case E.COPY_WRITE_BUFFER: return c.copyWrite;
      case E.PIXEL_PACK_BUFFER: return c.pixelPack;
      case E.PIXEL_UNPACK_BUFFER: return c.pixelUnpack;
      case E.UNIFORM_BUFFER: return c.uniformBuffer;
      case E.TRANSFORM_FEEDBACK_BUFFER: return c.tfBuffer;
      case E.TEXTURE_BUFFER: return c.textureBuffer;
    }
    return 0;
  }
  glBufferData(target: number, size: number, data: Uint8Array | null, usage: number) {
    const c = this.cur; if (!c) return;
    const name = this.boundBufferName(target);
    const b = c.share.buffers.get(name);
    if (!b) { this.error(E.INVALID_OPERATION); return; }
    b.size = size; b.usage = usage;
    if (target === E.TEXTURE_BUFFER) return;
    const u = webglUsage(usage);
    if (data) this.gl.bufferData(target, data, u);
    else this.gl.bufferData(target, size, u);
  }
  glBufferSubData(target: number, offset: number, _size: number, data: Uint8Array | null) {
    if (!this.cur || !data || target === E.TEXTURE_BUFFER) return;
    this.gl.bufferSubData(target, offset, data);
  }
  glGetBufferSubData(target: number, offset: number, size: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, size));
    if (this.cur && size > 0 && target !== E.TEXTURE_BUFFER) this.gl.getBufferSubData(target, offset, out);
    return out;
  }
  glCopyBufferSubData(r: number, w: number, ro: number, wo: number, size: number) { this.gl.copyBufferSubData(r, w, ro, wo, size); }
  glDeleteBuffers(names: Uint32Array) {
    const c = this.cur; if (!c) return;
    for (const name of names) {
      const b = c.share.buffers.get(name);
      if (!b) continue;
      this.gl.deleteBuffer(b.buf);
      c.share.buffers.delete(name);
      if (c.arrayBuffer === name) c.arrayBuffer = 0;
      if (c.vao.element === name) c.vao.element = 0;
    }
  }
  glIsBuffer(name: number): Uint8Array { return u32s(this.cur?.share.buffers.has(name) ? 1 : 0); }
  glGetBufferParameteriv(target: number, pname: number): Uint8Array { return this.bufferParam(target, pname); }
  glGetBufferParameteri64v(target: number, pname: number): Uint8Array { return this.bufferParam(target, pname); }
  private bufferParam(target: number, pname: number): Uint8Array {
    const c = this.cur; if (!c) return f64s([0]);
    const b = c.share.buffers.get(this.boundBufferName(target));
    if (!b) return f64s([0]);
    switch (pname) {
      case E.BUFFER_SIZE: return f64s([b.size]);
      case E.BUFFER_USAGE: return f64s([b.usage]);
      case E.BUFFER_ACCESS: return f64s([E.READ_WRITE]);
      case E.BUFFER_MAPPED: return f64s([0]);
    }
    return f64s([0]);
  }

  // ── vertex arrays ──

  glGenVertexArrays(names: Uint32Array) {
    const c = this.cur; if (!c) return;
    for (const n of names) c.vaos.set(n, { vao: this.gl.createVertexArray(), element: 0, attribs: Array.from({ length: 16 }, newArray) });
  }
  glBindVertexArray(name: number) {
    const c = this.cur; if (!c) return;
    let v = c.vaos.get(name);
    if (!v) { v = { vao: this.gl.createVertexArray(), element: 0, attribs: Array.from({ length: 16 }, newArray) }; c.vaos.set(name, v); }
    c.vao = v;
    this.gl.bindVertexArray(v.vao);
  }
  glDeleteVertexArrays(names: Uint32Array) {
    const c = this.cur; if (!c) return;
    for (const n of names) {
      const v = c.vaos.get(n);
      if (!v || n === 0) continue;
      if (c.vao === v) this.glBindVertexArray(0);
      this.gl.deleteVertexArray(v.vao);
      c.vaos.delete(n);
    }
  }
  glIsVertexArray(name: number): Uint8Array { return u32s(this.cur?.vaos.has(name) && name ? 1 : 0); }
  glVertexAttribPointer(index: number, size: number, type: number, normalized: number, stride: number, offset: number) {
    this.pointer(index, size === E.BGRA ? 4 : size, type, !!normalized, stride, offset, false);
  }
  glVertexAttribIPointer(index: number, size: number, type: number, stride: number, offset: number) {
    this.pointer(index, size, type, false, stride, offset, true);
  }
  glVertexPointer(size: number, type: number, stride: number, offset: number) { this.pointer(ATTR.Vertex, size, type, false, stride, offset, false); }
  glNormalPointer(type: number, stride: number, offset: number) { this.pointer(ATTR.Normal, 3, type, type !== E.FLOAT && type !== E.DOUBLE, stride, offset, false); }
  glColorPointer(size: number, type: number, stride: number, offset: number) { this.pointer(ATTR.Color, size, type, type !== E.FLOAT && type !== E.DOUBLE, stride, offset, false); }
  glSecondaryColorPointer(size: number, type: number, stride: number, offset: number) { this.pointer(ATTR.SecondaryColor, size, type, type !== E.FLOAT && type !== E.DOUBLE, stride, offset, false); }
  glFogCoordPointer(type: number, stride: number, offset: number) { this.pointer(ATTR.FogCoord, 1, type, false, stride, offset, false); }
  glTexCoordPointer(size: number, type: number, stride: number, offset: number) {
    const c = this.cur; if (!c) return;
    this.pointer(ATTR.TexCoord0 + Math.min(c.ff.clientActiveTexture, FF_TEXTURE_UNITS - 1), size, type, false, stride, offset, false);
  }
  private pointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number, integer: boolean) {
    const c = this.cur; if (!c) return;
    if (index >= 16) { this.error(E.INVALID_VALUE); return; }
    const a = c.vao.attribs[index];
    Object.assign(a, { size, type, normalized, stride, offset, buffer: c.arrayBuffer, integer });
    if (!c.arrayBuffer) { this.warnOnce('client-side vertex arrays are not supported yet'); return; }
    if (type === E.DOUBLE) { this.warnOnce('double vertex attributes are not supported'); return; }
    if (integer) this.gl.vertexAttribIPointer(index, size, type, stride, offset);
    else this.gl.vertexAttribPointer(index, size, type, normalized, stride, offset);
  }
  glEnableVertexAttribArray(i: number) { const c = this.cur; if (!c || i >= 16) return; c.vao.attribs[i].enabled = true; this.gl.enableVertexAttribArray(i); }
  glDisableVertexAttribArray(i: number) { const c = this.cur; if (!c || i >= 16) return; c.vao.attribs[i].enabled = false; this.gl.disableVertexAttribArray(i); }
  glEnableClientState(a: number) { const s = this.clientSlot(a); if (s >= 0) this.glEnableVertexAttribArray(s); }
  glDisableClientState(a: number) { const s = this.clientSlot(a); if (s >= 0) this.glDisableVertexAttribArray(s); }
  private clientSlot(a: number): number {
    const c = this.cur; if (!c) return -1;
    switch (a) {
      case E.VERTEX_ARRAY: return ATTR.Vertex;
      case E.NORMAL_ARRAY: return ATTR.Normal;
      case E.COLOR_ARRAY: return ATTR.Color;
      case E.SECONDARY_COLOR_ARRAY: return ATTR.SecondaryColor;
      case E.FOG_COORD_ARRAY: return ATTR.FogCoord;
      case E.TEXTURE_COORD_ARRAY: return ATTR.TexCoord0 + Math.min(c.ff.clientActiveTexture, FF_TEXTURE_UNITS - 1);
    }
    return -1;
  }
  glVertexAttribDivisor(i: number, d: number) { const c = this.cur; if (!c) return; c.vao.attribs[i].divisor = d; this.gl.vertexAttribDivisor(i, d); }

  // ── draws ──

  glDrawArrays(mode: number, first: number, count: number) { this.drawArrays(mode, first, count, 0); }
  glDrawArraysInstanced(mode: number, first: number, count: number, inst: number) { this.drawArrays(mode, first, count, inst); }
  private drawArrays(mode: number, first: number, count: number, instances: number) {
    const c = this.cur; if (!c || count <= 0) return;
    const gl = this.gl;
    const prim = toWebGLPrimitive(mode, count, c.polygonMode[0], first);
    if (!prim) return;
    this.setConstantAttribs(c);
    if (!this.prepareDraw(c, prim.mode === gl.POINTS)) return;
    if (prim.indices) this.drawTempIndices(c, prim.mode, prim.indices, instances);
    else if (instances) gl.drawArraysInstanced(prim.mode, first, count, instances);
    else gl.drawArrays(prim.mode, first, count);
    this.finishDraw(c);
  }
  private drawTempIndices(c: Ctx, mode: number, indices: Uint32Array, instances: number, baseVertex = 0) {
    const gl = this.gl;
    if (baseVertex) for (let i = 0; i < indices.length; i++) indices[i] += baseVertex;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.immIndex);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STREAM_DRAW);
    if (instances) gl.drawElementsInstanced(mode, indices.length, gl.UNSIGNED_INT, 0, instances);
    else gl.drawElements(mode, indices.length, gl.UNSIGNED_INT, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufObj(c.vao.element));
  }
  glDrawElements(mode: number, count: number, type: number, offset: number) { this.drawElements(mode, count, type, offset, 0, 0); }
  glDrawElementsInstanced(mode: number, count: number, type: number, offset: number, inst: number) { this.drawElements(mode, count, type, offset, inst, 0); }
  glDrawElementsBaseVertex(mode: number, count: number, type: number, offset: number, base: number) { this.drawElements(mode, count, type, offset, 0, base); }
  glDrawElementsInstancedBaseVertex(mode: number, count: number, type: number, offset: number, inst: number, base: number) { this.drawElements(mode, count, type, offset, inst, base); }
  glDrawRangeElements(mode: number, _s: number, _e: number, count: number, type: number, offset: number) { this.drawElements(mode, count, type, offset, 0, 0); }
  glDrawRangeElementsBaseVertex(mode: number, _s: number, _e: number, count: number, type: number, offset: number, base: number) { this.drawElements(mode, count, type, offset, 0, base); }
  private drawElements(mode: number, count: number, type: number, offset: number, instances: number, baseVertex: number) {
    const c = this.cur; if (!c || count <= 0) return;
    const gl = this.gl;
    if (!c.vao.element) { this.warnOnce('glDrawElements with client-side indices is not supported yet'); return; }
    const native = mode <= E.TRIANGLE_FAN && !(c.polygonMode[0] !== E.FILL && mode >= E.TRIANGLES);
    const restartFix = c.primitiveRestart && c.restartIndex !== maxIndex(type);
    this.setConstantAttribs(c);
    if (native && !baseVertex && !restartFix) {
      if (!this.prepareDraw(c, mode === gl.POINTS)) return;
      if (instances) gl.drawElementsInstanced(mode, count, type, offset, instances);
      else gl.drawElements(mode, count, type, offset);
      this.finishDraw(c);
      return;
    }
    // quads, polygons, line modes, base vertex: read the indices back and rewrite them
    const size = type === E.UNSIGNED_BYTE ? 1 : type === E.UNSIGNED_SHORT ? 2 : 4;
    const raw = new Uint8Array(count * size);
    gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset, raw);
    const idx = size === 1 ? Uint32Array.from(raw) : size === 2 ? Uint32Array.from(new Uint16Array(raw.buffer)) : new Uint32Array(raw.buffer);
    const prim = toWebGLPrimitive(mode, count, c.polygonMode[0], 0, idx);
    if (!prim) return;
    if (!this.prepareDraw(c, prim.mode === gl.POINTS)) return;
    this.drawTempIndices(c, prim.mode, prim.indices ?? idx.slice(), instances, baseVertex);
    this.finishDraw(c);
  }
  glMultiDrawArrays() { this.warnOnce('glMultiDrawArrays arrives as separate draws'); }

  // ── shaders and programs ──

  glCreateShader(type: number, name: number) {
    const c = this.cur; if (!c) return;
    c.share.objects.set(name, { kind: 'shader', type, sh: null, source: '', translated: null, compiled: false, log: '' });
  }
  glCreateProgram(name: number) {
    const c = this.cur; if (!c) return;
    c.share.objects.set(name, {
      kind: 'program', prog: this.gl.createProgram()!, shaders: new Set(), linked: false, linkLog: '', infoReady: false,
      attribs: [], uniforms: [], blocks: [], locs: [], bindings: new Map(), fragData: new Map(), tfVaryings: [], tfMode: E.INTERLEAVED_ATTRIBS,
      builtins: new Map(), builtinAttribs: new Map(),
    });
  }
  private shaderObj(name: number): ShaderObj | null { const o = this.cur?.share.objects.get(name); return o?.kind === 'shader' ? o : null; }
  private progObj(name: number): ProgObj | null { const o = this.cur?.share.objects.get(name); return o?.kind === 'program' ? o : null; }
  glShaderSource(name: number, src: Uint8Array | null) {
    const s = this.shaderObj(name); if (!s) { this.error(E.INVALID_VALUE); return; }
    s.source = src ? new TextDecoder().decode(src) : '';
  }
  glCompileShader(name: number) {
    const s = this.shaderObj(name); if (!s) { this.error(E.INVALID_VALUE); return; }
    const c = this.cur!;
    s.translated = translateShader(s.source, s.type === E.VERTEX_SHADER ? 'vertex' : s.type === E.FRAGMENT_SHADER ? 'fragment' : 'geometry', { core: c.core });
    s.compiled = s.translated.ok;
    s.log = s.translated.log;
    // WebGL compiles at link time here: a fragment shader's outputs depend on glBindFragDataLocation
  }
  glDeleteShader(name: number) {
    const c = this.cur; if (!c) return;
    const s = this.shaderObj(name);
    if (s?.sh) this.gl.deleteShader(s.sh);
    c.share.objects.delete(name);
  }
  glAttachShader(p: number, s: number) { this.progObj(p)?.shaders.add(s); }
  glDetachShader(p: number, s: number) { this.progObj(p)?.shaders.delete(s); }
  glBindAttribLocation(p: number, index: number, name: string) { this.progObj(p)?.bindings.set(name, index); }
  glBindFragDataLocation(p: number, color: number, name: string) { this.progObj(p)?.fragData.set(name, color); }
  glTransformFeedbackVaryings(p: number, count: number, names: Uint8Array, mode: number) {
    const o = this.progObj(p); if (!o) return;
    o.tfVaryings = new TextDecoder().decode(names).split('\0').filter((x) => x).slice(0, count);
    o.tfMode = mode;
  }
  glLinkProgram(name: number) {
    const o = this.progObj(name); if (!o) { this.error(E.INVALID_VALUE); return; }
    const c = this.cur!;
    const gl = this.gl;
    // fresh WebGL program each link: attached shaders are compiled with the program's bindings
    gl.deleteProgram(o.prog);
    o.prog = gl.createProgram()!;
    o.linked = false; o.infoReady = false; o.linkLog = '';
    o.builtins = new Map(); o.builtinAttribs = new Map();
    const sources: ShaderObj[] = [];
    for (const sn of o.shaders) { const s = this.shaderObj(sn); if (s) sources.push(s); }
    const vsList = sources.filter((s) => s.type === E.VERTEX_SHADER);
    const fsList = sources.filter((s) => s.type === E.FRAGMENT_SHADER);
    if (sources.some((s) => s.type === E.GEOMETRY_SHADER)) { o.linkLog = 'geometry shaders are not supported yet'; this.warnOnce(o.linkLog); return; }
    if (!vsList.length || !fsList.length) { o.linkLog = 'a program needs a vertex and a fragment shader here'; return; }
    if (sources.some((s) => !s.compiled)) { o.linkLog = 'a shader failed to compile'; return; }
    if (vsList.length > 1 || fsList.length > 1) { o.linkLog = 'more than one shader per stage is not supported'; return; }
    const vt = translateShader(vsList[0].source, 'vertex', { core: c.core });
    const ft = translateShader(fsList[0].source, 'fragment', { core: c.core, fragData: o.fragData });
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) o.linkLog += `${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${gl.getShaderInfoLog(s)}\n`;
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, vt.source), fs = mk(gl.FRAGMENT_SHADER, ft.source);
    gl.attachShader(o.prog, vs); gl.attachShader(o.prog, fs);
    // built-in attributes (gl_Vertex, ...) at their fixed-function slots unless the app took the slot
    const taken = new Set(o.bindings.values());
    for (const b of vt.builtinAttribs) {
      const want = b === 'Vertex' ? ATTR.Vertex : b === 'Normal' ? ATTR.Normal : b === 'Color' ? ATTR.Color : b === 'SecondaryColor' ? ATTR.SecondaryColor
        : b === 'FogCoord' ? ATTR.FogCoord : ATTR.TexCoord0 + Number(b.replace('MultiTexCoord', ''));
      let slot = want;
      if (taken.has(slot)) { slot = 0; while (taken.has(slot) && slot < 16) slot++; }
      taken.add(slot);
      o.builtinAttribs.set(b, slot);
      gl.bindAttribLocation(o.prog, slot, `_tc_${b}`);
    }
    for (const [n, i] of o.bindings) gl.bindAttribLocation(o.prog, i, n);
    if (o.tfVaryings.length) gl.transformFeedbackVaryings(o.prog, o.tfVaryings, o.tfMode === E.SEPARATE_ATTRIBS ? gl.SEPARATE_ATTRIBS : gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(o.prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    o.linked = !!gl.getProgramParameter(o.prog, gl.LINK_STATUS);
    if (!o.linked) o.linkLog += gl.getProgramInfoLog(o.prog) ?? '';
    for (const u of new Set([...vt.builtinUniforms, ...ft.builtinUniforms])) {
      const l = gl.getUniformLocation(o.prog, `_tc_${u}`);
      if (l) o.builtins.set(u, l);
    }
    if (o.linked) this.collectProgramInfo(o);
    if (c.program === name) this.useProgramInternal(name);
  }
  private collectProgramInfo(o: ProgObj) {
    const gl = this.gl;
    o.attribs = []; o.uniforms = []; o.blocks = []; o.locs = [];
    const na = gl.getProgramParameter(o.prog, gl.ACTIVE_ATTRIBUTES) as number;
    for (let i = 0; i < na; i++) {
      const a = gl.getActiveAttrib(o.prog, i);
      if (!a || a.name.startsWith('_tc_') || a.name.startsWith('gl_')) continue;
      o.attribs.push({ name: a.name, type: a.type, size: a.size, loc: gl.getAttribLocation(o.prog, a.name) });
    }
    const nu = gl.getProgramParameter(o.prog, gl.ACTIVE_UNIFORMS) as number;
    const blockIndex = nu ? (gl.getActiveUniforms(o.prog, Array.from({ length: nu }, (_, i) => i), gl.UNIFORM_BLOCK_INDEX) as number[]) : [];
    for (let i = 0; i < nu; i++) {
      const u = gl.getActiveUniform(o.prog, i);
      if (!u || u.name.startsWith('_tc_')) continue;
      if (blockIndex[i] >= 0) { o.uniforms.push({ name: u.name, type: u.type, size: u.size, loc: -1 }); continue; }
      const base = o.locs.length;
      const arrayBase = u.name.endsWith('[0]') ? u.name.slice(0, -3) : null;
      for (let k = 0; k < u.size; k++) {
        const wl = gl.getUniformLocation(o.prog, arrayBase !== null ? `${arrayBase}[${k}]` : u.name);
        o.locs.push(wl ? { wl, type: u.type } : null);
      }
      o.uniforms.push({ name: u.name, type: u.type, size: u.size, loc: base });
    }
    const nb = gl.getProgramParameter(o.prog, gl.ACTIVE_UNIFORM_BLOCKS) as number;
    for (let i = 0; i < nb; i++) {
      const name = gl.getActiveUniformBlockName(o.prog, i) ?? '';
      const size = gl.getActiveUniformBlockParameter(o.prog, i, gl.UNIFORM_BLOCK_DATA_SIZE) as number;
      o.blocks.push({ name, type: 0, size, loc: i });
    }
    o.infoReady = true;
  }
  glGetProgramInfo(name: number): Uint8Array {
    const o = this.progObj(name);
    const w = new ReplyWriter();
    if (!o) { w.u32(0).str('no such program').u32(0).u32(0).u32(0); return w.finish(); }
    w.u32(o.linked ? 1 : 0).str(o.linkLog);
    for (const list of [o.attribs, o.uniforms, o.blocks]) {
      w.u32(list.length);
      for (const v of list) w.u32(v.type).i32(v.size).i32(v.loc).str(v.name);
    }
    return w.finish();
  }
  glGetShaderInfo(name: number): Uint8Array {
    const s = this.shaderObj(name);
    const w = new ReplyWriter();
    w.u32(s?.compiled ? 1 : 0).str(s?.log ?? 'no such shader');
    return w.finish();
  }
  glUseProgram(name: number) {
    const c = this.cur; if (!c) return;
    c.program = name;
    this.useProgramInternal(name);
  }
  private useProgramInternal(name: number) {
    const o = name ? this.progObj(name) : null;
    this.gl.useProgram(o?.linked ? o.prog : null);
  }
  glDeleteProgram(name: number) {
    const c = this.cur; if (!c) return;
    const o = this.progObj(name);
    if (o) this.gl.deleteProgram(o.prog);
    c.share.objects.delete(name);
    if (c.program === name) c.program = 0;
  }
  glValidateProgram() { /* validation status follows the link status */ }
  glUniformBlockBinding(p: number, index: number, binding: number) {
    const o = this.progObj(p); if (!o || !o.linked) return;
    this.gl.uniformBlockBinding(o.prog, index, binding);
  }

  private uniform(args: Arg[], matrix: boolean, n: number, m: number, type: string, vec: boolean) {
    const c = this.cur; if (!c || !c.program) return;
    const o = this.progObj(c.program);
    if (!o || !o.linked) return;
    const loc = args[0] as number;
    if (loc < 0) return;
    const l = o.locs[loc];
    if (!l) { this.error(E.INVALID_OPERATION); return; }
    const gl = this.gl;
    if (matrix) {
      const transpose = !!args[2];
      let v = args[3] as Float32Array | Float64Array;
      if (v instanceof Float64Array) v = Float32Array.from(v) as Float32Array;
      const f = v as Float32Array;
      const cols = n, rows = m || n;
      const key = cols === rows ? `uniformMatrix${n}fv` : `uniformMatrix${cols}x${rows}fv`;
      (gl as unknown as Record<string, (l: WebGLUniformLocation, t: boolean, v: Float32Array) => void>)[key].call(gl, l.wl, transpose, f);
      return;
    }
    const isSampler = isSamplerType(l.type);
    if (vec) {
      let v = args[2] as ArrayBufferView;
      if (type === 'd') v = Float32Array.from(v as Float64Array);
      const fn = `uniform${n}${type === 'ui' ? 'ui' : type === 'i' ? 'i' : 'f'}v`;
      (gl as unknown as Record<string, (l: WebGLUniformLocation, v: ArrayBufferView) => void>)[fn].call(gl, l.wl, v);
      return;
    }
    const vals = (args as number[]).slice(1, 1 + n);
    let kind = type === 'ui' ? 'ui' : type === 'i' ? 'i' : 'f';
    if (isSampler) kind = 'i';
    // GL converts between bool, int and float uniform calls loosely; WebGL wants the matching call
    if (kind === 'f' && isIntType(l.type)) kind = 'i';
    if (kind === 'i' && isFloatType(l.type)) kind = 'f';
    const fn = `uniform${n}${kind}`;
    (gl as unknown as Record<string, (l: WebGLUniformLocation, ...v: number[]) => void>)[fn].call(gl, l.wl, ...vals);
  }

  /** gl_ModelViewMatrix & co. for an app program in the compatibility profile. */
  private setBuiltinUniforms(c: Ctx, p: ProgObj) {
    const gl = this.gl;
    const ff = c.ff;
    for (const [name, l] of p.builtins) {
      switch (name) {
        case 'ModelViewMatrix': gl.uniformMatrix4fv(l, false, ff.mv); break;
        case 'ProjectionMatrix': gl.uniformMatrix4fv(l, false, ff.proj); break;
        case 'ModelViewProjectionMatrix': gl.uniformMatrix4fv(l, false, mul(new Float32Array(16), ff.proj, ff.mv)); break;
        case 'NormalMatrix': gl.uniformMatrix3fv(l, false, normalMatrix(ff.mv)); break;
        case 'ModelViewMatrixInverse': gl.uniformMatrix4fv(l, false, invert(ff.mv)); break;
        case 'ProjectionMatrixInverse': gl.uniformMatrix4fv(l, false, invert(ff.proj)); break;
        case 'ModelViewMatrixTranspose': gl.uniformMatrix4fv(l, true, ff.mv); break;
        case 'ModelViewMatrixInverseTranspose': gl.uniformMatrix4fv(l, true, invert(ff.mv)); break;
        case 'ModelViewProjectionMatrixInverse': gl.uniformMatrix4fv(l, false, invert(mul(new Float32Array(16), ff.proj, ff.mv))); break;
        case 'TextureMatrix': gl.uniformMatrix4fv(l, false, concat(ff.texture.map((s) => s[s.length - 1]))); break;
        case 'FogColor': gl.uniform4fv(l, ff.fogColor); break;
        case 'FogParams': gl.uniform4f(l, ff.fogDensity, ff.fogStart, ff.fogEnd, 1 / (ff.fogEnd - ff.fogStart || 1)); break;
        case 'LightModelAmbient': gl.uniform4fv(l, ff.lightModelAmbient); break;
        case 'FrontMaterialAmbient': gl.uniform4fv(l, ff.front.ambient); break;
        case 'FrontMaterialDiffuse': gl.uniform4fv(l, ff.front.diffuse); break;
        case 'FrontMaterialSpecular': gl.uniform4fv(l, ff.front.specular); break;
        case 'FrontMaterialEmission': gl.uniform4fv(l, ff.front.emission); break;
        case 'FrontMaterialShininess': gl.uniform1f(l, ff.front.shininess); break;
        case 'PointSize': gl.uniform1f(l, ff.pointSize); break;
        case 'ClipPlane': gl.uniform4fv(l, concat(ff.clipPlanes)); break;
        default: {
          const lm = name.match(/^LightSource(\d)(\w+)$/);
          if (lm) {
            const li = ff.lights[+lm[1]];
            const field = lm[2];
            if (!li) break;
            if (field === 'ambient') gl.uniform4fv(l, li.ambient);
            else if (field === 'diffuse') gl.uniform4fv(l, li.diffuse);
            else if (field === 'specular') gl.uniform4fv(l, li.specular);
            else if (field === 'position') gl.uniform4fv(l, li.position);
            else if (field === 'halfVector') {
              const p = li.position; const L = [p[0], p[1], p[2]]; const len = Math.hypot(L[0], L[1], L[2]) || 1;
              const h = [L[0] / len, L[1] / len, L[2] / len + 1]; const hl = Math.hypot(h[0], h[1], h[2]) || 1;
              gl.uniform4f(l, h[0] / hl, h[1] / hl, h[2] / hl, 0);
            } else if (field === 'spotDirection') gl.uniform3fv(l, li.spotDirection);
            else if (field === 'spotExponent') gl.uniform1f(l, li.spotExponent);
            else if (field === 'spotCutoff') gl.uniform1f(l, li.spotCutoff);
            else if (field === 'spotCosCutoff') gl.uniform1f(l, Math.cos((li.spotCutoff * Math.PI) / 180));
            else if (field === 'constantAttenuation') gl.uniform1f(l, li.attenuation[0]);
            else if (field === 'linearAttenuation') gl.uniform1f(l, li.attenuation[1]);
            else if (field === 'quadraticAttenuation') gl.uniform1f(l, li.attenuation[2]);
          }
        }
      }
    }
  }

  // ── framebuffers and renderbuffers ──

  glGenFramebuffers(names: Uint32Array) { const c = this.cur; if (!c) return; for (const n of names) c.framebuffers.set(n, this.gl.createFramebuffer()!); }
  glGenRenderbuffers(names: Uint32Array) { const c = this.cur; if (!c) return; for (const n of names) c.share.renderbuffers.set(n, this.gl.createRenderbuffer()!); }
  glBindFramebuffer(target: number, name: number) {
    const c = this.cur; if (!c) return;
    if (name && !c.framebuffers.has(name)) c.framebuffers.set(name, this.gl.createFramebuffer()!);
    if (target === E.FRAMEBUFFER || target === E.DRAW_FRAMEBUFFER) { c.drawFb = name; this.bindDrawFb(c); }
    if (target === E.FRAMEBUFFER || target === E.READ_FRAMEBUFFER) { c.readFb = name; this.bindReadFb(c); }
  }
  glDeleteFramebuffers(n: number, names: Uint32Array) {
    const c = this.cur; if (!c) return;
    for (const name of names.subarray(0, n)) {
      const f = c.framebuffers.get(name);
      if (!f) continue;
      this.gl.deleteFramebuffer(f);
      c.framebuffers.delete(name);
      if (c.drawFb === name) { c.drawFb = 0; this.bindDrawFb(c); }
      if (c.readFb === name) { c.readFb = 0; this.bindReadFb(c); }
    }
  }
  glIsFramebuffer(name: number): Uint8Array { return u32s(this.cur?.framebuffers.has(name) ? 1 : 0); }
  glBindRenderbuffer(_target: number, name: number) {
    const c = this.cur; if (!c) return;
    if (name && !c.share.renderbuffers.has(name)) c.share.renderbuffers.set(name, this.gl.createRenderbuffer()!);
    this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, name ? c.share.renderbuffers.get(name)! : null);
  }
  glDeleteRenderbuffers(n: number, names: Uint32Array) {
    const c = this.cur; if (!c) return;
    for (const name of names.subarray(0, n)) { const r = c.share.renderbuffers.get(name); if (r) this.gl.deleteRenderbuffer(r); c.share.renderbuffers.delete(name); }
  }
  glIsRenderbuffer(name: number): Uint8Array { return u32s(this.cur?.share.renderbuffers.has(name) ? 1 : 0); }
  glRenderbufferStorage(_t: number, ifmt: number, w: number, h: number) { this.gl.renderbufferStorage(this.gl.RENDERBUFFER, renderbufferFormat(ifmt), w, h); }
  glRenderbufferStorageMultisample(_t: number, samples: number, ifmt: number, w: number, h: number) {
    const gl = this.gl;
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, Math.min(samples, gl.getParameter(gl.MAX_SAMPLES) as number), renderbufferFormat(ifmt), w, h);
  }
  glFramebufferTexture2D(target: number, attachment: number, textarget: number, name: number, level: number) {
    const c = this.cur; if (!c) return;
    const t = name ? c.share.textures.get(name) : null;
    const tt = textarget === E.TEXTURE_RECTANGLE ? E.TEXTURE_2D : textarget;
    this.gl.framebufferTexture2D(fbTarget(target), attachmentOf(attachment), tt, t?.tex ?? null, level);
  }
  glFramebufferTexture(target: number, attachment: number, name: number, level: number) {
    const c = this.cur; if (!c) return;
    const t = name ? c.share.textures.get(name) : null;
    this.gl.framebufferTexture2D(fbTarget(target), attachmentOf(attachment), t ? (t.webglTarget === E.TEXTURE_CUBE_MAP ? E.TEXTURE_CUBE_MAP_POSITIVE_X : t.webglTarget) : E.TEXTURE_2D, t?.tex ?? null, level);
  }
  glFramebufferTexture1D(target: number, attachment: number, _tt: number, name: number, level: number) { this.glFramebufferTexture2D(target, attachment, E.TEXTURE_2D, name, level); }
  glFramebufferTextureLayer(target: number, attachment: number, name: number, level: number, layer: number) {
    const t = name ? this.cur?.share.textures.get(name) : null;
    this.gl.framebufferTextureLayer(fbTarget(target), attachmentOf(attachment), t?.tex ?? null, level, layer);
  }
  glFramebufferTexture3D(target: number, attachment: number, _tt: number, name: number, level: number, layer: number) { this.glFramebufferTextureLayer(target, attachment, name, level, layer); }
  glFramebufferRenderbuffer(target: number, attachment: number, _rt: number, name: number) {
    const r = name ? this.cur?.share.renderbuffers.get(name) ?? null : null;
    this.gl.framebufferRenderbuffer(fbTarget(target), attachmentOf(attachment), this.gl.RENDERBUFFER, r);
  }
  glCheckFramebufferStatus(target: number): Uint8Array { return u32s(this.cur ? this.gl.checkFramebufferStatus(fbTarget(target)) : E.FRAMEBUFFER_UNDEFINED); }
  glBlitFramebuffer(sx0: number, sy0: number, sx1: number, sy1: number, dx0: number, dy0: number, dx1: number, dy1: number, mask: number, filter: number) {
    this.gl.blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);
  }
  glInvalidateFramebuffer() { /* a hint */ }

  // ── queries and syncs ──

  glGenQueries(names: Uint32Array) { const c = this.cur; if (!c) return; for (const n of names) c.queries.set(n, { q: null, target: 0 }); }
  glDeleteQueries(n: number, names: Uint32Array) {
    const c = this.cur; if (!c) return;
    for (const name of names.subarray(0, n)) { const q = c.queries.get(name); if (q?.q) this.gl.deleteQuery(q.q); c.queries.delete(name); }
  }
  glIsQuery(name: number): Uint8Array { return u32s(this.cur?.queries.has(name) ? 1 : 0); }
  glBeginQuery(target: number, name: number) {
    const c = this.cur; if (!c) return;
    let q = c.queries.get(name);
    if (!q) { q = { q: null, target }; c.queries.set(name, q); }
    q.target = target;
    q.result = undefined;
    const wt = target === E.SAMPLES_PASSED ? this.gl.ANY_SAMPLES_PASSED : target;
    if (wt === E.TIME_ELAPSED) { q.result = 0; return; }
    if (!q.q) q.q = this.gl.createQuery()!;
    this.gl.beginQuery(wt, q.q);
    c.activeQueries.set(target, name);
  }
  glEndQuery(target: number) {
    const c = this.cur; if (!c) return;
    if (!c.activeQueries.has(target)) return;
    c.activeQueries.delete(target);
    this.gl.endQuery(target === E.SAMPLES_PASSED ? this.gl.ANY_SAMPLES_PASSED : target);
  }
  private queryResult(name: number, pname: number): number {
    const c = this.cur; if (!c) return 0;
    const q = c.queries.get(name);
    if (!q) return 0;
    if (q.result !== undefined) return pname === E.QUERY_RESULT_AVAILABLE ? 1 : q.result;
    if (!q.q) return 0;
    if (pname === E.QUERY_RESULT_AVAILABLE) return this.gl.getQueryParameter(q.q, this.gl.QUERY_RESULT_AVAILABLE) ? 1 : 0;
    // WebGL never makes results available within the same task: report "passed" rather than stall
    const avail = this.gl.getQueryParameter(q.q, this.gl.QUERY_RESULT_AVAILABLE);
    if (!avail) return q.target === E.SAMPLES_PASSED || q.target === E.ANY_SAMPLES_PASSED ? 1 : 0;
    const r = Number(this.gl.getQueryParameter(q.q, this.gl.QUERY_RESULT));
    return q.target === E.SAMPLES_PASSED && r ? 1 : r;
  }
  glGetQueryObjectiv(name: number, pname: number): Uint8Array { return f64s([this.queryResult(name, pname)]); }
  glGetQueryObjectuiv(name: number, pname: number): Uint8Array { return f64s([this.queryResult(name, pname)]); }
  glGetQueryObjecti64v(name: number, pname: number): Uint8Array { return f64s([this.queryResult(name, pname)]); }
  glGetQueryObjectui64v(name: number, pname: number): Uint8Array { return f64s([this.queryResult(name, pname)]); }
  glGetQueryiv(target: number, pname: number): Uint8Array {
    const c = this.cur;
    if (pname === E.CURRENT_QUERY) return f64s([c?.activeQueries.get(target) ?? 0]);
    return f64s([pname === E.QUERY_COUNTER_BITS ? 64 : 0]);
  }
  glQueryCounter(name: number, _target: number) { const c = this.cur; if (c) c.queries.set(name, { q: null, target: E.TIMESTAMP, result: Math.round(performance.now() * 1e6) }); }
  glFenceSync() { /* commands run in order: every fence is signalled once its batch has run */ }
  glDeleteSync() { /* nothing kept */ }
  glClientWaitSync() { /* see glFenceSync */ }
  glWaitSync() { /* see glFenceSync */ }

  // ── pixel store and readback ──

  glPixelStorei(pname: number, v: number) {
    const c = this.cur; if (!c) return;
    const set = (ps: PixelStore, key: keyof PixelStore) => { ps[key] = v; };
    switch (pname) {
      case E.UNPACK_ROW_LENGTH: set(c.unpack, 'rowLength'); break;
      case E.UNPACK_IMAGE_HEIGHT: set(c.unpack, 'imageHeight'); break;
      case E.UNPACK_SKIP_PIXELS: set(c.unpack, 'skipPixels'); break;
      case E.UNPACK_SKIP_ROWS: set(c.unpack, 'skipRows'); break;
      case E.UNPACK_SKIP_IMAGES: set(c.unpack, 'skipImages'); break;
      case E.UNPACK_ALIGNMENT: set(c.unpack, 'alignment'); break;
      case E.PACK_ROW_LENGTH: set(c.pack, 'rowLength'); break;
      case E.PACK_IMAGE_HEIGHT: set(c.pack, 'imageHeight'); break;
      case E.PACK_SKIP_PIXELS: set(c.pack, 'skipPixels'); break;
      case E.PACK_SKIP_ROWS: set(c.pack, 'skipRows'); break;
      case E.PACK_SKIP_IMAGES: set(c.pack, 'skipImages'); break;
      case E.PACK_ALIGNMENT: set(c.pack, 'alignment'); break;
    }
  }
  glPixelStoref(pname: number, v: number) { this.glPixelStorei(pname, Math.round(v)); }

  glReadPixels(x: number, y: number, w: number, h: number, format: number, type: number, offset: number): Uint8Array | void {
    const c = this.cur; if (!c) return new Uint8Array(0);
    const gl = this.gl;
    if (w <= 0 || h <= 0) return new Uint8Array(0);
    // the default framebuffer's color buffer (single-sampled) or the app's read framebuffer
    let fb: WebGLFramebuffer | null = c.readFb ? c.framebuffers.get(c.readFb) ?? null : null;
    if (!c.readFb && c.read) fb = this.resolved(c.read);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    let rgba: Uint8Array | Float32Array;
    if (format === E.DEPTH_COMPONENT || format === E.STENCIL_INDEX || format === E.DEPTH_STENCIL) {
      this.warnOnce('glReadPixels of depth or stencil returns zeros');
      rgba = new Uint8Array(w * h * 4);
    } else if (type === E.FLOAT || type === E.HALF_FLOAT) {
      rgba = new Float32Array(w * h * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      try { gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, rgba); } catch { /* not a float framebuffer */ }
    } else {
      rgba = new Uint8Array(w * h * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }
    this.bindReadFb(c);
    const out = packPixels(rgba, w, h, format, type, c.pack);
    if (c.pixelPack) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.bufObj(c.pixelPack));
      // into the pack buffer: write through the copy-write binding
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.bufObj(c.pixelPack));
      gl.bufferSubData(gl.COPY_WRITE_BUFFER, offset, out);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.bufObj(c.copyWrite));
      return new Uint8Array(0);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.bufObj(c.pixelPack));
    return out;
  }
  glGetTexImage(target: number, level: number, format: number, type: number): Uint8Array {
    const c = this.cur; if (!c) return new Uint8Array(0);
    const t = this.boundTex(target);
    const lv = t?.levels[level * 6] ?? t?.levels[level];
    if (!t || !lv) return new Uint8Array(0);
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.blitFbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, target === E.TEXTURE_1D || target === E.TEXTURE_RECTANGLE ? E.TEXTURE_2D : target, t.tex, level);
    const rgba = new Uint8Array(lv.w * lv.h * 4);
    if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.readPixels(0, 0, lv.w, lv.h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.bufObj(c.pixelPack));
    } else this.warnOnce('glGetTexImage of a texture WebGL can not render to returns zeros');
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    this.bindReadFb(c);
    return packPixels(rgba, lv.w, lv.h, format, type, c.pack);
  }

  // ── state queries ──

  glGetIntegerv(pname: number): Uint8Array { return f64s(this.getState(pname)); }
  glGetFloatv(pname: number): Uint8Array { return f64s(this.getState(pname)); }
  glGetDoublev(pname: number): Uint8Array { return f64s(this.getState(pname)); }
  glGetBooleanv(pname: number): Uint8Array { return f64s(this.getState(pname)); }
  glGetInteger64v(pname: number): Uint8Array { return f64s(this.getState(pname)); }
  glGetIntegeri_v(pname: number, i: number): Uint8Array {
    const c = this.cur;
    if (c && pname === E.UNIFORM_BUFFER_BINDING) return f64s([c.uniformBindings[i]?.[0] ?? 0]);
    if (c && pname === E.UNIFORM_BUFFER_START) return f64s([c.uniformBindings[i]?.[1] ?? 0]);
    if (c && pname === E.UNIFORM_BUFFER_SIZE) return f64s([c.uniformBindings[i]?.[2] ?? 0]);
    return f64s([0]);
  }
  glGetBooleani_v(pname: number, i: number): Uint8Array { return this.glGetIntegeri_v(pname, i); }
  glGetInteger64i_v(pname: number, i: number): Uint8Array { return this.glGetIntegeri_v(pname, i); }

  private getState(pname: number): number[] {
    const c = this.cur;
    if (!c) return [0];
    const ff = c.ff;
    const b = (v: boolean) => [v ? 1 : 0];
    switch (pname) {
      case E.VIEWPORT: return c.viewport;
      case E.SCISSOR_BOX: return c.scissor;
      case E.COLOR_CLEAR_VALUE: return c.clearColor;
      case E.DEPTH_CLEAR_VALUE: return [c.clearDepth];
      case E.STENCIL_CLEAR_VALUE: return [c.clearStencil];
      case E.COLOR_WRITEMASK: return c.colorMask.map((x) => (x ? 1 : 0));
      case E.DEPTH_WRITEMASK: return b(c.depthMask);
      case E.DEPTH_FUNC: return [c.depthFunc];
      case E.DEPTH_RANGE: return c.depthRange;
      case E.BLEND_SRC: case E.BLEND_SRC_RGB: return [c.blend.srcRGB];
      case E.BLEND_DST: case E.BLEND_DST_RGB: return [c.blend.dstRGB];
      case E.BLEND_SRC_ALPHA: return [c.blend.srcA];
      case E.BLEND_DST_ALPHA: return [c.blend.dstA];
      case E.BLEND_EQUATION_RGB: return [c.blend.eqRGB];
      case E.BLEND_EQUATION_ALPHA: return [c.blend.eqA];
      case E.BLEND_COLOR: return c.blend.color;
      case E.CULL_FACE_MODE: return [c.cullFace];
      case E.FRONT_FACE: return [c.frontFace];
      case E.POLYGON_OFFSET_FACTOR: return [c.polygonOffset[0]];
      case E.POLYGON_OFFSET_UNITS: return [c.polygonOffset[1]];
      case E.POLYGON_MODE: return c.polygonMode;
      case E.LINE_WIDTH: return [c.lineWidth];
      case E.POINT_SIZE: return [ff.pointSize];
      case E.SHADE_MODEL: return [ff.flat ? E.FLAT : E.SMOOTH];
      case E.MATRIX_MODE: return [ff.matrixMode];
      case E.MODELVIEW_MATRIX: return Array.from(ff.mv);
      case E.PROJECTION_MATRIX: return Array.from(ff.proj);
      case E.TEXTURE_MATRIX: { const s = ff.texture[ff.activeTexture]; return Array.from(s[s.length - 1]); }
      case E.MODELVIEW_STACK_DEPTH: return [ff.modelview.length];
      case E.PROJECTION_STACK_DEPTH: return [ff.projection.length];
      case E.TEXTURE_STACK_DEPTH: return [ff.texture[ff.activeTexture].length];
      case E.CURRENT_COLOR: return Array.from(ff.current.color);
      case E.CURRENT_NORMAL: return Array.from(ff.current.normal);
      case E.CURRENT_TEXTURE_COORDS: return Array.from(ff.current.texCoord[ff.activeTexture]);
      case E.CURRENT_RASTER_POSITION: return [0, 0, 0, 1];
      case E.CURRENT_RASTER_POSITION_VALID: return [1];
      case E.ACTIVE_TEXTURE: return [E.TEXTURE0 + c.activeUnit];
      case E.CLIENT_ACTIVE_TEXTURE: return [E.TEXTURE0 + ff.clientActiveTexture];
      case E.TEXTURE_BINDING_1D: return [c.textures[c.activeUnit].get(E.TEXTURE_1D) ?? 0].map((x) => Math.max(0, x));
      case E.TEXTURE_BINDING_2D: return [c.textures[c.activeUnit].get(E.TEXTURE_2D) ?? 0].map((x) => Math.max(0, x));
      case E.TEXTURE_BINDING_3D: return [c.textures[c.activeUnit].get(E.TEXTURE_3D) ?? 0].map((x) => Math.max(0, x));
      case E.TEXTURE_BINDING_CUBE_MAP: return [c.textures[c.activeUnit].get(E.TEXTURE_CUBE_MAP) ?? 0].map((x) => Math.max(0, x));
      case E.TEXTURE_BINDING_2D_ARRAY: return [c.textures[c.activeUnit].get(E.TEXTURE_2D_ARRAY) ?? 0].map((x) => Math.max(0, x));
      case E.TEXTURE_BINDING_RECTANGLE: return [c.textures[c.activeUnit].get(E.TEXTURE_RECTANGLE) ?? 0].map((x) => Math.max(0, x));
      case E.ARRAY_BUFFER_BINDING: return [c.arrayBuffer];
      case E.ELEMENT_ARRAY_BUFFER_BINDING: return [c.vao.element];
      case E.PIXEL_PACK_BUFFER_BINDING: return [c.pixelPack];
      case E.PIXEL_UNPACK_BUFFER_BINDING: return [c.pixelUnpack];
      case E.UNIFORM_BUFFER_BINDING: return [c.uniformBuffer];
      case E.COPY_READ_BUFFER_BINDING: return [c.copyRead];
      case E.COPY_WRITE_BUFFER_BINDING: return [c.copyWrite];
      case E.TRANSFORM_FEEDBACK_BUFFER_BINDING: return [c.tfBuffer];
      case E.TEXTURE_BINDING_BUFFER: return [c.textureBuffer];
      case E.VERTEX_ARRAY_BINDING: { for (const [n, v] of c.vaos) if (v === c.vao) return [n]; return [0]; }
      case E.CURRENT_PROGRAM: return [c.program];
      case E.DRAW_FRAMEBUFFER_BINDING: return [c.drawFb];
      case E.READ_FRAMEBUFFER_BINDING: return [c.readFb];
      case E.RENDERBUFFER_BINDING: return [0];
      case E.DRAW_BUFFER: case E.DRAW_BUFFER0: return [c.drawFb ? E.COLOR_ATTACHMENT0 : c.drawBuffers[0]];
      case E.READ_BUFFER: return [c.readFb ? E.COLOR_ATTACHMENT0 : c.readBuffer];
      case E.UNPACK_ALIGNMENT: return [c.unpack.alignment];
      case E.PACK_ALIGNMENT: return [c.pack.alignment];
      case E.UNPACK_ROW_LENGTH: return [c.unpack.rowLength];
      case E.PACK_ROW_LENGTH: return [c.pack.rowLength];
      case E.LIGHT_MODEL_AMBIENT: return Array.from(ff.lightModelAmbient);
      case E.LIGHT_MODEL_TWO_SIDE: return b(ff.twoSide);
      case E.LIGHT_MODEL_LOCAL_VIEWER: return b(ff.localViewer);
      case E.FOG_COLOR: return Array.from(ff.fogColor);
      case E.FOG_MODE: return [ff.fogMode];
      case E.FOG_DENSITY: return [ff.fogDensity];
      case E.FOG_START: return [ff.fogStart];
      case E.FOG_END: return [ff.fogEnd];
      case E.ALPHA_TEST_FUNC: return [ff.alphaFunc];
      case E.ALPHA_TEST_REF: return [ff.alphaRef];
      case E.LIST_INDEX: return [c.listCompiling];
      case E.LIST_MODE: return [c.listMode];
      case E.LIST_BASE: return [c.listBase];
      case E.STENCIL_FUNC: return [c.stencil.front.func];
      case E.STENCIL_REF: return [c.stencil.front.ref];
      case E.STENCIL_VALUE_MASK: return [c.stencil.front.mask];
      case E.STENCIL_WRITEMASK: return [c.stencil.front.writemask];
      case E.STENCIL_FAIL: return [c.stencil.front.fail];
      case E.STENCIL_PASS_DEPTH_FAIL: return [c.stencil.front.zfail];
      case E.STENCIL_PASS_DEPTH_PASS: return [c.stencil.front.zpass];
      case E.STENCIL_BACK_FUNC: return [c.stencil.back.func];
      case E.STENCIL_BACK_REF: return [c.stencil.back.ref];
      case E.STENCIL_BACK_VALUE_MASK: return [c.stencil.back.mask];
      case E.STENCIL_BACK_WRITEMASK: return [c.stencil.back.writemask];
      case E.STENCIL_BACK_FAIL: return [c.stencil.back.fail];
      case E.STENCIL_BACK_PASS_DEPTH_FAIL: return [c.stencil.back.zfail];
      case E.STENCIL_BACK_PASS_DEPTH_PASS: return [c.stencil.back.zpass];
      case E.PRIMITIVE_RESTART_INDEX: return [c.restartIndex];
      case E.RED_BITS: case E.GREEN_BITS: case E.BLUE_BITS: case E.ALPHA_BITS: return [8];
      case E.DEPTH_BITS: return [24];
      case E.STENCIL_BITS: return [8];
      case E.TIMESTAMP: return [Math.round(performance.now() * 1e6)];
      case E.IMPLEMENTATION_COLOR_READ_FORMAT: return [E.RGBA];
      case E.IMPLEMENTATION_COLOR_READ_TYPE: return [E.UNSIGNED_BYTE];
      case E.MAX_DEBUG_MESSAGE_LENGTH: case E.MAX_DEBUG_LOGGED_MESSAGES: case E.MAX_LABEL_LENGTH: return [256];
      case E.MAX_DEBUG_GROUP_STACK_DEPTH: return [64];
    }
    if (pname >= E.LIGHT0 && pname < E.LIGHT0 + FF_LIGHTS) return b(ff.lights[pname - E.LIGHT0].enabled);
    if (c.caps.has(pname)) return [1];
    // anything WebGL answers itself
    try {
      const v = this.gl.getParameter(pname);
      if (v == null) return [0];
      if (typeof v === 'number') return [v];
      if (typeof v === 'boolean') return b(v);
      if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>).map(Number);
    } catch { /* not a WebGL pname */ }
    this.warnOnce(`glGet(0x${pname.toString(16)}) is answered with 0`);
    return [0];
  }
  glGetTexParameteriv(target: number, pname: number): Uint8Array { return this.texParamGet(target, pname); }
  glGetTexParameterfv(target: number, pname: number): Uint8Array { return this.texParamGet(target, pname); }
  private texParamGet(target: number, pname: number): Uint8Array {
    const t = this.boundTex(target);
    const v = t?.params.get(pname);
    if (v !== undefined) return f64s(typeof v === 'number' ? [v] : Array.from(v));
    const defaults: Record<number, number> = {
      [E.TEXTURE_MIN_FILTER]: E.NEAREST_MIPMAP_LINEAR, [E.TEXTURE_MAG_FILTER]: E.LINEAR, [E.TEXTURE_WRAP_S]: E.REPEAT, [E.TEXTURE_WRAP_T]: E.REPEAT,
      [E.TEXTURE_WRAP_R]: E.REPEAT, [E.TEXTURE_BASE_LEVEL]: 0, [E.TEXTURE_MAX_LEVEL]: 1000, [E.TEXTURE_MIN_LOD]: -1000, [E.TEXTURE_MAX_LOD]: 1000,
      [E.TEXTURE_IMMUTABLE_FORMAT]: t?.immutable ? 1 : 0, [E.GENERATE_MIPMAP]: 0, [E.TEXTURE_COMPARE_MODE]: E.NONE, [E.TEXTURE_COMPARE_FUNC]: E.LEQUAL,
    };
    return f64s([defaults[pname] ?? 0]);
  }
  glGetTexLevelParameteriv(target: number, level: number, pname: number): Uint8Array { return this.texLevelParam(target, level, pname); }
  glGetTexLevelParameterfv(target: number, level: number, pname: number): Uint8Array { return this.texLevelParam(target, level, pname); }
  private texLevelParam(target: number, level: number, pname: number): Uint8Array {
    const proxy = target === E.PROXY_TEXTURE_2D || target === E.PROXY_TEXTURE_1D || target === E.PROXY_TEXTURE_3D || target === E.PROXY_TEXTURE_CUBE_MAP || target === E.PROXY_TEXTURE_RECTANGLE;
    if (proxy) {
      // proxies: answer "fits" for sizes up to MAX_TEXTURE_SIZE (apps probe with them)
      return f64s([pname === E.TEXTURE_WIDTH || pname === E.TEXTURE_HEIGHT ? 1 : pname === E.TEXTURE_INTERNAL_FORMAT ? E.RGBA8 : 0]);
    }
    const t = this.boundTex(target);
    const face = target >= E.TEXTURE_CUBE_MAP_POSITIVE_X && target <= E.TEXTURE_CUBE_MAP_NEGATIVE_Z ? target - E.TEXTURE_CUBE_MAP_POSITIVE_X : 0;
    const lv = t?.levels[level * 6 + face];
    if (!lv) return f64s([0]);
    switch (pname) {
      case E.TEXTURE_WIDTH: return f64s([lv.w]);
      case E.TEXTURE_HEIGHT: return f64s([lv.h]);
      case E.TEXTURE_DEPTH: return f64s([lv.d]);
      case E.TEXTURE_INTERNAL_FORMAT: return f64s([lv.internal]);
      case E.TEXTURE_RED_SIZE: return f64s([lv.fmt.bits[0]]);
      case E.TEXTURE_GREEN_SIZE: return f64s([lv.fmt.bits[1]]);
      case E.TEXTURE_BLUE_SIZE: return f64s([lv.fmt.bits[2]]);
      case E.TEXTURE_ALPHA_SIZE: return f64s([lv.fmt.bits[3]]);
      case E.TEXTURE_DEPTH_SIZE: return f64s([lv.fmt.bits[4]]);
      case E.TEXTURE_STENCIL_SIZE: return f64s([lv.fmt.bits[5]]);
      case E.TEXTURE_LUMINANCE_SIZE: return f64s([lv.fmt.base === 'luminance' || lv.fmt.base === 'la' ? 8 : 0]);
      case E.TEXTURE_INTENSITY_SIZE: return f64s([lv.fmt.base === 'intensity' ? 8 : 0]);
      case E.TEXTURE_COMPRESSED: return f64s([0]);
    }
    return f64s([0]);
  }
  glGetRenderbufferParameteriv(): Uint8Array { return f64s([0]); }
  glGetFramebufferAttachmentParameteriv(_target: number, attachment: number, pname: number): Uint8Array {
    const c = this.cur;
    if (c && !c.drawFb) {
      // the default framebuffer: what libGLX_tabcomputer's FBConfigs promise
      if (pname === E.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return f64s([E.FRAMEBUFFER_DEFAULT]);
      if (pname === E.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING) return f64s([E.LINEAR]);
      if (pname === E.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) return f64s([E.UNSIGNED_NORMALIZED]);
      const depth = attachment === E.DEPTH || attachment === E.DEPTH_ATTACHMENT;
      const stencil = attachment === E.STENCIL || attachment === E.STENCIL_ATTACHMENT;
      const bits: Record<number, number> = {
        [E.FRAMEBUFFER_ATTACHMENT_RED_SIZE]: depth || stencil ? 0 : 8, [E.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE]: depth || stencil ? 0 : 8,
        [E.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE]: depth || stencil ? 0 : 8, [E.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE]: depth || stencil ? 0 : 8,
        [E.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE]: depth ? 24 : 0, [E.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE]: stencil ? 8 : 0,
      };
      return f64s([bits[pname] ?? 0]);
    }
    try {
      const v = this.gl.getFramebufferAttachmentParameter(this.gl.DRAW_FRAMEBUFFER, attachmentOf(attachment), pname);
      return f64s([typeof v === 'number' ? v : v ? 1 : 0]);
    } catch { return f64s([0]); }
  }
  glGetLightfv(light: number, pname: number): Uint8Array {
    const l = this.cur?.ff.lights[light - E.LIGHT0];
    if (!l) return f64s([0]);
    switch (pname) {
      case E.AMBIENT: return f64s(l.ambient);
      case E.DIFFUSE: return f64s(l.diffuse);
      case E.SPECULAR: return f64s(l.specular);
      case E.POSITION: return f64s(l.position);
      case E.SPOT_DIRECTION: return f64s(l.spotDirection);
      case E.SPOT_EXPONENT: return f64s([l.spotExponent]);
      case E.SPOT_CUTOFF: return f64s([l.spotCutoff]);
      case E.CONSTANT_ATTENUATION: return f64s([l.attenuation[0]]);
      case E.LINEAR_ATTENUATION: return f64s([l.attenuation[1]]);
      case E.QUADRATIC_ATTENUATION: return f64s([l.attenuation[2]]);
    }
    return f64s([0]);
  }
  glGetLightiv(light: number, pname: number): Uint8Array { return this.glGetLightfv(light, pname); }
  glGetMaterialfv(face: number, pname: number): Uint8Array {
    const ff = this.cur?.ff; if (!ff) return f64s([0]);
    const m = face === E.BACK ? ff.back : ff.front;
    switch (pname) {
      case E.AMBIENT: return f64s(m.ambient);
      case E.DIFFUSE: return f64s(m.diffuse);
      case E.SPECULAR: return f64s(m.specular);
      case E.EMISSION: return f64s(m.emission);
      case E.SHININESS: return f64s([m.shininess]);
    }
    return f64s([0]);
  }
  glGetMaterialiv(face: number, pname: number): Uint8Array { return this.glGetMaterialfv(face, pname); }
  glGetTexEnvfv(_target: number, pname: number): Uint8Array {
    const c = this.cur; if (!c) return f64s([0]);
    const u = c.ff.units[c.activeUnit];
    if (pname === E.TEXTURE_ENV_MODE) return f64s([u.envMode]);
    if (pname === E.TEXTURE_ENV_COLOR) return f64s(u.envColor);
    return f64s([0]);
  }
  glGetTexEnviv(target: number, pname: number): Uint8Array { return this.glGetTexEnvfv(target, pname); }
  glGetVertexAttribiv(index: number, pname: number): Uint8Array {
    const c = this.cur; if (!c) return f64s([0]);
    const a = c.vao.attribs[index];
    if (!a) return f64s([0]);
    switch (pname) {
      case E.VERTEX_ATTRIB_ARRAY_ENABLED: return f64s([a.enabled ? 1 : 0]);
      case E.VERTEX_ATTRIB_ARRAY_SIZE: return f64s([a.size]);
      case E.VERTEX_ATTRIB_ARRAY_STRIDE: return f64s([a.stride]);
      case E.VERTEX_ATTRIB_ARRAY_TYPE: return f64s([a.type]);
      case E.VERTEX_ATTRIB_ARRAY_NORMALIZED: return f64s([a.normalized ? 1 : 0]);
      case E.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: return f64s([a.buffer]);
      case E.VERTEX_ATTRIB_ARRAY_INTEGER: return f64s([a.integer ? 1 : 0]);
      case E.VERTEX_ATTRIB_ARRAY_DIVISOR: return f64s([a.divisor]);
      case E.CURRENT_VERTEX_ATTRIB: return f64s(c.generic[index]);
    }
    return f64s([0]);
  }
  glGetVertexAttribfv(index: number, pname: number): Uint8Array { return this.glGetVertexAttribiv(index, pname); }
  glGetVertexAttribdv(index: number, pname: number): Uint8Array { return this.glGetVertexAttribiv(index, pname); }
  glGetVertexAttribIiv(index: number, pname: number): Uint8Array { return this.glGetVertexAttribiv(index, pname); }
  glGetVertexAttribIuiv(index: number, pname: number): Uint8Array { return this.glGetVertexAttribiv(index, pname); }
  glGetUniformfv(p: number, loc: number): Uint8Array {
    const o = this.progObj(p);
    const l = o?.locs[loc];
    if (!o || !l) return f64s([0]);
    const v = this.gl.getUniform(o.prog, l.wl);
    return f64s(typeof v === 'number' ? [v] : typeof v === 'boolean' ? [v ? 1 : 0] : Array.from(v as ArrayLike<number>));
  }
  glGetUniformiv(p: number, loc: number): Uint8Array { return this.glGetUniformfv(p, loc); }
  glGetUniformuiv(p: number, loc: number): Uint8Array { return this.glGetUniformfv(p, loc); }
  glGetSamplerParameteriv(): Uint8Array { return f64s([0]); }
  glGetSamplerParameterfv(): Uint8Array { return f64s([0]); }
  glGetMultisamplefv(): Uint8Array { return f64s([0.5, 0.5]); }
  glGetClipPlane(): Uint8Array { return f64s([0, 0, 0, 0]); }
  glRenderMode(): Uint8Array { this.warnOnce('glRenderMode (selection, feedback) is not supported'); return u32s(0); }
  glIsSampler(name: number): Uint8Array { return u32s(this.cur?.share.samplers.has(name) ? 1 : 0); }

  // ── things accepted and ignored ──

  glFeedbackBuffer() { /* see glRenderMode */ }
  glSelectBuffer() { /* see glRenderMode */ }
  glInitNames() { /* selection */ }
  glLoadName() { /* selection */ }
  glPushName() { /* selection */ }
  glPopName() { /* selection */ }
  glPassThrough() { /* feedback */ }
  glAccum() { this.warnOnce('glAccum: there is no accumulation buffer'); }
  glBitmap() { this.warnOnce('glBitmap is not drawn yet'); }
  glDrawPixels() { this.warnOnce('glDrawPixels is not drawn yet'); }
  glCopyPixels() { this.warnOnce('glCopyPixels is not drawn yet'); }
  glIndexMask() { /* color index */ }
  glEdgeFlag() { /* polygon edges are drawn as triangles */ }
  glEdgeFlagv() { /* see glEdgeFlag */ }
  glArrayElement() { this.warnOnce('glArrayElement is not supported yet'); }
  glMap1f() { /* evaluators */ }
  glMap2f() { /* evaluators */ }
  glMapGrid1f() { /* evaluators */ }
  glMapGrid2f() { /* evaluators */ }
  glEvalMesh1() { /* evaluators */ }
  glEvalMesh2() { /* evaluators */ }
}

// ── helpers ──

function copyArg(a: Arg): Arg {
  if (ArrayBuffer.isView(a)) return (a as unknown as { slice(): ArrayBufferView }).slice();
  return a;
}
function transpose(m: ArrayLike<number>): number[] {
  const r: number[] = [];
  for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) r[c * 4 + k] = m[k * 4 + c];
  return r;
}
function concat(list: ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}
function normalize(type: string, v: number): number {
  switch (type) {
    case 'b': return Math.max(v / 127, -1);
    case 'ub': return v / 255;
    case 's': return Math.max(v / 32767, -1);
    case 'us': return v / 65535;
    case 'i': return Math.max(v / 2147483647, -1);
    case 'ui': return v / 4294967295;
  }
  return v;
}
export function webglTarget(target: number): number {
  switch (target) {
    case E.TEXTURE_1D: case E.TEXTURE_RECTANGLE: case E.TEXTURE_2D: return E.TEXTURE_2D;
    case E.TEXTURE_1D_ARRAY: return E.TEXTURE_2D;
    default: return target;
  }
}
function wrapMode(m: number): number {
  return m === E.CLAMP || m === E.CLAMP_TO_BORDER ? E.CLAMP_TO_EDGE : m;
}
function webglUsage(u: number): number {
  switch (u) {
    case E.STREAM_READ: case E.STREAM_COPY: return E.STREAM_DRAW;
    case E.STATIC_READ: case E.STATIC_COPY: return E.STATIC_DRAW;
    case E.DYNAMIC_READ: case E.DYNAMIC_COPY: return E.DYNAMIC_DRAW;
  }
  return u;
}
function fbTarget(t: number): number { return t === E.READ_FRAMEBUFFER ? t : E.DRAW_FRAMEBUFFER; }
function attachmentOf(a: number): number { return a; }
function renderbufferFormat(f: number): number {
  switch (f) {
    case E.RGBA: case E.RGBA8: case 4: return E.RGBA8;
    case E.RGB: case E.RGB8: case 3: return E.RGB8;
    case E.DEPTH_COMPONENT: case E.DEPTH_COMPONENT24: case E.DEPTH_COMPONENT32: return E.DEPTH_COMPONENT24;
    case E.DEPTH_STENCIL: case E.DEPTH24_STENCIL8: return E.DEPTH24_STENCIL8;
    case E.STENCIL_INDEX: case E.STENCIL_INDEX1: case E.STENCIL_INDEX4: case E.STENCIL_INDEX16: return E.STENCIL_INDEX8;
  }
  return f;
}
function maxIndex(type: number): number { return type === E.UNSIGNED_BYTE ? 0xff : type === E.UNSIGNED_SHORT ? 0xffff : 0xffffffff; }
function isSamplerType(t: number): boolean {
  return (t >= E.SAMPLER_1D && t <= E.SAMPLER_2D_SHADOW) || (t >= E.SAMPLER_1D_ARRAY && t <= E.UNSIGNED_INT_SAMPLER_2D_ARRAY) ||
    t === E.SAMPLER_2D_RECT || t === E.SAMPLER_2D_RECT_SHADOW || t === E.SAMPLER_BUFFER || t === E.INT_SAMPLER_2D_RECT ||
    t === E.UNSIGNED_INT_SAMPLER_2D_RECT || t === E.SAMPLER_2D_MULTISAMPLE;
}
function isIntType(t: number): boolean {
  return t === E.INT || t === E.INT_VEC2 || t === E.INT_VEC3 || t === E.INT_VEC4 || t === E.BOOL || t === E.BOOL_VEC2 || t === E.BOOL_VEC3 || t === E.BOOL_VEC4;
}
function isFloatType(t: number): boolean {
  return t === E.FLOAT || t === E.FLOAT_VEC2 || t === E.FLOAT_VEC3 || t === E.FLOAT_VEC4;
}

/**
 * GL primitive → WebGL primitive, with an index list for the ones WebGL
 * lacks (quads, quad strips, polygons) and for polygon mode LINE/POINT.
 * Quads become triangles that end on the quad's provoking (last) vertex,
 * polygons triangles that end on their first, so flat shading matches GL.
 */
export function toWebGLPrimitive(mode: number, count: number, polygonMode: number, first = 0, indices?: Uint32Array): { mode: number; indices?: Uint32Array } | null {
  const ix = (i: number) => (indices ? indices[i] : first + i);
  const lines = polygonMode === E.LINE, points = polygonMode === E.POINT;
  if (mode <= E.LINE_STRIP) return indices ? { mode, indices: Uint32Array.from(indices.subarray(0, count)) } : { mode };
  // triangles of the primitive, as vertex positions in the stream
  const tris: number[] = [];
  const edges: number[] = [];
  switch (mode) {
    case E.TRIANGLES:
      if (!lines && !points) return indices ? { mode, indices: Uint32Array.from(indices.subarray(0, count)) } : { mode };
      for (let i = 0; i + 2 < count; i += 3) { tris.push(ix(i), ix(i + 1), ix(i + 2)); edges.push(ix(i), ix(i + 1), ix(i + 1), ix(i + 2), ix(i + 2), ix(i)); }
      break;
    case E.TRIANGLE_STRIP:
      if (!lines && !points) return indices ? { mode, indices: Uint32Array.from(indices.subarray(0, count)) } : { mode };
      for (let i = 0; i + 2 < count; i++) { tris.push(ix(i), ix(i + 1), ix(i + 2)); edges.push(ix(i), ix(i + 1), ix(i + 1), ix(i + 2), ix(i + 2), ix(i)); }
      break;
    case E.TRIANGLE_FAN:
      if (!lines && !points) return indices ? { mode, indices: Uint32Array.from(indices.subarray(0, count)) } : { mode };
      for (let i = 1; i + 1 < count; i++) { tris.push(ix(0), ix(i), ix(i + 1)); edges.push(ix(0), ix(i), ix(i), ix(i + 1), ix(i + 1), ix(0)); }
      break;
    case E.QUADS:
      for (let i = 0; i + 3 < count; i += 4) {
        tris.push(ix(i), ix(i + 1), ix(i + 3), ix(i + 1), ix(i + 2), ix(i + 3));
        edges.push(ix(i), ix(i + 1), ix(i + 1), ix(i + 2), ix(i + 2), ix(i + 3), ix(i + 3), ix(i));
      }
      break;
    case E.QUAD_STRIP:
      for (let i = 0; i + 3 < count; i += 2) {
        // the quad is (i, i+1, i+3, i+2); its provoking vertex is i+3
        tris.push(ix(i), ix(i + 1), ix(i + 3), ix(i + 2), ix(i), ix(i + 3));
        edges.push(ix(i), ix(i + 1), ix(i + 1), ix(i + 3), ix(i + 3), ix(i + 2), ix(i + 2), ix(i));
      }
      break;
    case E.POLYGON:
      for (let i = 1; i + 1 < count; i++) tris.push(ix(i), ix(i + 1), ix(0));
      for (let i = 0; i < count; i++) edges.push(ix(i), ix((i + 1) % count));
      break;
    default:
      return null;
  }
  if (lines) return { mode: E.LINES, indices: Uint32Array.from(edges) };
  if (points) return { mode: E.POINTS, indices: Uint32Array.from(new Set(tris)) };
  return { mode: E.TRIANGLES, indices: Uint32Array.from(tris) };
}

function snapshot(c: Ctx) {
  return {
    caps: new Set(c.caps), viewport: c.viewport.slice(), scissor: c.scissor.slice(), clearColor: c.clearColor.slice(),
    colorMask: c.colorMask.slice(), depthMask: c.depthMask, depthFunc: c.depthFunc, blend: structuredClone(c.blend),
    cullFace: c.cullFace, frontFace: c.frontFace, polygonMode: c.polygonMode.slice(), lineWidth: c.lineWidth,
    stencil: structuredClone(c.stencil), activeUnit: c.activeUnit, polygonOffset: c.polygonOffset.slice(),
    ff: {
      lighting: c.ff.lighting, lights: c.ff.lights.map((l) => ({ ...l, ambient: l.ambient.slice(), diffuse: l.diffuse.slice(), specular: l.specular.slice(), position: l.position.slice(), spotDirection: l.spotDirection.slice(), attenuation: l.attenuation.slice() })),
      front: structuredClone(c.ff.front), back: structuredClone(c.ff.back), colorMaterial: c.ff.colorMaterial, flat: c.ff.flat,
      fog: c.ff.fog, alphaTest: c.ff.alphaTest, alphaFunc: c.ff.alphaFunc, alphaRef: c.ff.alphaRef, normalize: c.ff.normalize,
      units: c.ff.units.map((u) => ({ ...u, envColor: u.envColor.slice() })), clipEnabled: c.ff.clipEnabled, pointSize: c.ff.pointSize,
      current: { color: c.ff.current.color.slice() }, matrixMode: c.ff.matrixMode, lightModelAmbient: c.ff.lightModelAmbient.slice(), twoSide: c.ff.twoSide,
    },
  };
}
function restore(c: Ctx, s: ReturnType<typeof snapshot>) {
  c.caps = s.caps; c.viewport = s.viewport; c.scissor = s.scissor; c.clearColor = s.clearColor; c.colorMask = s.colorMask;
  c.depthMask = s.depthMask; c.depthFunc = s.depthFunc; c.blend = s.blend; c.cullFace = s.cullFace; c.frontFace = s.frontFace;
  c.polygonMode = s.polygonMode; c.lineWidth = s.lineWidth; c.stencil = s.stencil; c.activeUnit = s.activeUnit; c.polygonOffset = s.polygonOffset;
  Object.assign(c.ff, { ...s.ff, current: c.ff.current });
  c.ff.current.color = s.ff.current.color;
}
