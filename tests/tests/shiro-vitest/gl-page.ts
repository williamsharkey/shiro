/**
 * Runs in headless Chromium for gl-webgl.test.ts (bundled with esbuild):
 * real WebGL2 for the GLSL front end, the generated fixed-function programs
 * and the executor.
 */
import { translateShader } from '../../../src/gl/glsl/translate';
import { FFState, ffSource, FF_TEXTURE_UNITS, type UnitInfo } from '../../../src/gl/ff';
import { Executor } from '../../../src/gl/exec';
import * as E from '../../../src/gl/gen/enums';

const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!;

function compile(type: number, src: string): { sh: WebGLShader; log: string | null } {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return { sh, log: gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(sh) ?? 'failed' };
}
function link(vs: WebGLShader, fs: WebGLShader): string | null {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  const r = gl.getProgramParameter(p, gl.LINK_STATUS) ? null : gl.getProgramInfoLog(p) ?? 'failed';
  gl.deleteProgram(p);
  return r;
}

/** Translates and compiles each shader, then links each vertex/fragment pair. */
function corpus(files: Record<string, string>, pairs: [string, string][]) {
  const results: Record<string, string | null> = {};
  const shaders = new Map<string, WebGLShader>();
  for (const [name, src] of Object.entries(files)) {
    const stage = name.endsWith('.vert') ? 'vertex' : 'fragment';
    const t = translateShader(src, stage);
    if (!t.ok) { results[name] = `translate: ${t.log}`; continue; }
    const c = compile(stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER, t.source);
    results[name] = c.log && `${c.log}\n--- translated ---\n${t.source}`;
    if (!c.log) shaders.set(name, c.sh);
  }
  for (const [v, f] of pairs) {
    const vs = shaders.get(v), fs = shaders.get(f);
    if (vs && fs) results[`${v} + ${f}`] = link(vs, fs);
  }
  return results;
}

/** Fixed-function states worth one generated program each. */
function ffVariants(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const unit2d = (base: UnitInfo['base'] = 'rgba'): UnitInfo => ({ target: E.TEXTURE_2D, base });
  const variants: [string, (s: FFState) => (UnitInfo | null)[] | void, boolean?][] = [
    ['default', () => {}],
    ['points', () => {}, true],
    ['point sprites', (s) => { s.pointSprite = true; s.units[0].enabled = 2; return [unit2d()]; }, true],
    ['flat', (s) => { s.flat = true; }],
    ['one directional light', (s) => { s.lighting = true; s.lights[0].enabled = true; }],
    ['point and spot lights, local viewer, two-sided', (s) => {
      s.lighting = true; s.localViewer = true; s.twoSide = true; s.separateSpecular = true;
      s.lights[0].enabled = true; s.lights[0].position.set([1, 2, 3, 1]);
      s.lights[1].enabled = true; s.lights[1].position.set([0, 0, 5, 1]); s.lights[1].spotCutoff = 30;
      s.lights[7].enabled = true;
    }],
    ['color material, normalize', (s) => { s.lighting = true; s.lights[0].enabled = true; s.colorMaterial = true; s.normalize = true; }],
    ['color material diffuse, back, rescale', (s) => { s.lighting = true; s.lights[0].enabled = true; s.colorMaterial = true; s.colorMaterialFace = E.BACK; s.colorMaterialMode = E.DIFFUSE; s.rescaleNormal = true; }],
    ['color material specular', (s) => { s.lighting = true; s.lights[0].enabled = true; s.colorMaterial = true; s.colorMaterialMode = E.SPECULAR; }],
    ['color material emission', (s) => { s.lighting = true; s.lights[0].enabled = true; s.colorMaterial = true; s.colorMaterialMode = E.EMISSION; }],
    ['color sum', (s) => { s.colorSum = true; }],
    ['clip planes', (s) => { s.clipEnabled = 0b100101; }],
  ];
  for (const mode of [E.EXP, E.EXP2, E.LINEAR]) {
    variants.push([`fog 0x${mode.toString(16)}`, (s) => { s.fog = true; s.fogMode = mode; }]);
    variants.push([`fog 0x${mode.toString(16)} from coordinates`, (s) => { s.fog = true; s.fogMode = mode; s.fogCoordSrc = E.FOG_COORD; }]);
  }
  for (const f of [E.NEVER, E.LESS, E.EQUAL, E.LEQUAL, E.GREATER, E.NOTEQUAL, E.GEQUAL]) {
    variants.push([`alpha test 0x${f.toString(16)}`, (s) => { s.alphaTest = true; s.alphaFunc = f; }]);
  }
  const bases: UnitInfo['base'][] = ['rgba', 'rgb', 'alpha', 'luminance', 'la', 'intensity', 'depth'];
  for (const env of [E.MODULATE, E.REPLACE, E.DECAL, E.BLEND, E.ADD]) {
    for (const base of bases) variants.push([`texenv 0x${env.toString(16)} ${base}`, (s) => { s.units[0].enabled = 2; s.units[0].envMode = env; return [unit2d(base)]; }]);
  }
  for (const op of [E.REPLACE, E.MODULATE, E.ADD, E.ADD_SIGNED, E.INTERPOLATE, E.SUBTRACT, E.DOT3_RGB, E.DOT3_RGBA]) {
    variants.push([`combine 0x${op.toString(16)}`, (s) => {
      const u = s.units[1];
      s.units[0].enabled = 2; u.enabled = 2; u.envMode = E.COMBINE; u.combineRGB = op; u.combineAlpha = op === E.DOT3_RGB || op === E.DOT3_RGBA ? E.MODULATE : op;
      u.srcRGB = [E.TEXTURE, E.PREVIOUS, E.CONSTANT]; u.srcAlpha = [E.PRIMARY_COLOR, E.TEXTURE0, E.CONSTANT];
      u.operandRGB = [E.SRC_COLOR, E.ONE_MINUS_SRC_COLOR, E.SRC_ALPHA]; u.operandAlpha = [E.SRC_ALPHA, E.ONE_MINUS_SRC_ALPHA, E.SRC_ALPHA];
      u.rgbScale = 2;
      return [unit2d(), unit2d()];
    }]);
  }
  for (const target of [E.TEXTURE_3D, E.TEXTURE_CUBE_MAP]) {
    variants.push([`texture target 0x${target.toString(16)}`, (s) => { s.units[0].enabled = target === E.TEXTURE_3D ? 4 : 8; return [{ target, base: 'rgba' }]; }]);
  }
  for (const gen of [E.OBJECT_LINEAR, E.EYE_LINEAR, E.SPHERE_MAP, E.NORMAL_MAP, E.REFLECTION_MAP]) {
    variants.push([`texgen 0x${gen.toString(16)}`, (s) => { s.units[0].enabled = 2; s.units[0].texGen = 0b1111; s.units[0].texGenMode = [gen, gen, gen, gen]; return [unit2d()]; }]);
  }
  variants.push(['all texture units, lit, fogged', (s) => {
    s.lighting = true; s.lights[0].enabled = true; s.fog = true;
    for (let i = 0; i < FF_TEXTURE_UNITS; i++) s.units[i].enabled = 2;
    return Array.from({ length: FF_TEXTURE_UNITS }, () => unit2d());
  }]);
  for (const [name, set, points] of variants) {
    const s = new FFState();
    const units = set(s) ?? [];
    const { vs, fs } = ffSource(s, units, !!points);
    const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
    out[name] = v.log ? `vertex: ${v.log}\n${vs}` : f.log ? `fragment: ${f.log}\n${fs}` : link(v.sh, f.sh);
  }
  return out;
}

/** An executor on its own WebGL2 context; batches in, replies and frames out. */
const execs = new Map<number, { ex: Executor; out: Uint8Array[]; frames: { xid: number; width: number; height: number; pixels: number[] }[]; logs: string[] }>();
let nextExec = 1;
function execOpen(width: number, height: number): number {
  const id = nextExec++;
  const g = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false })!;
  const st = { out: [] as Uint8Array[], frames: [] as { xid: number; width: number; height: number; pixels: number[] }[], logs: [] as string[], ex: null as unknown as Executor };
  st.ex = new Executor(g, {
    presentMode: 'pixels',
    send: (d) => st.out.push(d.slice()),
    drawableSize: () => ({ width, height }),
    present: (xid, f) => st.frames.push({ xid, width: f.width, height: f.height, pixels: Array.from(f.pixels!) }),
    log: (m) => st.logs.push(m),
  });
  execs.set(id, st);
  return id;
}
function execRun(id: number, bytes: number[]) {
  const st = execs.get(id)!;
  const ok = st.ex.run(new Uint8Array(bytes).buffer);
  const r = { ok, out: st.out.map((o) => Array.from(o)), frames: st.frames, logs: st.logs };
  st.out = []; st.frames = []; st.logs = [];
  return r;
}

Object.assign(globalThis, { glTest: { corpus, ffVariants, execOpen, execRun } });
