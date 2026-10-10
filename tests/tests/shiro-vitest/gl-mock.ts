/**
 * A stand-in WebGL2RenderingContext for running src/gl/exec.ts under Node:
 * every call is recorded, objects are plain tokens, shaders compile and
 * programs link, queries answer plausible limits. Pixels read back are a
 * fill color, so presenting works.
 */
export interface MockGL {
  gl: WebGL2RenderingContext;
  calls: { name: string; args: unknown[] }[];
  count(name: string): number;
  clear(): void;
}

const LIMITS: Record<number, unknown> = {
  0x0d33: 16384, // MAX_TEXTURE_SIZE
  0x8073: 2048, // MAX_3D_TEXTURE_SIZE
  0x851c: 16384, // MAX_CUBE_MAP_TEXTURE_SIZE
  0x88ff: 2048, // MAX_ARRAY_TEXTURE_LAYERS
  0x84e8: 16384, // MAX_RENDERBUFFER_SIZE
  0x0d3a: new Int32Array([16384, 16384]), // MAX_VIEWPORT_DIMS
  0x8872: 16, // MAX_TEXTURE_IMAGE_UNITS
  0x8b4d: 32, // MAX_COMBINED_TEXTURE_IMAGE_UNITS
  0x8b4c: 16, // MAX_VERTEX_TEXTURE_IMAGE_UNITS
  0x8869: 16, // MAX_VERTEX_ATTRIBS
  0x8824: 8, // MAX_DRAW_BUFFERS
  0x8cdf: 8, // MAX_COLOR_ATTACHMENTS
  0x8d57: 4, // MAX_SAMPLES
  0x1f00: 'WebKit', 0x1f01: 'WebKit WebGL', // VENDOR, RENDERER
  0x846e: new Float32Array([1, 1]), // ALIASED_LINE_WIDTH_RANGE
  0x846d: new Float32Array([1, 1024]), // ALIASED_POINT_SIZE_RANGE
};

export function mockWebGL2(): MockGL {
  const calls: { name: string; args: unknown[] }[] = [];
  let next = 1;
  const canvas = { width: 1, height: 1 };
  const constants = new Proxy({}, { get: (_t, p) => (typeof p === 'string' && /^[A-Z0-9_]+$/.test(p) ? WEBGL_CONSTANTS[p] ?? 0 : undefined) });
  const impl: Record<string, (...a: unknown[]) => unknown> = {
    getParameter: (p) => LIMITS[p as number] ?? 0,
    getExtension: () => null,
    getShaderParameter: () => true,
    getProgramParameter: (_p, pname) => (pname === 0x8b82 /* LINK_STATUS */ ? true : 0),
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getUniformLocation: () => ({ id: next++ }),
    getAttribLocation: () => 0,
    checkFramebufferStatus: () => 0x8cd5,
    readPixels: (...a) => { const out = a[6] as Uint8Array; if (out && 'fill' in out) out.fill(0x80); },
    getBufferSubData: () => undefined,
    getQueryParameter: () => 0,
  };
  const gl = new Proxy({ canvas } as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(prop)) return (constants as Record<string, number>)[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (impl[prop]) return impl[prop](...args);
        if (prop.startsWith('create')) return { id: next++, kind: prop.slice(6) };
        return undefined;
      };
    },
  });
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    clear: () => { calls.length = 0; },
  };
}

/** The WebGL2 constants exec.ts reads through `gl.NAME`. */
const WEBGL_CONSTANTS: Record<string, number> = {
  TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, COPY_READ_BUFFER: 0x8f36, COPY_WRITE_BUFFER: 0x8f37,
  PIXEL_PACK_BUFFER: 0x88eb, PIXEL_UNPACK_BUFFER: 0x88ec, UNIFORM_BUFFER: 0x8a11, FRAMEBUFFER: 0x8d40, DRAW_FRAMEBUFFER: 0x8ca9,
  READ_FRAMEBUFFER: 0x8ca8, RENDERBUFFER: 0x8d41, COLOR_ATTACHMENT0: 0x8ce0, DEPTH_STENCIL_ATTACHMENT: 0x821a, RGBA8: 0x8058,
  DEPTH24_STENCIL8: 0x88f0, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406, UNSIGNED_INT: 0x1405, NONE: 0, SCISSOR_TEST: 0x0c11,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, STENCIL_BUFFER_BIT: 0x400, NEAREST: 0x2600, LINEAR: 0x2601, MAX_SAMPLES: 0x8d57,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
  STREAM_DRAW: 0x88e0, TRIANGLES: 4, POINTS: 0, FRONT: 0x404, BACK: 0x405, UNPACK_ALIGNMENT: 0x0cf5, PACK_ALIGNMENT: 0x0d05,
  UNPACK_ROW_LENGTH: 0x0cf2, UNPACK_SKIP_PIXELS: 0x0cf4, UNPACK_SKIP_ROWS: 0x0cf3, UNPACK_IMAGE_HEIGHT: 0x806e, UNPACK_SKIP_IMAGES: 0x806d,
  ACTIVE_ATTRIBUTES: 0x8b89, ACTIVE_UNIFORMS: 0x8b86, ACTIVE_UNIFORM_BLOCKS: 0x8a36, UNIFORM_BLOCK_INDEX: 0x8a3a, UNIFORM_BLOCK_DATA_SIZE: 0x8a40,
  RENDERER: 0x1f01, MAX_TEXTURE_SIZE: 0x0d33, MAX_3D_TEXTURE_SIZE: 0x8073, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c, MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_VIEWPORT_DIMS: 0x0d3a, MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c, MAX_VERTEX_ATTRIBS: 0x8869, MAX_DRAW_BUFFERS: 0x8824, MAX_COLOR_ATTACHMENTS: 0x8cdf,
  ALIASED_LINE_WIDTH_RANGE: 0x846e, ALIASED_POINT_SIZE_RANGE: 0x846d, ANY_SAMPLES_PASSED: 0x8c2f, QUERY_RESULT_AVAILABLE: 0x8867,
  QUERY_RESULT: 0x8866, FRAMEBUFFER_COMPLETE: 0x8cd5, SEPARATE_ATTRIBS: 0x8c8d, INTERLEAVED_ATTRIBS: 0x8c8c,
};
