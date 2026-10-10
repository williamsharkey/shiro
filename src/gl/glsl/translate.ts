/**
 * Desktop GLSL (1.10–3.30) → GLSL ES 3.00 for WebGL2.
 *
 * This version rewrites at the token level: versions and qualifiers,
 * renamed built-in functions, fragment outputs, and the compatibility
 * built-ins (gl_Vertex, gl_ModelViewMatrix, gl_LightSource[n], ...), which
 * become `_tc_` attributes and uniforms the executor feeds from its
 * fixed-function state. It doesn't type-check, so desktop-only implicit
 * conversions (`float x = 1;`) are left to the WebGL compiler's error.
 */

export interface Translated {
  ok: boolean;
  log: string;
  source: string;
  version: number;
  /** compatibility attributes used: Vertex, Normal, Color, SecondaryColor, FogCoord, MultiTexCoord0..7 */
  builtinAttribs: string[];
  /** compatibility uniforms used (names without the _tc_ prefix) */
  builtinUniforms: string[];
}
export interface TranslateOptions {
  core?: boolean;
  /** glBindFragDataLocation: output name → color number */
  fragData?: Map<string, number>;
}

const MATRIX_UNIFORMS = ['ModelViewMatrix', 'ProjectionMatrix', 'ModelViewProjectionMatrix', 'NormalMatrix', 'ModelViewMatrixInverse',
  'ProjectionMatrixInverse', 'ModelViewProjectionMatrixInverse', 'ModelViewMatrixTranspose', 'ModelViewMatrixInverseTranspose', 'TextureMatrix'];
const LIGHT_FIELDS: Record<string, string> = {
  ambient: 'vec4', diffuse: 'vec4', specular: 'vec4', position: 'vec4', halfVector: 'vec4', spotDirection: 'vec3',
  spotExponent: 'float', spotCutoff: 'float', spotCosCutoff: 'float', constantAttenuation: 'float', linearAttenuation: 'float', quadraticAttenuation: 'float',
};
const MATERIAL_FIELDS: Record<string, string> = { ambient: 'vec4', diffuse: 'vec4', specular: 'vec4', emission: 'vec4', shininess: 'float' };

const FUNCTION_RENAMES: [RegExp, string][] = [
  [/\btexture2DProjLod\b/g, 'textureProjLod'], [/\btexture2DProj\b/g, 'textureProj'], [/\btexture2DLod\b/g, 'textureLod'],
  [/\btexture2DGrad(ARB|EXT)?\b/g, 'textureGrad'], [/\btexture2DRect\b/g, 'texture'], [/\btexture2D\b/g, 'texture'],
  [/\btexture3DProj\b/g, 'textureProj'], [/\btexture3DLod\b/g, 'textureLod'], [/\btexture3D\b/g, 'texture'],
  [/\btextureCubeLod\b/g, 'textureLod'], [/\btextureCube\b/g, 'texture'],
  [/\bshadow2DProj\b/g, '_tc_shadowProj'], [/\bshadow2D\b/g, '_tc_shadow'],
  [/\btexture1DLod\b/g, '_tc_texture1DLod'], [/\btexture1D\b/g, '_tc_texture1D'],
];
const TYPE_RENAMES: [RegExp, string][] = [
  [/\bsampler1D\b/g, 'sampler2D'], [/\bsampler2DRect\b/g, 'sampler2D'], [/\bsampler1DShadow\b/g, 'sampler2DShadow'],
  [/\bsampler2DRectShadow\b/g, 'sampler2DShadow'], [/\bsampler1DArray\b/g, 'sampler2DArray'],
  [/\bisampler1D\b/g, 'isampler2D'], [/\busampler1D\b/g, 'usampler2D'],
];

/** Removes comments, keeping line structure (so error line numbers still match). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

export function translateShader(input: string, stage: 'vertex' | 'fragment' | 'geometry', opts: TranslateOptions = {}): Translated {
  const out: Translated = { ok: true, log: '', source: '', version: 110, builtinAttribs: [], builtinUniforms: [] };
  if (stage === 'geometry') {
    out.ok = false;
    out.log = 'geometry shaders are not supported yet';
    return out;
  }
  let src = stripComments(input.replace(/\r\n?/g, '\n'));
  const vm = src.match(/^[ \t]*#[ \t]*version[ \t]+(\d+)([ \t]+\w+)?[ \t]*$/m);
  if (vm) {
    out.version = +vm[1];
    src = src.replace(vm[0], '');
  }
  // extensions and pragmas desktop drivers know: ES has its own set
  src = src.replace(/^[ \t]*#[ \t]*extension[^\n]*$/gm, '').replace(/^[ \t]*#[ \t]*pragma[^\n]*$/gm, '');
  // precision qualifiers are fine in ES; desktop `#ifdef GL_ES` blocks expect ES
  const legacy = out.version < 130;

  const attribs = new Set<string>();
  const uniforms = new Set<string>();
  const decls: string[] = [];
  let needFragColor = false;
  let fragDataMax = -1;

  for (const [re, to] of TYPE_RENAMES) src = src.replace(re, to);
  for (const [re, to] of FUNCTION_RENAMES) src = src.replace(re, to);
  // ES 3.00 lacks these interpolation qualifiers
  src = src.replace(/\bnoperspective\b/g, '').replace(/\bcentroid\s+(in|out|varying)\b/g, '$1');

  if (legacy) {
    if (stage === 'vertex') src = src.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out');
    else src = src.replace(/\bvarying\b/g, 'in');
  }

  // ── compatibility built-ins ──
  if (stage === 'vertex') {
    const vattr: [string, string, string][] = [
      ['gl_Vertex', 'Vertex', 'vec4'], ['gl_Normal', 'Normal', 'vec3'], ['gl_Color', 'Color', 'vec4'],
      ['gl_SecondaryColor', 'SecondaryColor', 'vec4'], ['gl_FogCoord', 'FogCoord', 'float'],
    ];
    for (let i = 0; i < 8; i++) vattr.push([`gl_MultiTexCoord${i}`, `MultiTexCoord${i}`, 'vec4']);
    for (const [gl, name, type] of vattr) {
      const re = new RegExp(`\\b${gl}\\b`, 'g');
      if (re.test(src)) { attribs.add(name); src = src.replace(re, `_tc_${name}`); decls.push(`in ${type} _tc_${name};`); }
    }
    if (/\bftransform\s*\(\s*\)/.test(src)) {
      src = src.replace(/\bftransform\s*\(\s*\)/g, '(_tc_ModelViewProjectionMatrix * _tc_Vertex)');
      uniforms.add('ModelViewProjectionMatrix');
      if (!attribs.has('Vertex')) { attribs.add('Vertex'); decls.push('in vec4 _tc_Vertex;'); }
    }
  }
  for (const m of MATRIX_UNIFORMS) {
    const re = new RegExp(`\\bgl_${m}\\b`, 'g');
    if (!re.test(src)) continue;
    uniforms.add(m);
    src = src.replace(re, `_tc_${m}`);
    decls.push(m === 'NormalMatrix' ? 'uniform mat3 _tc_NormalMatrix;' : m === 'TextureMatrix' ? 'uniform mat4 _tc_TextureMatrix[4];' : `uniform mat4 _tc_${m};`);
  }
  src = src.replace(/\bgl_LightSource\s*\[\s*(\d+)\s*\]\s*\.\s*(\w+)/g, (_m, i: string, f: string) => {
    const type = LIGHT_FIELDS[f];
    if (!type) return _m;
    const name = `LightSource${i}${f}`;
    if (!uniforms.has(name)) { uniforms.add(name); decls.push(`uniform ${type} _tc_${name};`); }
    return `_tc_${name}`;
  });
  src = src.replace(/\bgl_(Front|Back)Material\s*\.\s*(\w+)/g, (_m, side: string, f: string) => {
    const type = MATERIAL_FIELDS[f];
    if (!type) return _m;
    const name = `FrontMaterial${f[0].toUpperCase()}${f.slice(1)}`; // back material: the front's (two-sided lighting in shaders is rare)
    void side;
    if (!uniforms.has(name)) { uniforms.add(name); decls.push(`uniform ${type} _tc_${name};`); }
    return `_tc_${name}`;
  });
  if (/\bgl_LightModel\s*\.\s*ambient\b/.test(src)) {
    src = src.replace(/\bgl_LightModel\s*\.\s*ambient\b/g, '_tc_LightModelAmbient');
    uniforms.add('LightModelAmbient'); decls.push('uniform vec4 _tc_LightModelAmbient;');
  }
  if (/\bgl_Fog\s*\.\s*color\b/.test(src)) { src = src.replace(/\bgl_Fog\s*\.\s*color\b/g, '_tc_FogColor'); uniforms.add('FogColor'); decls.push('uniform vec4 _tc_FogColor;'); }
  if (/\bgl_Fog\s*\.\s*(density|start|end|scale)\b/.test(src)) {
    src = src.replace(/\bgl_Fog\s*\.\s*(density|start|end|scale)\b/g, (_m, f: string) => `_tc_FogParams.${{ density: 'x', start: 'y', end: 'z', scale: 'w' }[f]}`);
    uniforms.add('FogParams'); decls.push('uniform vec4 _tc_FogParams;');
  }
  if (/\bgl_Point\s*\.\s*size\b/.test(src)) { src = src.replace(/\bgl_Point\s*\.\s*size\b/g, '_tc_PointSize'); uniforms.add('PointSize'); decls.push('uniform float _tc_PointSize;'); }
  if (/\bgl_ClipPlane\b/.test(src)) { src = src.replace(/\bgl_ClipPlane\b/g, '_tc_ClipPlane'); uniforms.add('ClipPlane'); decls.push('uniform vec4 _tc_ClipPlane[6];'); }

  // varyings that were built-in
  const vary: [string, string, string][] = [
    ['gl_FrontColor', '_tc_FrontColor', 'vec4'], ['gl_BackColor', '_tc_BackColor', 'vec4'], ['gl_FrontSecondaryColor', '_tc_FrontSecondaryColor', 'vec4'],
    ['gl_BackSecondaryColor', '_tc_BackSecondaryColor', 'vec4'], ['gl_FogFragCoord', '_tc_FogFragCoord', 'float'],
  ];
  for (const [gl, name, type] of vary) {
    const re = new RegExp(`\\b${gl}\\b`, 'g');
    if (re.test(src)) { src = src.replace(re, name); decls.push(`${stage === 'vertex' ? 'out' : 'in'} ${type} ${name};`); }
  }
  if (/\bgl_TexCoord\b/.test(src)) { src = src.replace(/\bgl_TexCoord\b/g, '_tc_TexCoord'); decls.push(`${stage === 'vertex' ? 'out' : 'in'} vec4 _tc_TexCoord[4];`); }
  if (stage === 'fragment') {
    if (/\bgl_Color\b/.test(src)) { src = src.replace(/\bgl_Color\b/g, '_tc_FrontColor'); if (!decls.includes('in vec4 _tc_FrontColor;')) decls.push('in vec4 _tc_FrontColor;'); }
    if (/\bgl_SecondaryColor\b/.test(src)) { src = src.replace(/\bgl_SecondaryColor\b/g, '_tc_FrontSecondaryColor'); if (!decls.includes('in vec4 _tc_FrontSecondaryColor;')) decls.push('in vec4 _tc_FrontSecondaryColor;'); }
  }
  if (stage === 'vertex') {
    if (/\bgl_ClipVertex\b/.test(src)) { src = src.replace(/\bgl_ClipVertex\b/g, '_tc_ClipVertex'); decls.push('vec4 _tc_ClipVertex;'); }
    if (/\bgl_ClipDistance\b/.test(src)) { src = src.replace(/\bgl_ClipDistance\b/g, '_tc_ClipDistance'); decls.push('float _tc_ClipDistance[8];'); }
  }

  // ── fragment outputs ──
  if (stage === 'fragment') {
    if (/\bgl_FragColor\b/.test(src)) { needFragColor = true; src = src.replace(/\bgl_FragColor\b/g, '_tc_FragColor'); }
    src = src.replace(/\bgl_FragData\s*\[\s*(\d+)\s*\]/g, (_m, i: string) => { fragDataMax = Math.max(fragDataMax, +i); return `_tc_FragData${i}`; });
    if (/\bgl_FragData\b/.test(src)) { out.ok = false; out.log += 'gl_FragData with a non-constant index is not supported\n'; }
    if (needFragColor) decls.push('layout(location = 0) out vec4 _tc_FragColor;');
    for (let i = 0; i <= fragDataMax; i++) decls.push(`layout(location = ${i}) out vec4 _tc_FragData${i};`);
    if (opts.fragData?.size) {
      for (const [name, loc] of opts.fragData) {
        src = src.replace(new RegExp(`(^|;|\\n)([ \\t]*)out(\\s+\\w+\\s+${name}\\s*;)`, 'm'), `$1$2layout(location = ${loc}) out$3`);
      }
    }
    if (/\bgl_FragDepth\b/.test(src)) { /* ES 3.00 has gl_FragDepth */ }
  }

  // ── helpers for renamed functions ──
  const helpers: string[] = [];
  if (/\b_tc_shadow\b/.test(src)) helpers.push('vec4 _tc_shadow(sampler2DShadow s, vec3 c) { return vec4(texture(s, c)); }');
  if (/\b_tc_shadowProj\b/.test(src)) helpers.push('vec4 _tc_shadowProj(sampler2DShadow s, vec4 c) { return vec4(textureProj(s, c)); }');
  if (/\b_tc_texture1D\b/.test(src)) helpers.push('vec4 _tc_texture1D(sampler2D s, float x) { return texture(s, vec2(x, 0.5)); }\nvec4 _tc_texture1D(sampler2D s, float x, float b) { return texture(s, vec2(x, 0.5), b); }');
  if (/\b_tc_texture1DLod\b/.test(src)) helpers.push('vec4 _tc_texture1DLod(sampler2D s, float x, float l) { return textureLod(s, vec2(x, 0.5), l); }');

  const header = [
    '#version 300 es',
    'precision highp float;', 'precision highp int;', 'precision highp sampler2D;', 'precision highp sampler3D;', 'precision highp samplerCube;',
    'precision highp sampler2DShadow;', 'precision highp sampler2DArray;', 'precision highp samplerCubeShadow;', 'precision highp sampler2DArrayShadow;',
    'precision highp isampler2D;', 'precision highp usampler2D;', 'precision highp isampler3D;', 'precision highp usampler3D;',
    'precision highp isampler2DArray;', 'precision highp usampler2DArray;',
  ];
  // declarations go after the header but before any function; keep the original line numbering after them
  out.source = `${header.join('\n')}\n${decls.join('\n')}\n${helpers.join('\n')}\n#line 1\n${src}`;
  out.builtinAttribs = [...attribs];
  out.builtinUniforms = [...uniforms];
  return out;
}
