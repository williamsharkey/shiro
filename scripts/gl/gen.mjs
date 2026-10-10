#!/usr/bin/env node
// Generates the GL command table shared by the guest encoder (C) and the page
// decoder (TypeScript) from Khronos' gl.xml:
//   scripts/gl/gen/tc_gen.h, scripts/gl/gen/tc_gen.c   (guest, libGLX_tabcomputer)
//   src/gl/gen/ops.ts                                   (page)
// Usage: node scripts/gl/gen.mjs [path/to/gl.xml]   (downloads a pinned gl.xml otherwise)
// The wire format is in docs/research/GL.md ("Wire format") and src/gl/wire.ts.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const GL_XML_SHA256 = 'b9ca2cfa5c676e901c20d34af3407f1687cde0f1336a5ff7a8974d04c7494ad3';
const GL_XML_URL = 'https://raw.githubusercontent.com/KhronosGroup/OpenGL-Registry/main/xml/gl.xml';

function loadXml() {
  let p = process.argv[2];
  if (!p) {
    p = join(tmpdir(), `gl-${GL_XML_SHA256.slice(0, 12)}.xml`);
    if (!existsSync(p)) execFileSync('curl', ['-sSfLo', p, GL_XML_URL]);
  }
  const xml = readFileSync(p, 'utf8');
  const sha = createHash('sha256').update(xml).digest('hex');
  if (sha !== GL_XML_SHA256) console.warn(`gl.xml sha256 ${sha} differs from the pinned ${GL_XML_SHA256}: the table may change`);
  return xml;
}

const xml = loadXml();
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const attr = (s, a) => (s.match(new RegExp(`\\b${a}="([^"]*)"`)) || [])[1];

// ── commands ──
const commands = new Map();
for (const m of xml.matchAll(/<command\b[^>]*>([\s\S]*?)<\/command>/g)) {
  const body = m[1];
  const proto = body.match(/<proto\b[^>]*>([\s\S]*?)<\/proto>/)[1];
  const name = proto.match(/<name>(\w+)<\/name>/)[1];
  const ret = strip(proto.replace(/<name>\w+<\/name>/, ''));
  const params = [];
  for (const pm of body.matchAll(/<param\b([^>]*)>([\s\S]*?)<\/param>/g)) {
    const pname = pm[2].match(/<name>(\w+)<\/name>/)[1];
    const type = strip(pm[2].replace(/<name>\w+<\/name>/, ''));
    params.push({ name: pname, type, len: attr(pm[1], 'len') });
  }
  const alias = (body.match(/<alias name="(\w+)"/) || [])[1];
  commands.set(name, { name, ret, params, alias });
}

// ── features: GL 1.0–3.3 (compatibility, so everything core removed is kept) ──
const wanted = new Set();
for (const f of xml.matchAll(/<feature api="gl" name="GL_VERSION_(\d)_(\d)"[^>]*>([\s\S]*?)<\/feature>/g)) {
  if (+f[1] * 10 + +f[2] > 33) continue;
  for (const r of f[3].matchAll(/<require\b[^>]*>([\s\S]*?)<\/require>/g))
    for (const c of r[1].matchAll(/<command name="(\w+)"/g)) wanted.add(c[1]);
}
// Extensions apps call by their own names, beyond the aliases of core functions.
const EXTENSIONS = [
  'GL_ARB_shader_objects', 'GL_ARB_vertex_program', 'GL_KHR_debug', 'GL_ARB_debug_output',
  'GL_EXT_framebuffer_blit', 'GL_EXT_framebuffer_multisample', 'GL_ARB_instanced_arrays',
  'GL_ARB_draw_instanced', 'GL_EXT_draw_instanced', 'GL_ARB_vertex_array_object', 'GL_APPLE_vertex_array_object',
  'GL_ARB_texture_storage', 'GL_ARB_timer_query', 'GL_ARB_sampler_objects', 'GL_ARB_get_program_binary',
  'GL_ARB_separate_shader_objects', 'GL_ARB_clip_control', 'GL_ARB_invalidate_subdata', 'GL_ARB_copy_image',
  'GL_EXT_texture_object', 'GL_EXT_blend_color', 'GL_EXT_blend_minmax', 'GL_EXT_blend_func_separate',
  'GL_ARB_multitexture', 'GL_ARB_vertex_buffer_object', 'GL_ARB_occlusion_query', 'GL_ARB_point_parameters',
  'GL_ARB_window_pos', 'GL_EXT_framebuffer_object', 'GL_ARB_framebuffer_object', 'GL_ARB_map_buffer_range',
  'GL_ARB_vertex_shader', 'GL_ARB_draw_buffers', 'GL_ARB_texture_compression', 'GL_EXT_gpu_shader4',
  'GL_ARB_texture_multisample', 'GL_ARB_buffer_storage', 'GL_ARB_base_instance', 'GL_ARB_multi_draw_indirect',
];
for (const e of EXTENSIONS) {
  const m = xml.match(new RegExp(`<extension name="${e}"[^>]*>([\\s\\S]*?)</extension>`));
  if (!m) throw new Error(`no extension ${e}`);
  for (const c of m[1].matchAll(/<command name="(\w+)"/g)) wanted.add(c[1]);
}
// glX-adjacent and glvnd-required names are added by the C side.

// Core targets of aliases: an alias shares its target's opcode and C function.
const aliasOf = new Map();
for (const [n, c] of commands) {
  if (!c.alias || !commands.has(c.alias)) continue;
  if (wanted.has(c.alias) || wanted.has(n)) aliasOf.set(n, c.alias);
}
// Every wanted alias brings its target; every target brings its known aliases.
for (const [a, t] of aliasOf) { wanted.add(t); wanted.add(a); }
const primaries = [...wanted].filter((n) => !aliasOf.has(n)).sort();

// ── types ──
const SCALAR = {
  GLenum: 'u', GLbitfield: 'u', GLuint: 'u', GLhandleARB: 'u', GLint: 'i', GLsizei: 'i', GLboolean: 'u',
  GLbyte: 'i', GLubyte: 'u', GLshort: 'i', GLushort: 'u', GLchar: 'i', GLcharARB: 'i', GLhalf: 'u', GLhalfARB: 'u',
  GLclampx: 'i', GLfixed: 'i', GLfloat: 'f', GLclampf: 'f', GLdouble: 'd', GLclampd: 'd',
  GLintptr: 'q', GLintptrARB: 'q', GLsizeiptr: 'q', GLsizeiptrARB: 'q', GLint64: 'q', GLint64EXT: 'q',
  GLuint64: 'q', GLuint64EXT: 'q', GLsync: 'q',
};
// array element kinds: code, C element size
const ELEM = {
  GLfloat: ['Af', 4], GLclampf: ['Af', 4], GLdouble: ['Ad', 8], GLint: ['Ai', 4], GLsizei: ['Ai', 4], GLuint: ['Au', 4],
  GLenum: ['Au', 4], GLhandleARB: ['Au', 4], GLshort: ['As', 2], GLushort: ['AS', 2], GLbyte: ['Ac', 1], GLubyte: ['Ab', 1],
  GLboolean: ['Ab', 1], GLchar: ['Ab', 1], void: ['Ab', 1], GLint64: ['Aq', 8], GLuint64: ['Aq', 8], GLfixed: ['Ai', 4],
  GLhalf: ['AS', 2],
};

// Commands written by hand in scripts/gl/libGLX_tabcomputer.c (guest shadow state,
// client memory, replies); they still get an opcode, and their wire spec is given here.
// Spec codes: i u f d q (scalars), A? (array: f i u s S c b d q), Z (C string), and
// a trailing '>' marks a call the page answers (a reply).
const MANUAL = {
  glBegin: 'u', glEnd: '', glNewList: 'uu', glEndList: '',
  glGenLists: 'iu', // range, first name (chosen in the guest)
  glTexImage1D: 'uiiiiuuAb', glTexImage2D: 'uiiiiiuuAb', glTexImage3D: 'uiiiiiiuuAb',
  glTexSubImage1D: 'uiiiuuAb', glTexSubImage2D: 'uiiiiiuuAb', glTexSubImage3D: 'uiiiiiiiuuAb',
  glCompressedTexImage2D: 'uiuiiiiAb', glCompressedTexSubImage2D: 'uiiiiiuiAb',
  glCompressedTexImage3D: 'uiuiiiiiAb', glCompressedTexSubImage3D: 'uiiiiiiiuiAb',
  glBufferData: 'uqAbu', glBufferSubData: 'uqqAb',
  glShaderSource: 'uAb', // shader, the concatenated source
  glVertexAttribPointer: 'uiuuiq', glVertexAttribIPointer: 'uiuiq',
  glVertexPointer: 'iuiq', glNormalPointer: 'uiq', glColorPointer: 'iuiq', glTexCoordPointer: 'iuiq',
  glSecondaryColorPointer: 'iuiq', glFogCoordPointer: 'uiq', glEdgeFlagPointer: 'iq', glIndexPointer: 'uiq',
  glDrawElements: 'uiuq', glDrawElementsInstanced: 'uiuqi', glDrawRangeElements: 'uuuiuq',
  glDrawElementsBaseVertex: 'uiuqi', glDrawRangeElementsBaseVertex: 'uuuiuqi', glDrawElementsInstancedBaseVertex: 'uiuqii',
  glMultiDrawElements: 'uAiuAqi', glMultiDrawElementsBaseVertex: 'uAiuAqiAi',
  glDrawArrays: 'uii', glDrawArraysInstanced: 'uiii', glMultiDrawArrays: 'uAiAii',
  glArrayElement: 'i',
  glInterleavedArrays: 'uiq',
  glClientUploadArray: 'uuqAb', // (internal) attribute slot, first vertex, offset, bytes of a client array
  glBindBuffer: 'uu',
  glGenTextures: 'Au', glGenBuffers: 'Au', glGenFramebuffers: 'Au', glGenRenderbuffers: 'Au', glGenQueries: 'Au',
  glGenVertexArrays: 'Au', glGenSamplers: 'Au', glGenTransformFeedbacks: 'Au', glGenProgramPipelines: 'Au',
  glCreateShader: 'uu', glCreateProgram: 'u', glFenceSync: 'quu', glCreateShaderProgramv: 'uuAb',
  glMapBuffer: 'u>', glMapBufferRange: 'uqqu>', glUnmapBuffer: 'u', glFlushMappedBufferRange: 'uqq',
  glReadPixels: 'iiiiuuq>', glGetTexImage: 'uiuuq>', glGetCompressedTexImage: 'uiq>',
  glGetBufferSubData: 'uqq>',
  glFinish: '>', glFlush: '',
  glPixelStorei: 'ui', glPixelStoref: 'uf',
  glTexParameterfv: 'uuAf', glTexParameteriv: 'uuAi', glTexParameterIiv: 'uuAi', glTexParameterIuiv: 'uuAu',
  glSamplerParameterfv: 'uuAf', glSamplerParameteriv: 'uuAi', glSamplerParameterIiv: 'uuAi', glSamplerParameterIuiv: 'uuAu',
  glLightfv: 'uuAf', glLightiv: 'uuAi', glLightModelfv: 'uAf', glLightModeliv: 'uAi',
  glMaterialfv: 'uuAf', glMaterialiv: 'uuAi', glFogfv: 'uAf', glFogiv: 'uAi',
  glTexEnvfv: 'uuAf', glTexEnviv: 'uuAi', glTexGenfv: 'uuAf', glTexGeniv: 'uuAi', glTexGendv: 'uuAd',
  glPointParameterfv: 'uAf', glPointParameteriv: 'uAi',
  glCallLists: 'iuAb',
  glBitmap: 'iiffffAb', glDrawPixels: 'iiuuAb', glPolygonStipple: 'Ab',
  glMap1f: 'uffiiAf', glMap1d: 'uddiiAd', glMap2f: 'uffiiffiiAf', glMap2d: 'uddiiddiiAd',
  glPixelMapfv: 'uiAf', glPixelMapuiv: 'uiAu', glPixelMapusv: 'uiAS',
  glFeedbackBuffer: 'iu', glSelectBuffer: 'i', glRenderMode: 'u>',
  glClearBufferfv: 'uiAf', glClearBufferiv: 'uiAi', glClearBufferuiv: 'uiAu',
  glDebugMessageCallback: '', glDebugMessageControl: '', glDebugMessageInsert: '', glPushDebugGroup: '', glPopDebugGroup: '',
  glObjectLabel: '', glObjectPtrLabel: '', glGetDebugMessageLog: '', glGetObjectLabel: '', glGetObjectPtrLabel: '', glGetPointerv: '',
  glTransformFeedbackVaryings: 'uiAbu', // program, count, NUL-separated names, mode
  glBindAttribLocation: 'uuZ', glBindFragDataLocation: 'uuZ', glBindFragDataLocationIndexed: 'uuuZ',
  glGetError: '>', glGetString: 'u>', glGetStringi: 'uu>',
  glClientWaitSync: 'quq', glWaitSync: 'quq', glDeleteSync: 'q', glIsSync: 'q',
  glEnableClientState: 'u', glDisableClientState: 'u', glClientActiveTexture: 'u',
  glEnableVertexAttribArray: 'u', glDisableVertexAttribArray: 'u', glBindVertexArray: 'u',
  glDeleteBuffers: 'Au', glDeleteVertexArrays: 'Au', glVertexAttribDivisor: 'uu',
  glPrimitiveRestartIndex: 'u', glUseProgram: 'u', glLinkProgram: 'u', glCompileShader: 'u',
  glDeleteProgram: 'u', glDeleteShader: 'u', glAttachShader: 'uu', glDetachShader: 'uu', glValidateProgram: 'u',
  glGetQueryObjectiv: 'uu>', glGetQueryObjectuiv: 'uu>', glGetQueryObjecti64v: 'uu>', glGetQueryObjectui64v: 'uu>',
  glGetIntegerv: 'u>', glGetFloatv: 'u>', glGetDoublev: 'u>', glGetBooleanv: 'u>', glGetInteger64v: 'u>',
  glGetIntegeri_v: 'uu>', glGetBooleani_v: 'uu>', glGetInteger64i_v: 'uu>',
  glGetTexParameteriv: 'uu>', glGetTexParameterfv: 'uu>', glGetTexLevelParameteriv: 'uiu>', glGetTexLevelParameterfv: 'uiu>',
  glGetFramebufferAttachmentParameteriv: 'uuu>', glGetRenderbufferParameteriv: 'uu>', glCheckFramebufferStatus: 'u>',
  glGetBufferParameteriv: 'uu>', glGetBufferParameteri64v: 'uu>', glGetQueryiv: 'uu>',
  glGetProgramInfo: 'u>', // (internal) everything about a linked program at once
  glGetShaderInfo: 'u>', // (internal) compile status and log
  glGetVertexAttribiv: 'uu>', glGetVertexAttribfv: 'uu>', glGetVertexAttribdv: 'uu>', glGetVertexAttribIiv: 'uu>', glGetVertexAttribIuiv: 'uu>',
  glGetUniformfv: 'ui>', glGetUniformiv: 'ui>', glGetUniformuiv: 'ui>', glGetUniformdv: 'ui>',
  glGetLightfv: 'uu>', glGetMaterialfv: 'uu>', glGetTexEnvfv: 'uu>', glGetTexEnviv: 'uu>', glGetLightiv: 'uu>', glGetMaterialiv: 'uu>',
  glGetSamplerParameteriv: 'uu>', glGetSamplerParameterfv: 'uu>', glGetMultisamplefv: 'uu>', glGetInternalformativ: 'uuui>',
  glIsEnabled: 'u>', glIsEnabledi: 'uu>',
  glIsTexture: 'u>', glIsBuffer: 'u>', glIsFramebuffer: 'u>', glIsRenderbuffer: 'u>', glIsProgram: 'u>', glIsShader: 'u>',
  glIsList: 'u>', glIsQuery: 'u>', glIsVertexArray: 'u>', glIsSampler: 'u>', glIsTransformFeedback: 'u>', glIsProgramPipeline: 'u>',
  glAreTexturesResident: 'Au>', glGetClipPlane: 'u>', glGetPixelMapfv: 'u>', glGetPixelMapuiv: 'u>', glGetPixelMapusv: 'u>',
  glGetPolygonStipple: '>', glGetMapdv: 'uu>', glGetMapfv: 'uu>', glGetMapiv: 'uu>', glGetTexGendv: 'uu>', glGetTexGenfv: 'uu>', glGetTexGeniv: 'uu>',
  glGetActiveAttrib: '', glGetActiveUniform: '', glGetAttachedShaders: '', glGetAttribLocation: '', glGetProgramiv: '',
  glGetProgramInfoLog: '', glGetShaderiv: '', glGetShaderInfoLog: '', glGetShaderSource: '', glGetUniformLocation: '',
  glGetActiveUniformsiv: '', glGetActiveUniformName: '', glGetUniformIndices: '', glGetUniformBlockIndex: '',
  glGetActiveUniformBlockiv: '', glGetActiveUniformBlockName: '', glGetFragDataLocation: '', glGetFragDataIndex: '',
  glGetTransformFeedbackVarying: '', glGetSynciv: '', glGetBufferPointerv: '', glGetVertexAttribPointerv: '',
  glGetShaderPrecisionFormat: '', glGetProgramBinary: '', glProgramBinary: '', glGetCompressedTexImage_: '',
  glGetHandleARB: '', glGetObjectParameterivARB: '', glGetObjectParameterfvARB: '', glGetInfoLogARB: '', glGetAttachedObjectsARB: '',
  glDeleteObjectARB: '', glGetProgramivARB: '', glGetProgramStringARB: '', glGetProgramEnvParameterdvARB: '',
  glGetProgramEnvParameterfvARB: '', glGetProgramLocalParameterdvARB: '', glGetProgramLocalParameterfvARB: '',
  glGetVertexAttribPointervARB: '', glGetQueryObjecti64vEXT: '', glGetQueryObjectui64vEXT: '',
  glGetProgramPipelineiv: '', glGetProgramPipelineInfoLog: '', glGetSamplerParameterIiv: '', glGetSamplerParameterIuiv: '',
  glGetTexParameterIiv: '', glGetTexParameterIuiv: '', glGetnUniformfv: '', glQueryCounter: 'uu', glGetQueryIndexediv: '',
  glProgramStringARB: 'uuAb',
};
delete MANUAL.glGetCompressedTexImage_;

// ── classify ──
function pointerInfo(p) {
  const m = p.type.match(/^(const\s+)?(\w+)\s*(\*+)\s*(const)?\s*(\*)?$/);
  if (!m) return null;
  return { isConst: !!m[1], base: m[2], depth: m[3].length + (m[5] ? 1 : 0) };
}
function lenExpr(len, params) {
  if (!len) return null;
  if (/^\d+$/.test(len)) return len;
  const m = len.match(/^(\w+)(?:\s*\*\s*(\d+))?$/);
  if (m && params.some((q) => q.name === m[1])) return m[2] ? `(${m[1]})*${m[2]}` : `(${m[1]})`;
  return null;
}
const PNAME_COMPSIZE = new Set(); // COMPSIZE(pname): count from tc_pname_count()

const table = [];
const skipped = [];
for (const name of primaries) {
  const c = commands.get(name);
  if (!c) throw new Error(`no command ${name}`);
  if (name in MANUAL) { table.push({ name, c, spec: MANUAL[name], manual: true }); continue; }
  if (c.ret !== 'void') { table.push({ name, c, spec: '>', manual: true, auto: 'ret' }); continue; }
  let spec = '';
  let ok = true;
  const args = [];
  for (const p of c.params) {
    if (SCALAR[p.type] !== undefined) { spec += SCALAR[p.type]; args.push({ p, kind: SCALAR[p.type] }); continue; }
    const pi = pointerInfo(p);
    if (!pi || pi.depth !== 1 || !pi.isConst || !ELEM[pi.base]) { ok = false; break; }
    const [code, size] = ELEM[pi.base];
    if (p.len === 'COMPSIZE(pname)') { PNAME_COMPSIZE.add(name); spec += code; args.push({ p, kind: code, size, len: `tc_pname_count(${JSON.stringify(name)}, pname)` }); continue; }
    if (!p.len && (pi.base === 'GLchar' || pi.base === 'GLcharARB')) { spec += 'Z'; args.push({ p, kind: 'Z' }); continue; }
    const le = lenExpr(p.len, c.params);
    if (!le) { ok = false; break; }
    spec += code; args.push({ p, kind: code, size, len: le });
  }
  if (!ok) { table.push({ name, c, spec: '', manual: true, auto: 'unsupported' }); skipped.push(name); continue; }
  table.push({ name, c, spec, manual: false, args });
}
// Internal commands with no gl.xml entry.
const INTERNAL = ['glClientUploadArray', 'glGetProgramInfo', 'glGetShaderInfo', 'tcMakeCurrent', 'tcSwapBuffers', 'tcContextInfo',
  'tcCreateContext', 'tcDestroyContext', 'tcDrawableGone', 'tcHello'];
const INTERNAL_SPEC = {
  glClientUploadArray: MANUAL.glClientUploadArray, glGetProgramInfo: MANUAL.glGetProgramInfo, glGetShaderInfo: MANUAL.glGetShaderInfo,
  tcHello: 'uuAb>',       // protocol version, pid, program name
  tcCreateContext: 'uuuuu', // context id, share context id (0 none), major, minor, profile/flags
  tcDestroyContext: 'u',
  tcMakeCurrent: 'uuuu',  // context id, draw drawable XID, read drawable XID, fbconfig id
  tcContextInfo: '>',     // strings and limits of the current context
  tcSwapBuffers: 'uu',     // drawable XID, frame number
  tcDrawableGone: 'u',
};
for (const n of INTERNAL) table.push({ name: n, c: null, spec: INTERNAL_SPEC[n], manual: true, internal: true });
table.sort((a, b) => (a.internal === b.internal ? (a.name < b.name ? -1 : 1) : a.internal ? -1 : 1));
table.forEach((t, i) => { t.op = i + 1; });

const protoHash = createHash('sha256').update(table.map((t) => `${t.name}:${t.spec}`).join('\n')).digest('hex').slice(0, 8);
const PROTOCOL = parseInt(protoHash, 16) >>> 0;

// ── enums (C header: every GL_ enum in the feature set and the extensions above) ──
const enumVals = new Map();
for (const m of xml.matchAll(/<enum\b([^>]*)\/>/g)) {
  const n = attr(m[1], 'name'), v = attr(m[1], 'value'), api = attr(m[1], 'api');
  if (!n || !v || (api && api !== 'gl')) continue;
  if (!enumVals.has(n)) enumVals.set(n, v);
}

// ── C ──
const ctype = (t) => t.replace(/\bconst\b\s*/g, 'const ').trim();
const cparams = (c) => c.params.length ? c.params.map((p) => {
  const t = ctype(p.type);
  return t.endsWith('*') ? `${t}${p.name}` : `${t} ${p.name}`;
}).join(', ') : 'void';
const GLTYPES = `#include <stdint.h>
#include <stddef.h>
typedef unsigned int GLenum; typedef unsigned char GLboolean; typedef unsigned int GLbitfield; typedef void GLvoid;
typedef int8_t GLbyte; typedef uint8_t GLubyte; typedef int16_t GLshort; typedef uint16_t GLushort; typedef int GLint;
typedef unsigned int GLuint; typedef int32_t GLclampx; typedef int GLsizei; typedef float GLfloat; typedef float GLclampf;
typedef double GLdouble; typedef double GLclampd; typedef char GLchar; typedef char GLcharARB; typedef unsigned int GLhandleARB;
typedef uint16_t GLhalf; typedef uint16_t GLhalfARB; typedef int32_t GLfixed; typedef intptr_t GLintptr; typedef intptr_t GLintptrARB;
typedef ptrdiff_t GLsizeiptr; typedef ptrdiff_t GLsizeiptrARB; typedef int64_t GLint64; typedef int64_t GLint64EXT;
typedef uint64_t GLuint64; typedef uint64_t GLuint64EXT; typedef struct __GLsync *GLsync; typedef void *GLeglImageOES;
typedef void (*GLDEBUGPROC)(GLenum source, GLenum type, GLuint id, GLenum severity, GLsizei length, const GLchar *message, const void *userParam);
typedef GLDEBUGPROC GLDEBUGPROCARB; typedef GLDEBUGPROC GLDEBUGPROCKHR;
`;
const usedEnums = [...enumVals].filter(([n]) => /^GL_/.test(n));
let h = `/* Generated by scripts/gl/gen.mjs from Khronos gl.xml. Do not edit. */
#ifndef TC_GEN_H
#define TC_GEN_H
${GLTYPES}
#define TC_PROTOCOL 0x${protoHash}u
#define TC_NOPS ${table.length + 1}
`;
for (const [n, v] of usedEnums) h += `#define ${n} ${v}\n`;
h += '\nenum {\n';
for (const t of table) h += `  OP_${t.name} = ${t.op},\n`;
h += '};\n\n';
for (const t of table) if (t.c) h += `${ctype(t.c.ret)} tc_${t.name}(${cparams(t.c)});\n`;
h += `\nstruct tc_proc { const char *name; void *fn; };\nextern const struct tc_proc tc_procs[];\nextern const unsigned tc_nprocs;\n#endif\n`;

let cc = `/* Generated by scripts/gl/gen.mjs from Khronos gl.xml. Do not edit. */
#include <string.h>
#include "tc_gen.h"
#include "../tc.h"

`;
const words = (k) => (k === 'd' || k === 'q' ? 2 : 1);
for (const t of table) {
  if (!t.c) continue;
  const c = t.c;
  if (t.manual) {
    // weak stub: the hand-written one in libGLX_tabcomputer.c wins
    const ret = ctype(c.ret);
    const body = ret === 'void' ? '' : ' return 0;';
    cc += `__attribute__((weak)) ${ret} tc_${t.name}(${cparams(c)}) { ${c.params.map((p) => `(void)${p.name};`).join(' ')} tc_unimplemented("${t.name}");${body} }\n`;
    continue;
  }
  const fixed = t.args.reduce((s, a) => s + (a.kind.length === 1 ? words(a.kind) : 0), 0);
  const arrays = t.args.filter((a) => a.kind.length > 1);
  cc += `void tc_${t.name}(${cparams(c)}) {\n`;
  let lenSum = `${fixed}`;
  for (const a of arrays) {
    if (a.kind === 'Z') cc += `  size_t n_${a.p.name} = ${a.p.name} ? strlen(${a.p.name}) + 1 : 0;\n`;
    else cc += `  size_t n_${a.p.name} = ${a.p.name} ? (size_t)(${a.len}) * ${a.size} : 0;\n`;
    lenSum += ` + 1 + ((n_${a.p.name} + 3) >> 2)`;
  }
  cc += `  uint32_t *_w = tc_begin(${lenSum}, OP_${t.name});\n  if (!_w) return;\n`;
  let i = 0;
  const dyn = arrays.length > 0;
  for (const a of t.args) {
    if (a.kind === 'f' || a.kind === 'i' || a.kind === 'u') {
      if (a.kind === 'f') cc += dyn ? `  memcpy(_w, &${a.p.name}, 4); _w++;\n` : `  memcpy(_w + ${i}, &${a.p.name}, 4);\n`;
      else cc += dyn ? `  *_w++ = (uint32_t)${a.p.name};\n` : `  _w[${i}] = (uint32_t)${a.p.name};\n`;
      i += 1;
    } else if (a.kind === 'd') {
      cc += dyn ? `  memcpy(_w, &${a.p.name}, 8); _w += 2;\n` : `  memcpy(_w + ${i}, &${a.p.name}, 8);\n`; i += 2;
    } else if (a.kind === 'q') {
      cc += dyn ? `  { int64_t _q = (int64_t)${a.p.name}; memcpy(_w, &_q, 8); } _w += 2;\n` : `  { int64_t _q = (int64_t)${a.p.name}; memcpy(_w + ${i}, &_q, 8); }\n`; i += 2;
    } else {
      if (!dyn) throw new Error('array in fixed');
      cc += `  _w = tc_put_array(_w, ${a.p.name}, n_${a.p.name});\n`;
    }
  }
  cc += `  tc_end();\n}\n`;
}
const procs = [];
for (const t of table) if (t.c) procs.push([t.name, t.name]);
for (const [a, tg] of aliasOf) if (table.some((t) => t.name === tg && t.c)) procs.push([a, tg]);
procs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
cc += `\nconst struct tc_proc tc_procs[] = {\n${procs.map(([n, f]) => `  { "${n}", (void *)tc_${f} },`).join('\n')}\n};\nconst unsigned tc_nprocs = ${procs.length};\n`;
cc += `\nint tc_pname_count(const char *fn, GLenum pname) {\n  (void)fn;\n  switch (pname) {\n`;
cc += `  case GL_AMBIENT: case GL_DIFFUSE: case GL_SPECULAR: case GL_EMISSION: case GL_POSITION: case GL_AMBIENT_AND_DIFFUSE:\n`;
cc += `  case GL_LIGHT_MODEL_AMBIENT: case GL_FOG_COLOR: case GL_TEXTURE_ENV_COLOR: case GL_TEXTURE_BORDER_COLOR:\n`;
cc += `  case GL_OBJECT_PLANE: case GL_EYE_PLANE: case GL_TEXTURE_SWIZZLE_RGBA: return 4;\n`;
cc += `  case GL_SPOT_DIRECTION: case GL_COLOR_INDEXES: case GL_POINT_DISTANCE_ATTENUATION: return 3;\n`;
cc += `  default: return 1;\n  }\n}\n`;

mkdirSync(join(here, 'gen'), { recursive: true });
writeFileSync(join(here, 'gen/tc_gen.h'), h);
writeFileSync(join(here, 'gen/tc_gen.c'), cc);

// ── TypeScript ──
let ts = `// Generated by scripts/gl/gen.mjs from Khronos gl.xml. Do not edit.
// [name, wire spec] by opcode (index). Spec codes: src/gl/wire.ts.
export const PROTOCOL = 0x${protoHash};
export const OPS: readonly (readonly [string, string])[] = [
  ['', ''],
${table.map((t) => `  [${JSON.stringify(t.name)}, ${JSON.stringify(t.spec)}],`).join('\n')}
];
export const OP: Record<string, number> = Object.fromEntries(OPS.map(([n], i) => [n, i]));
`;
mkdirSync(join(root, 'src/gl/gen'), { recursive: true });
writeFileSync(join(root, 'src/gl/gen/ops.ts'), ts);

// TS enum constants for the feature set (core 1.0–3.3 + compatibility + the extensions above)
const featureEnums = new Set();
for (const f of xml.matchAll(/<feature api="gl" name="GL_VERSION_(\d)_(\d)"[^>]*>([\s\S]*?)<\/feature>/g)) {
  if (+f[1] * 10 + +f[2] > 46) continue;
  for (const e of f[3].matchAll(/<enum name="(\w+)"/g)) featureEnums.add(e[1]);
}
for (const e of [...EXTENSIONS, 'GL_EXT_texture_compression_s3tc', 'GL_EXT_texture_filter_anisotropic', 'GL_ARB_texture_rectangle', 'GL_EXT_bgra', 'GL_ARB_depth_clamp', 'GL_EXT_texture_sRGB']) {
  const m = xml.match(new RegExp(`<extension name="${e}"[^>]*>([\\s\\S]*?)</extension>`));
  if (m) for (const x of m[1].matchAll(/<enum name="(\w+)"/g)) featureEnums.add(x[1]);
}
let te = `// Generated by scripts/gl/gen.mjs from Khronos gl.xml. Do not edit.\n/* eslint-disable */\n`;
for (const n of [...featureEnums].sort()) { const v = enumVals.get(n); if (v && !/^0x[0-9A-F]{9,}/i.test(v)) te += `export const ${n.slice(3).replace(/^(\d)/, '_$1')} = ${v};\n`; }
writeFileSync(join(root, 'src/gl/gen/enums.ts'), te);

console.log(`${table.length} ops (${table.filter((t) => !t.manual).length} generated, ${table.filter((t) => t.manual).length} by hand), ${procs.length} names, protocol ${protoHash}; ${skipped.length} without encoder: ${skipped.slice(0, 30).join(' ')}${skipped.length > 30 ? ' …' : ''}`);
