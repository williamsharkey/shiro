/**
 * The fixed-function pipeline (GL 1.x/2.1 compatibility) as generated GLSL ES
 * 3.00 programs: state lives in FFState, a program is generated per state
 * key and cached, and the values go in as uniforms.
 */
import * as E from './gen/enums';
import { identity, type Mat4 } from './mat';

/** Attribute slots of the compatibility built-ins (fixed-function draws, immediate mode, gl_Vertex & co). */
export const ATTR = { Vertex: 0, Normal: 1, Color: 2, SecondaryColor: 3, FogCoord: 4, TexCoord0: 5 } as const;
export const FF_TEXTURE_UNITS = 4;
export const FF_LIGHTS = 8;
export const FF_CLIP_PLANES = 6;

export interface Light {
  enabled: boolean;
  ambient: Float32Array; diffuse: Float32Array; specular: Float32Array;
  position: Float32Array; // eye coordinates
  spotDirection: Float32Array; // eye coordinates
  spotExponent: number; spotCutoff: number;
  attenuation: Float32Array; // constant, linear, quadratic
}
export interface Material {
  ambient: Float32Array; diffuse: Float32Array; specular: Float32Array; emission: Float32Array; shininess: number;
}
export interface TexUnit {
  enabled: number; // bit 1: 1D, 2: 2D, 4: 3D, 8: cube
  envMode: number;
  envColor: Float32Array;
  combineRGB: number; combineAlpha: number;
  srcRGB: number[]; srcAlpha: number[]; operandRGB: number[]; operandAlpha: number[];
  rgbScale: number; alphaScale: number;
  texGen: number; // bit per coordinate s t r q
  texGenMode: number[]; // per coordinate
  objectPlane: Float32Array[]; eyePlane: Float32Array[];
  lodBias: number;
}

const v4 = (a: number, b: number, c: number, d: number) => new Float32Array([a, b, c, d]);

export function defaultLight(i: number): Light {
  return {
    enabled: false,
    ambient: v4(0, 0, 0, 1),
    diffuse: i === 0 ? v4(1, 1, 1, 1) : v4(0, 0, 0, 1),
    specular: i === 0 ? v4(1, 1, 1, 1) : v4(0, 0, 0, 1),
    position: v4(0, 0, 1, 0),
    spotDirection: new Float32Array([0, 0, -1]),
    spotExponent: 0, spotCutoff: 180,
    attenuation: new Float32Array([1, 0, 0]),
  };
}
export function defaultMaterial(): Material {
  return { ambient: v4(0.2, 0.2, 0.2, 1), diffuse: v4(0.8, 0.8, 0.8, 1), specular: v4(0, 0, 0, 1), emission: v4(0, 0, 0, 1), shininess: 0 };
}
export function defaultTexUnit(): TexUnit {
  return {
    enabled: 0, envMode: E.MODULATE, envColor: v4(0, 0, 0, 0),
    combineRGB: E.MODULATE, combineAlpha: E.MODULATE,
    srcRGB: [E.TEXTURE, E.PREVIOUS, E.CONSTANT], srcAlpha: [E.TEXTURE, E.PREVIOUS, E.CONSTANT],
    operandRGB: [E.SRC_COLOR, E.SRC_COLOR, E.SRC_ALPHA], operandAlpha: [E.SRC_ALPHA, E.SRC_ALPHA, E.SRC_ALPHA],
    rgbScale: 1, alphaScale: 1,
    texGen: 0, texGenMode: [E.EYE_LINEAR, E.EYE_LINEAR, E.EYE_LINEAR, E.EYE_LINEAR],
    objectPlane: [v4(1, 0, 0, 0), v4(0, 1, 0, 0), v4(0, 0, 0, 0), v4(0, 0, 0, 0)],
    eyePlane: [v4(1, 0, 0, 0), v4(0, 1, 0, 0), v4(0, 0, 0, 0), v4(0, 0, 0, 0)],
    lodBias: 0,
  };
}

export class FFState {
  matrixMode = E.MODELVIEW;
  modelview: Mat4[] = [identity()];
  projection: Mat4[] = [identity()];
  texture: Mat4[][] = Array.from({ length: FF_TEXTURE_UNITS }, () => [identity()]);
  color: Mat4[] = [identity()];
  activeTexture = 0; // unit index (glActiveTexture)
  clientActiveTexture = 0;

  lighting = false;
  lights: Light[] = Array.from({ length: FF_LIGHTS }, (_, i) => defaultLight(i));
  lightModelAmbient = v4(0.2, 0.2, 0.2, 1);
  localViewer = false;
  twoSide = false;
  separateSpecular = false;
  front = defaultMaterial();
  back = defaultMaterial();
  colorMaterial = false;
  colorMaterialFace = E.FRONT_AND_BACK;
  colorMaterialMode = E.AMBIENT_AND_DIFFUSE;
  normalize = false;
  rescaleNormal = false;
  flat = false;
  fog = false;
  fogMode = E.EXP;
  fogDensity = 1; fogStart = 0; fogEnd = 1;
  fogColor = v4(0, 0, 0, 0);
  fogCoordSrc = E.FRAGMENT_DEPTH;
  colorSum = false;
  alphaTest = false;
  alphaFunc = E.ALWAYS;
  alphaRef = 0;
  units: TexUnit[] = Array.from({ length: FF_TEXTURE_UNITS }, defaultTexUnit);
  clipPlanes: Float32Array[] = Array.from({ length: FF_CLIP_PLANES }, () => v4(0, 0, 0, 0));
  clipEnabled = 0;
  pointSize = 1;
  pointSprite = false;
  pointSizeMin = 0; pointSizeMax = 1e9; pointFadeThreshold = 1;
  pointDistanceAttenuation = new Float32Array([1, 0, 0]);
  lineWidth = 1;

  current = {
    color: v4(1, 1, 1, 1),
    secondaryColor: v4(0, 0, 0, 1),
    normal: new Float32Array([0, 0, 1]),
    texCoord: Array.from({ length: FF_TEXTURE_UNITS }, () => v4(0, 0, 0, 1)),
    fogCoord: 0,
  };

  stack(): Mat4[] {
    switch (this.matrixMode) {
      case E.PROJECTION: return this.projection;
      case E.TEXTURE: return this.texture[this.activeTexture] ?? this.texture[0];
      case E.COLOR: return this.color;
      default: return this.modelview;
    }
  }
  top(): Mat4 { const s = this.stack(); return s[s.length - 1]; }
  get mv(): Mat4 { return this.modelview[this.modelview.length - 1]; }
  get proj(): Mat4 { return this.projection[this.projection.length - 1]; }
}

/** What a texture unit samples, as far as the program is concerned. */
export interface UnitInfo { target: number; base: 'rgba' | 'rgb' | 'alpha' | 'luminance' | 'la' | 'intensity' | 'depth' }

/** Everything that changes the generated program. */
export function ffKey(s: FFState, units: (UnitInfo | null)[], points: boolean): string {
  let k = '';
  if (s.lighting) {
    k += `L${s.lights.map((l) => (l.enabled ? (l.position[3] === 0 ? 'd' : l.spotCutoff !== 180 ? 's' : 'p') : '-')).join('')}`;
    k += s.localViewer ? 'v' : '';
    k += s.twoSide ? 't' : '';
    k += s.separateSpecular ? 'S' : '';
    if (s.colorMaterial) k += `m${s.colorMaterialFace}.${s.colorMaterialMode}`;
    k += s.normalize ? 'n' : s.rescaleNormal ? 'r' : '';
  }
  k += s.flat ? 'F' : '';
  if (s.fog) k += `f${s.fogMode}${s.fogCoordSrc === E.FOG_COORD ? 'c' : ''}`;
  if (s.colorSum && !s.lighting) k += 'C';
  if (s.alphaTest && s.alphaFunc !== E.ALWAYS) k += `a${s.alphaFunc}`;
  for (let i = 0; i < FF_TEXTURE_UNITS; i++) {
    const u = s.units[i], info = units[i];
    if (!u.enabled || !info) continue;
    k += `T${i}${info.target}${info.base}${u.envMode}`;
    if (u.envMode === E.COMBINE) k += `[${u.combineRGB},${u.combineAlpha},${u.srcRGB},${u.srcAlpha},${u.operandRGB},${u.operandAlpha}]`;
    if (u.texGen) k += `g${u.texGen}:${u.texGenMode}`;
  }
  if (s.clipEnabled) k += `c${s.clipEnabled}`;
  if (points) k += s.pointSprite ? 'Ps' : 'P';
  return k;
}

function samplerType(target: number): string {
  return target === E.TEXTURE_3D ? 'sampler3D' : target === E.TEXTURE_CUBE_MAP ? 'samplerCube' : 'sampler2D';
}
function texLookup(i: number, target: number): string {
  const tc = `v_tc${i}`;
  if (target === E.TEXTURE_3D) return `texture(u_tex${i}, ${tc}.xyz / ${tc}.w)`;
  if (target === E.TEXTURE_CUBE_MAP) return `texture(u_tex${i}, ${tc}.xyz)`;
  return `textureProj(u_tex${i}, ${tc}.xyw)`; // 1D textures are 2D textures one texel high
}
/** The sampled value as GL defines it for the base format. */
function baseFix(expr: string, base: UnitInfo['base']): string {
  switch (base) {
    case 'rgb': return `vec4((${expr}).rgb, 1.0)`;
    case 'alpha': return `vec4(0.0, 0.0, 0.0, (${expr}).a)`;
    case 'luminance': return `vec4((${expr}).rrr, 1.0)`;
    case 'la': return `(${expr}).rrra`;
    case 'intensity': return `(${expr}).rrrr`;
    case 'depth': return `vec4((${expr}).rrr, 1.0)`;
    default: return expr;
  }
}

function combineSource(src: number, operand: number, i: number, alpha: boolean): string {
  let v: string;
  switch (src) {
    case E.TEXTURE: v = 't'; break;
    case E.CONSTANT: v = `u_envColor${i}`; break;
    case E.PRIMARY_COLOR: v = 'primary'; break;
    case E.PREVIOUS: v = 'c'; break;
    default:
      if (src >= E.TEXTURE0 && src < E.TEXTURE0 + FF_TEXTURE_UNITS) v = `t${src - E.TEXTURE0}`;
      else v = 'c';
  }
  if (alpha) {
    return operand === E.ONE_MINUS_SRC_ALPHA ? `(1.0 - ${v}.a)` : `${v}.a`;
  }
  switch (operand) {
    case E.ONE_MINUS_SRC_COLOR: return `(vec3(1.0) - ${v}.rgb)`;
    case E.SRC_ALPHA: return `vec3(${v}.a)`;
    case E.ONE_MINUS_SRC_ALPHA: return `vec3(1.0 - ${v}.a)`;
    default: return `${v}.rgb`;
  }
}
function combineOp(mode: number, a: string[]): string {
  switch (mode) {
    case E.REPLACE: return a[0];
    case E.MODULATE: return `${a[0]} * ${a[1]}`;
    case E.ADD: return `${a[0]} + ${a[1]}`;
    case E.ADD_SIGNED: return `${a[0]} + ${a[1]} - 0.5`;
    case E.INTERPOLATE: return `mix(${a[1]}, ${a[0]}, ${a[2]})`;
    case E.SUBTRACT: return `${a[0]} - ${a[1]}`;
    case E.DOT3_RGB: case E.DOT3_RGBA: return `vec3(4.0 * dot(${a[0]} - 0.5, ${a[1]} - 0.5))`;
    default: return a[0];
  }
}

/** Generates the vertex and fragment shaders for a state. */
export function ffSource(s: FFState, units: (UnitInfo | null)[], points: boolean): { vs: string; fs: string } {
  const lit = s.lighting;
  const lights = lit ? s.lights.map((l, i) => (l.enabled ? i : -1)).filter((i) => i >= 0) : [];
  const flat = s.flat ? 'flat ' : '';
  const texUnits: number[] = [];
  for (let i = 0; i < FF_TEXTURE_UNITS; i++) if (s.units[i].enabled && units[i]) texUnits.push(i);
  const fogOn = s.fog;
  const cm = s.colorMaterial;
  const cmFront = cm && s.colorMaterialFace !== E.BACK;
  const cmBack = cm && s.colorMaterialFace !== E.FRONT;
  const cmMode = s.colorMaterialMode;

  let vs = `#version 300 es
precision highp float;
in vec4 a_Vertex;
in vec3 a_Normal;
in vec4 a_Color;
in vec4 a_SecondaryColor;
in float a_FogCoord;
${texUnits.map((i) => `in vec4 a_TexCoord${i};`).join('\n')}
uniform mat4 u_mv;
uniform mat4 u_mvp;
uniform mat3 u_nm;
uniform float u_pointSize;
${texUnits.map((i) => `uniform mat4 u_tm${i};`).join('\n')}
${flat}out vec4 v_color;
${flat}out vec4 v_secondary;
${s.twoSide && lit ? `${flat}out vec4 v_backColor;\n${flat}out vec4 v_backSecondary;` : ''}
out float v_fogDepth;
${texUnits.map((i) => `out vec4 v_tc${i};`).join('\n')}
${s.clipEnabled ? `out float v_clip[${FF_CLIP_PLANES}];\nuniform vec4 u_clipPlane[${FF_CLIP_PLANES}];` : ''}
`;
  if (lit) {
    vs += `
struct Light { vec4 ambient; vec4 diffuse; vec4 specular; vec4 position; vec3 spotDirection; float spotExponent; float spotCosCutoff; vec3 attenuation; };
struct Material { vec4 ambient; vec4 diffuse; vec4 specular; vec4 emission; float shininess; };
uniform Light u_light[${Math.max(1, lights.length)}];
uniform Material u_front;
uniform Material u_back;
uniform vec4 u_lightModelAmbient;
void lightAll(vec3 eye, vec3 n, Material m, out vec4 color, out vec4 secondary) {
  vec3 c = m.emission.rgb + u_lightModelAmbient.rgb * m.ambient.rgb;
  vec3 spec = vec3(0.0);
`;
    lights.forEach((li, k) => {
      const kind = s.lights[li].position[3] === 0 ? 'd' : s.lights[li].spotCutoff !== 180 ? 's' : 'p';
      vs += `  {
    Light l = u_light[${k}];
    vec3 L; float att = 1.0;
`;
      if (kind === 'd') vs += `    L = normalize(l.position.xyz);\n`;
      else {
        vs += `    vec3 d = l.position.xyz - eye; float dist = length(d); L = d / max(dist, 1e-20);
    att = 1.0 / (l.attenuation.x + l.attenuation.y * dist + l.attenuation.z * dist * dist);\n`;
        if (kind === 's') vs += `    float sd = dot(-L, normalize(l.spotDirection)); att *= sd < l.spotCosCutoff ? 0.0 : pow(max(sd, 0.0), l.spotExponent);\n`;
      }
      vs += `    float nl = max(dot(n, L), 0.0);
    vec3 H = normalize(L + ${s.localViewer ? 'normalize(-eye)' : 'vec3(0.0, 0.0, 1.0)'});
    float nh = max(dot(n, H), 0.0);
    float sf = nl > 0.0 ? (m.shininess == 0.0 ? 1.0 : pow(nh, m.shininess)) : 0.0;
    c += att * (l.ambient.rgb * m.ambient.rgb + nl * l.diffuse.rgb * m.diffuse.rgb);
    spec += att * sf * l.specular.rgb * m.specular.rgb;
  }
`;
    });
    vs += s.separateSpecular
      ? `  color = vec4(c, m.diffuse.a);\n  secondary = vec4(spec, 0.0);\n}\n`
      : `  color = vec4(c + spec, m.diffuse.a);\n  secondary = vec4(0.0);\n}\n`;
    const applyCM = (mat: string) => {
      switch (cmMode) {
        case E.AMBIENT: return `${mat}.ambient = a_Color;`;
        case E.DIFFUSE: return `${mat}.diffuse = a_Color;`;
        case E.SPECULAR: return `${mat}.specular = a_Color;`;
        case E.EMISSION: return `${mat}.emission = a_Color;`;
        default: return `${mat}.ambient = a_Color; ${mat}.diffuse = a_Color;`;
      }
    };
    vs += `void main() {
  vec4 eye4 = u_mv * a_Vertex;
  vec3 eye = eye4.xyz / eye4.w;
  vec3 n = u_nm * a_Normal;
  ${s.normalize || s.rescaleNormal ? 'n = normalize(n);' : ''}
  Material mf = u_front;
  ${cmFront ? applyCM('mf') : ''}
  lightAll(eye, n, mf, v_color, v_secondary);
${s.twoSide ? `  Material mb = u_back;\n  ${cmBack ? applyCM('mb') : ''}\n  lightAll(eye, -n, mb, v_backColor, v_backSecondary);\n` : ''}`;
  } else {
    vs += `void main() {
  vec4 eye4 = u_mv * a_Vertex;
  v_color = a_Color;
  v_secondary = a_SecondaryColor;
`;
  }
  vs += `  gl_Position = u_mvp * a_Vertex;
  gl_PointSize = u_pointSize;
  v_fogDepth = ${s.fogCoordSrc === E.FOG_COORD ? 'a_FogCoord' : 'abs(eye4.z / eye4.w)'};
`;
  for (const i of texUnits) {
    const u = s.units[i];
    if (u.texGen) {
      vs += `  vec4 tcg${i} = a_TexCoord${i};\n`;
      for (let c = 0; c < 4; c++) {
        if (!(u.texGen & (1 << c))) continue;
        const comp = 'xyzw'[c];
        const mode = u.texGenMode[c];
        if (mode === E.OBJECT_LINEAR) vs += `  tcg${i}.${comp} = dot(u_objPlane${i}[${c}], a_Vertex);\n`;
        else if (mode === E.SPHERE_MAP) {
          vs += `  { vec3 u = normalize(eye4.xyz); vec3 nn = normalize(u_nm * a_Normal); vec3 r = reflect(u, nn); float m = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0)); tcg${i}.${comp} = ${c === 0 ? 'r.x' : 'r.y'} / m + 0.5; }\n`;
        } else if (mode === E.REFLECTION_MAP) vs += `  tcg${i}.${comp} = reflect(normalize(eye4.xyz), normalize(u_nm * a_Normal))[${c}];\n`;
        else if (mode === E.NORMAL_MAP) vs += `  tcg${i}.${comp} = normalize(u_nm * a_Normal)[${c}];\n`;
        else vs += `  tcg${i}.${comp} = dot(u_eyePlane${i}[${c}], eye4);\n`;
      }
      vs += `  v_tc${i} = u_tm${i} * tcg${i};\n`;
    } else vs += `  v_tc${i} = u_tm${i} * a_TexCoord${i};\n`;
  }
  if (s.clipEnabled) vs += `  for (int i = 0; i < ${FF_CLIP_PLANES}; i++) v_clip[i] = dot(u_clipPlane[i], eye4);\n`;
  vs += '}\n';
  for (const i of texUnits) if (s.units[i].texGen) vs = vs.replace('uniform float u_pointSize;', `uniform float u_pointSize;\nuniform vec4 u_objPlane${i}[4];\nuniform vec4 u_eyePlane${i}[4];`);

  let fs = `#version 300 es
precision highp float;
precision highp sampler3D;
${flat}in vec4 v_color;
${flat}in vec4 v_secondary;
${s.twoSide && lit ? `${flat}in vec4 v_backColor;\n${flat}in vec4 v_backSecondary;` : ''}
in float v_fogDepth;
${texUnits.map((i) => `in vec4 v_tc${i};\nuniform ${samplerType(units[i]!.target)} u_tex${i};\nuniform vec4 u_envColor${i};`).join('\n')}
${s.clipEnabled ? `in float v_clip[${FF_CLIP_PLANES}];` : ''}
uniform vec4 u_fogColor;
uniform vec3 u_fogParams; // density, start, end
uniform float u_alphaRef;
out vec4 fragColor;
void main() {
`;
  for (let i = 0; i < FF_CLIP_PLANES; i++) if (s.clipEnabled & (1 << i)) fs += `  if (v_clip[${i}] < 0.0) discard;\n`;
  fs += s.twoSide && lit
    ? `  vec4 primary = gl_FrontFacing ? v_color : v_backColor;\n  vec4 secondary = gl_FrontFacing ? v_secondary : v_backSecondary;\n`
    : `  vec4 primary = v_color;\n  vec4 secondary = v_secondary;\n`;
  fs += `  vec4 c = primary;\n`;
  if (points && s.pointSprite) fs += `  vec2 pc = gl_PointCoord;\n`;
  for (const i of texUnits) {
    const info = units[i]!;
    const u = s.units[i];
    const lookup = points && s.pointSprite ? `texture(u_tex${i}, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y))` : texLookup(i, info.target);
    fs += `  vec4 t${i} = ${baseFix(lookup, info.base)};\n  { vec4 t = t${i};\n`;
    const b = info.base;
    switch (u.envMode) {
      case E.REPLACE:
        fs += b === 'alpha' ? '    c.a = t.a;\n' : b === 'rgb' || b === 'luminance' || b === 'depth' ? '    c.rgb = t.rgb;\n' : '    c = t;\n';
        break;
      case E.DECAL:
        fs += '    c.rgb = mix(c.rgb, t.rgb, t.a);\n';
        break;
      case E.BLEND:
        fs += b === 'alpha' ? '    c.a *= t.a;\n'
          : b === 'intensity' ? `    c = mix(c, u_envColor${i}, t);\n`
          : `    c.rgb = mix(c.rgb, u_envColor${i}.rgb, t.rgb);${b === 'rgb' || b === 'luminance' ? '' : ' c.a *= t.a;'}\n`;
        break;
      case E.ADD:
        fs += b === 'alpha' ? '    c.a *= t.a;\n' : b === 'intensity' ? '    c.rgb += t.rgb; c.a += t.a;\n' : `    c.rgb += t.rgb;${b === 'rgb' || b === 'luminance' ? '' : ' c.a *= t.a;'}\n`;
        break;
      case E.COMBINE: {
        const rgbArgs = [0, 1, 2].map((k) => combineSource(u.srcRGB[k], u.operandRGB[k], i, false));
        const aArgs = [0, 1, 2].map((k) => combineSource(u.srcAlpha[k], u.operandAlpha[k], i, true));
        const rgb = combineOp(u.combineRGB, rgbArgs);
        const alpha = u.combineRGB === E.DOT3_RGBA ? null : combineOp(u.combineAlpha, aArgs);
        fs += `    vec3 rgb = ${rgb};\n`;
        fs += alpha ? `    float al = ${alpha};\n    c = clamp(vec4(rgb * u_combineScale${i}.x, al * u_combineScale${i}.y), 0.0, 1.0);\n`
          : `    c = clamp(vec4(rgb * u_combineScale${i}.x, rgb.r * u_combineScale${i}.x), 0.0, 1.0);\n`;
        fs = fs.replace(`uniform vec4 u_envColor${i};`, `uniform vec4 u_envColor${i};\nuniform vec2 u_combineScale${i};`);
        break;
      }
      default: // MODULATE
        fs += b === 'alpha' ? '    c.a *= t.a;\n' : b === 'rgb' || b === 'luminance' || b === 'depth' ? '    c.rgb *= t.rgb;\n' : '    c *= t;\n';
    }
    fs += '  }\n';
  }
  if ((lit && s.separateSpecular) || (!lit && s.colorSum)) fs += '  c.rgb += secondary.rgb;\n';
  if (fogOn) {
    const f = s.fogMode === E.LINEAR ? '(u_fogParams.z - z) / (u_fogParams.z - u_fogParams.y)'
      : s.fogMode === E.EXP2 ? 'exp(-(u_fogParams.x * z) * (u_fogParams.x * z))' : 'exp(-u_fogParams.x * z)';
    fs += `  { float z = v_fogDepth; float f = clamp(${f}, 0.0, 1.0); c.rgb = mix(u_fogColor.rgb, c.rgb, f); }\n`;
  }
  if (s.alphaTest && s.alphaFunc !== E.ALWAYS) {
    const op: Record<number, string> = { [E.NEVER]: 'false', [E.LESS]: 'c.a < u_alphaRef', [E.EQUAL]: 'c.a == u_alphaRef', [E.LEQUAL]: 'c.a <= u_alphaRef',
      [E.GREATER]: 'c.a > u_alphaRef', [E.NOTEQUAL]: 'c.a != u_alphaRef', [E.GEQUAL]: 'c.a >= u_alphaRef' };
    fs += `  if (!(${op[s.alphaFunc] ?? 'true'})) discard;\n`;
  }
  fs += '  fragColor = c;\n}\n';
  return { vs, fs };
}

/** Which lights the program's u_light[k] are, in order. */
export function enabledLights(s: FFState): number[] {
  return s.lighting ? s.lights.map((l, i) => (l.enabled ? i : -1)).filter((i) => i >= 0) : [];
}
