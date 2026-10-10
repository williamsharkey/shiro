/**
 * Desktop GL pixel formats on WebGL2: picking a WebGL2 internal format for a
 * desktop one, converting client pixels to what WebGL2 accepts (BGRA, packed
 * types, legacy formats, unpack rules), and packing pixels read back.
 */
import * as E from './gen/enums';
import type { UnitInfo } from './ff';

export interface PixelStore { rowLength: number; imageHeight: number; skipPixels: number; skipRows: number; skipImages: number; alignment: number }
export const defaultPixelStore = (): PixelStore => ({ rowLength: 0, imageHeight: 0, skipPixels: 0, skipRows: 0, skipImages: 0, alignment: 4 });

export function components(format: number): number {
  switch (format) {
    case E.RED: case E.GREEN: case E.BLUE: case E.ALPHA: case E.LUMINANCE: case E.DEPTH_COMPONENT: case E.STENCIL_INDEX:
    case E.RED_INTEGER: case E.GREEN_INTEGER: case E.BLUE_INTEGER: case E.ALPHA_INTEGER: case E.COLOR_INDEX: case E.INTENSITY: return 1;
    case E.RG: case E.LUMINANCE_ALPHA: case E.RG_INTEGER: case E.DEPTH_STENCIL: return 2;
    case E.RGB: case E.BGR: case E.RGB_INTEGER: case E.BGR_INTEGER: return 3;
    default: return 4;
  }
}
/** Bytes per component, or per pixel for packed types (packed = true). */
export function typeSize(type: number): { size: number; packed: boolean } {
  switch (type) {
    case E.UNSIGNED_BYTE: case E.BYTE: return { size: 1, packed: false };
    case E.UNSIGNED_SHORT: case E.SHORT: case E.HALF_FLOAT: return { size: 2, packed: false };
    case E.UNSIGNED_INT: case E.INT: case E.FLOAT: return { size: 4, packed: false };
    case E.UNSIGNED_BYTE_3_3_2: case E.UNSIGNED_BYTE_2_3_3_REV: return { size: 1, packed: true };
    case E.UNSIGNED_SHORT_5_6_5: case E.UNSIGNED_SHORT_5_6_5_REV: case E.UNSIGNED_SHORT_4_4_4_4: case E.UNSIGNED_SHORT_4_4_4_4_REV:
    case E.UNSIGNED_SHORT_5_5_5_1: case E.UNSIGNED_SHORT_1_5_5_5_REV: return { size: 2, packed: true };
    case E.FLOAT_32_UNSIGNED_INT_24_8_REV: return { size: 8, packed: true };
    default: return { size: 4, packed: true };
  }
}
export function pixelSize(format: number, type: number): number {
  const t = typeSize(type);
  return t.packed ? t.size : t.size * components(format);
}
/** Layout of an image in client memory under the pixel store rules. */
export function imageLayout(ps: PixelStore, w: number, h: number, format: number, type: number) {
  const group = pixelSize(format, type);
  const rowLen = ps.rowLength > 0 ? ps.rowLength : w;
  let rowBytes = rowLen * group;
  const ts = typeSize(type).size;
  const a = ps.alignment;
  if (ts < a || typeSize(type).packed) rowBytes = Math.ceil(rowBytes / a) * a;
  const imgRows = ps.imageHeight > 0 ? ps.imageHeight : h;
  const start = ps.skipImages * imgRows * rowBytes + ps.skipRows * rowBytes + ps.skipPixels * group;
  return { group, rowBytes, imageBytes: imgRows * rowBytes, start };
}
/** Copies an image to tightly packed rows (alignment 1). */
export function tighten(src: Uint8Array, ps: PixelStore, w: number, h: number, d: number, format: number, type: number): Uint8Array {
  const L = imageLayout(ps, w, h, format, type);
  const row = w * L.group;
  if (L.start === 0 && L.rowBytes === row && (d === 1 || L.imageBytes === row * h)) return src.subarray(0, row * h * d);
  const out = new Uint8Array(row * h * d);
  for (let z = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      const o = L.start + z * L.imageBytes + y * L.rowBytes;
      if (o + row <= src.length) out.set(src.subarray(o, o + row), (z * h + y) * row);
    }
  }
  return out;
}

/** What a desktop internal format becomes in WebGL2, and which pixels it is uploaded from. */
export interface TexFormat {
  internal: number; format: number; type: number;
  base: UnitInfo['base'];
  /** renderable/filterable notes for glGetTexLevelParameter */
  bits: [number, number, number, number, number, number]; // r g b a depth stencil
  integer?: boolean;
}
const F = (internal: number, format: number, type: number, base: UnitInfo['base'], bits: TexFormat['bits'], integer = false): TexFormat => ({ internal, format, type, base, bits, integer });
const RGBA8 = F(E.RGBA8, E.RGBA, E.UNSIGNED_BYTE, 'rgba', [8, 8, 8, 8, 0, 0]);
const RGB8 = F(E.RGB8, E.RGB, E.UNSIGNED_BYTE, 'rgb', [8, 8, 8, 0, 0, 0]);
const SRGB8_A8 = F(E.SRGB8_ALPHA8, E.RGBA, E.UNSIGNED_BYTE, 'rgba', [8, 8, 8, 8, 0, 0]);

/** Picks the WebGL2 format for a desktop internalformat (and, for unsized ones, the client format/type). */
export function texFormat(internal: number, format: number, type: number): TexFormat {
  const isFloat = type === E.FLOAT || type === E.HALF_FLOAT;
  switch (internal) {
    case 4: case E.RGBA: case E.RGBA8: case E.RGBA2: case E.RGBA4: case E.RGB5_A1: case E.RGB10_A2: case E.RGBA12: case E.RGBA16:
    case E.COMPRESSED_RGBA: case E.BGRA:
      if (internal === E.RGBA && isFloat) return F(E.RGBA32F, E.RGBA, E.FLOAT, 'rgba', [32, 32, 32, 32, 0, 0]);
      return RGBA8;
    case 3: case E.RGB: case E.RGB8: case E.R3_G3_B2: case E.RGB4: case E.RGB5: case E.RGB10: case E.RGB12: case E.RGB16: case E.COMPRESSED_RGB: case E.BGR:
      if (internal === E.RGB && isFloat) return F(E.RGB32F, E.RGB, E.FLOAT, 'rgb', [32, 32, 32, 0, 0, 0]);
      return RGB8;
    case E.RGB565: return F(E.RGB565, E.RGB, E.UNSIGNED_BYTE, 'rgb', [5, 6, 5, 0, 0, 0]);
    case 1: case E.LUMINANCE: case E.LUMINANCE8: case E.LUMINANCE4: case E.LUMINANCE12: case E.LUMINANCE16: case E.COMPRESSED_LUMINANCE:
      return F(E.LUMINANCE, E.LUMINANCE, E.UNSIGNED_BYTE, 'luminance', [8, 8, 8, 0, 0, 0]);
    case 2: case E.LUMINANCE_ALPHA: case E.LUMINANCE8_ALPHA8: case E.LUMINANCE4_ALPHA4: case E.LUMINANCE6_ALPHA2: case E.LUMINANCE12_ALPHA4:
    case E.LUMINANCE12_ALPHA12: case E.LUMINANCE16_ALPHA16: case E.COMPRESSED_LUMINANCE_ALPHA:
      return F(E.LUMINANCE_ALPHA, E.LUMINANCE_ALPHA, E.UNSIGNED_BYTE, 'la', [8, 8, 8, 8, 0, 0]);
    case E.ALPHA: case E.ALPHA8: case E.ALPHA4: case E.ALPHA12: case E.ALPHA16: case E.COMPRESSED_ALPHA:
      return F(E.ALPHA, E.ALPHA, E.UNSIGNED_BYTE, 'alpha', [0, 0, 0, 8, 0, 0]);
    case E.INTENSITY: case E.INTENSITY8: case E.INTENSITY4: case E.INTENSITY12: case E.INTENSITY16: case E.COMPRESSED_INTENSITY:
      // no intensity format: luminance-alpha with I in both, sampled as .rrrr
      return F(E.LUMINANCE_ALPHA, E.LUMINANCE_ALPHA, E.UNSIGNED_BYTE, 'intensity', [8, 8, 8, 8, 0, 0]);
    case E.RED: case E.R8: case E.COMPRESSED_RED: case E.R16:
      if (internal === E.RED && isFloat) return F(E.R32F, E.RED, E.FLOAT, 'rgba', [32, 0, 0, 0, 0, 0]);
      return F(E.R8, E.RED, E.UNSIGNED_BYTE, 'rgba', [8, 0, 0, 0, 0, 0]);
    case E.RG: case E.RG8: case E.COMPRESSED_RG: case E.RG16:
      if (internal === E.RG && isFloat) return F(E.RG32F, E.RG, E.FLOAT, 'rgba', [32, 32, 0, 0, 0, 0]);
      return F(E.RG8, E.RG, E.UNSIGNED_BYTE, 'rgba', [8, 8, 0, 0, 0, 0]);
    case E.R16F: return F(E.R16F, E.RED, E.FLOAT, 'rgba', [16, 0, 0, 0, 0, 0]);
    case E.RG16F: return F(E.RG16F, E.RG, E.FLOAT, 'rgba', [16, 16, 0, 0, 0, 0]);
    case E.RGB16F: return F(E.RGB16F, E.RGB, E.FLOAT, 'rgb', [16, 16, 16, 0, 0, 0]);
    case E.RGBA16F: return F(E.RGBA16F, E.RGBA, E.FLOAT, 'rgba', [16, 16, 16, 16, 0, 0]);
    case E.R32F: return F(E.R32F, E.RED, E.FLOAT, 'rgba', [32, 0, 0, 0, 0, 0]);
    case E.RG32F: return F(E.RG32F, E.RG, E.FLOAT, 'rgba', [32, 32, 0, 0, 0, 0]);
    case E.RGB32F: return F(E.RGB32F, E.RGB, E.FLOAT, 'rgb', [32, 32, 32, 0, 0, 0]);
    case E.RGBA32F: return F(E.RGBA32F, E.RGBA, E.FLOAT, 'rgba', [32, 32, 32, 32, 0, 0]);
    case E.R11F_G11F_B10F: return F(E.R11F_G11F_B10F, E.RGB, E.FLOAT, 'rgb', [11, 11, 10, 0, 0, 0]);
    case E.RGB9_E5: return F(E.RGB9_E5, E.RGB, E.FLOAT, 'rgb', [9, 9, 9, 0, 0, 0]);
    case E.SRGB: case E.SRGB8: return F(E.SRGB8, E.RGB, E.UNSIGNED_BYTE, 'rgb', [8, 8, 8, 0, 0, 0]);
    case E.SRGB_ALPHA: case E.SRGB8_ALPHA8: return SRGB8_A8;
    case E.DEPTH_COMPONENT: case E.DEPTH_COMPONENT24: case E.DEPTH_COMPONENT32:
      return F(E.DEPTH_COMPONENT24, E.DEPTH_COMPONENT, E.UNSIGNED_INT, 'depth', [0, 0, 0, 0, 24, 0]);
    case E.DEPTH_COMPONENT16: return F(E.DEPTH_COMPONENT16, E.DEPTH_COMPONENT, E.UNSIGNED_INT, 'depth', [0, 0, 0, 0, 16, 0]);
    case E.DEPTH_COMPONENT32F: return F(E.DEPTH_COMPONENT32F, E.DEPTH_COMPONENT, E.FLOAT, 'depth', [0, 0, 0, 0, 32, 0]);
    case E.DEPTH_STENCIL: case E.DEPTH24_STENCIL8:
      return F(E.DEPTH24_STENCIL8, E.DEPTH_STENCIL, E.UNSIGNED_INT_24_8, 'depth', [0, 0, 0, 0, 24, 8]);
    case E.DEPTH32F_STENCIL8: return F(E.DEPTH32F_STENCIL8, E.DEPTH_STENCIL, E.FLOAT_32_UNSIGNED_INT_24_8_REV, 'depth', [0, 0, 0, 0, 32, 8]);
    case E.R8UI: return F(E.R8UI, E.RED_INTEGER, E.UNSIGNED_BYTE, 'rgba', [8, 0, 0, 0, 0, 0], true);
    case E.R8I: return F(E.R8I, E.RED_INTEGER, E.BYTE, 'rgba', [8, 0, 0, 0, 0, 0], true);
    case E.R16UI: return F(E.R16UI, E.RED_INTEGER, E.UNSIGNED_SHORT, 'rgba', [16, 0, 0, 0, 0, 0], true);
    case E.R16I: return F(E.R16I, E.RED_INTEGER, E.SHORT, 'rgba', [16, 0, 0, 0, 0, 0], true);
    case E.R32UI: return F(E.R32UI, E.RED_INTEGER, E.UNSIGNED_INT, 'rgba', [32, 0, 0, 0, 0, 0], true);
    case E.R32I: return F(E.R32I, E.RED_INTEGER, E.INT, 'rgba', [32, 0, 0, 0, 0, 0], true);
    case E.RG8UI: return F(E.RG8UI, E.RG_INTEGER, E.UNSIGNED_BYTE, 'rgba', [8, 8, 0, 0, 0, 0], true);
    case E.RG16UI: return F(E.RG16UI, E.RG_INTEGER, E.UNSIGNED_SHORT, 'rgba', [16, 16, 0, 0, 0, 0], true);
    case E.RG32UI: return F(E.RG32UI, E.RG_INTEGER, E.UNSIGNED_INT, 'rgba', [32, 32, 0, 0, 0, 0], true);
    case E.RG32I: return F(E.RG32I, E.RG_INTEGER, E.INT, 'rgba', [32, 32, 0, 0, 0, 0], true);
    case E.RGBA8UI: return F(E.RGBA8UI, E.RGBA_INTEGER, E.UNSIGNED_BYTE, 'rgba', [8, 8, 8, 8, 0, 0], true);
    case E.RGBA8I: return F(E.RGBA8I, E.RGBA_INTEGER, E.BYTE, 'rgba', [8, 8, 8, 8, 0, 0], true);
    case E.RGBA16UI: return F(E.RGBA16UI, E.RGBA_INTEGER, E.UNSIGNED_SHORT, 'rgba', [16, 16, 16, 16, 0, 0], true);
    case E.RGBA32UI: return F(E.RGBA32UI, E.RGBA_INTEGER, E.UNSIGNED_INT, 'rgba', [32, 32, 32, 32, 0, 0], true);
    case E.RGBA32I: return F(E.RGBA32I, E.RGBA_INTEGER, E.INT, 'rgba', [32, 32, 32, 32, 0, 0], true);
    case E.RGB10_A2UI: return F(E.RGB10_A2UI, E.RGBA_INTEGER, E.UNSIGNED_INT_2_10_10_10_REV, 'rgba', [10, 10, 10, 2, 0, 0], true);
    case E.R8_SNORM: return F(E.R8_SNORM, E.RED, E.BYTE, 'rgba', [8, 0, 0, 0, 0, 0]);
    case E.RG8_SNORM: return F(E.RG8_SNORM, E.RG, E.BYTE, 'rgba', [8, 8, 0, 0, 0, 0]);
    case E.RGBA8_SNORM: return F(E.RGBA8_SNORM, E.RGBA, E.BYTE, 'rgba', [8, 8, 8, 8, 0, 0]);
  }
  // unknown: pick by client format
  const c = components(format);
  return c === 1 ? texFormat(E.RED, format, type) : c === 2 ? texFormat(E.RG, format, type) : c === 3 ? RGB8 : RGBA8;
}

const half = (h: number) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
};

/**
 * Reads tightly packed client pixels (format, type) as normalized RGBA floats
 * (or depth in r, stencil in g). The slow, general path.
 */
export function decodePixels(src: Uint8Array, n: number, format: number, type: number): Float32Array {
  const out = new Float32Array(n * 4);
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const c = components(format);
  const { size, packed } = typeSize(type);
  const comp = (i: number): number => {
    const o = i * size;
    if (o + size > src.length) return 0;
    switch (type) {
      case E.UNSIGNED_BYTE: return src[o] / 255;
      case E.BYTE: return Math.max(dv.getInt8(o) / 127, -1);
      case E.UNSIGNED_SHORT: return dv.getUint16(o, true) / 65535;
      case E.SHORT: return Math.max(dv.getInt16(o, true) / 32767, -1);
      case E.UNSIGNED_INT: return dv.getUint32(o, true) / 4294967295;
      case E.INT: return Math.max(dv.getInt32(o, true) / 2147483647, -1);
      case E.FLOAT: return dv.getFloat32(o, true);
      case E.HALF_FLOAT: return half(dv.getUint16(o, true));
    }
    return 0;
  };
  for (let p = 0; p < n; p++) {
    let v = [0, 0, 0, 1];
    if (packed) {
      const o = p * size;
      const x = size === 1 ? src[o] : size === 2 ? dv.getUint16(o, true) : o + 4 <= src.length ? dv.getUint32(o, true) : 0;
      const bits = (shift: number, width: number) => ((x >>> shift) & ((1 << width) - 1)) / ((1 << width) - 1);
      switch (type) {
        case E.UNSIGNED_BYTE_3_3_2: v = [bits(5, 3), bits(2, 3), bits(0, 2), 1]; break;
        case E.UNSIGNED_BYTE_2_3_3_REV: v = [bits(0, 3), bits(3, 3), bits(6, 2), 1]; break;
        case E.UNSIGNED_SHORT_5_6_5: v = [bits(11, 5), bits(5, 6), bits(0, 5), 1]; break;
        case E.UNSIGNED_SHORT_5_6_5_REV: v = [bits(0, 5), bits(5, 6), bits(11, 5), 1]; break;
        case E.UNSIGNED_SHORT_4_4_4_4: v = [bits(12, 4), bits(8, 4), bits(4, 4), bits(0, 4)]; break;
        case E.UNSIGNED_SHORT_4_4_4_4_REV: v = [bits(0, 4), bits(4, 4), bits(8, 4), bits(12, 4)]; break;
        case E.UNSIGNED_SHORT_5_5_5_1: v = [bits(11, 5), bits(6, 5), bits(1, 5), bits(0, 1)]; break;
        case E.UNSIGNED_SHORT_1_5_5_5_REV: v = [bits(0, 5), bits(5, 5), bits(10, 5), bits(15, 1)]; break;
        case E.UNSIGNED_INT_8_8_8_8: v = [bits(24, 8), bits(16, 8), bits(8, 8), bits(0, 8)]; break;
        case E.UNSIGNED_INT_8_8_8_8_REV: v = [bits(0, 8), bits(8, 8), bits(16, 8), bits(24, 8)]; break;
        case E.UNSIGNED_INT_10_10_10_2: v = [bits(22, 10), bits(12, 10), bits(2, 10), bits(0, 2)]; break;
        case E.UNSIGNED_INT_2_10_10_10_REV: v = [bits(0, 10), bits(10, 10), bits(20, 10), bits(30, 2)]; break;
        case E.UNSIGNED_INT_24_8: v = [(x >>> 8) / 16777215, x & 0xff, 0, 1]; break;
      }
      // packed component order follows the format (BGRA swaps)
      if (format === E.BGRA || format === E.BGR) v = [v[2], v[1], v[0], v[3]];
    } else {
      const base = p * c;
      const g = (k: number) => comp(base + k);
      switch (format) {
        case E.RED: case E.RED_INTEGER: case E.DEPTH_COMPONENT: v = [g(0), 0, 0, 1]; break;
        case E.GREEN: v = [0, g(0), 0, 1]; break;
        case E.BLUE: v = [0, 0, g(0), 1]; break;
        case E.ALPHA: v = [0, 0, 0, g(0)]; break;
        case E.LUMINANCE: v = [g(0), g(0), g(0), 1]; break;
        case E.INTENSITY: v = [g(0), g(0), g(0), g(0)]; break;
        case E.LUMINANCE_ALPHA: v = [g(0), g(0), g(0), g(1)]; break;
        case E.RG: case E.RG_INTEGER: v = [g(0), g(1), 0, 1]; break;
        case E.RGB: case E.RGB_INTEGER: v = [g(0), g(1), g(2), 1]; break;
        case E.BGR: v = [g(2), g(1), g(0), 1]; break;
        case E.BGRA: v = [g(2), g(1), g(0), g(3)]; break;
        default: v = [g(0), g(1), g(2), g(3)];
      }
    }
    out.set(v, p * 4);
  }
  return out;
}

/** Encodes normalized RGBA floats as a WebGL2 upload of `tf`. */
export function encodeFor(tf: TexFormat, rgba: Float32Array, n: number, intensity = false): ArrayBufferView {
  const c = components(tf.format);
  if (tf.type === E.FLOAT) {
    const out = new Float32Array(n * c);
    for (let p = 0; p < n; p++) for (let k = 0; k < c; k++) out[p * c + k] = pick(tf.format, rgba, p, k, intensity);
    return out;
  }
  if (tf.type === E.UNSIGNED_INT) { // depth
    const out = new Uint32Array(n);
    for (let p = 0; p < n; p++) out[p] = Math.round(Math.min(Math.max(rgba[p * 4], 0), 1) * 4294967295) >>> 0;
    return out;
  }
  if (tf.type === E.UNSIGNED_INT_24_8) {
    const out = new Uint32Array(n);
    for (let p = 0; p < n; p++) out[p] = ((Math.round(Math.min(Math.max(rgba[p * 4], 0), 1) * 16777215) << 8) | (rgba[p * 4 + 1] & 0xff)) >>> 0;
    return out;
  }
  const out = new Uint8Array(n * c);
  for (let p = 0; p < n; p++) for (let k = 0; k < c; k++) out[p * c + k] = Math.round(Math.min(Math.max(pick(tf.format, rgba, p, k, intensity), 0), 1) * 255);
  return out;
}
function pick(format: number, rgba: Float32Array, p: number, k: number, intensity: boolean): number {
  switch (format) {
    case E.LUMINANCE: return rgba[p * 4];
    case E.ALPHA: return rgba[p * 4 + 3];
    case E.LUMINANCE_ALPHA: return k === 0 ? rgba[p * 4] : intensity ? rgba[p * 4] : rgba[p * 4 + 3];
    default: return rgba[p * 4 + k];
  }
}

/** The typed array WebGL2 wants for (type), over these bytes. */
export function viewFor(type: number, bytes: Uint8Array): ArrayBufferView {
  const b = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  switch (type) {
    case E.FLOAT: return new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
    case E.UNSIGNED_INT: case E.UNSIGNED_INT_24_8: case E.UNSIGNED_INT_2_10_10_10_REV: case E.UNSIGNED_INT_10F_11F_11F_REV:
    case E.UNSIGNED_INT_5_9_9_9_REV: return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
    case E.INT: return new Int32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
    case E.UNSIGNED_SHORT: case E.HALF_FLOAT: case E.UNSIGNED_SHORT_5_6_5: case E.UNSIGNED_SHORT_4_4_4_4: case E.UNSIGNED_SHORT_5_5_5_1:
      return new Uint16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
    case E.SHORT: return new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
    case E.BYTE: return new Int8Array(b.buffer, b.byteOffset, b.byteLength);
    default: return b;
  }
}

/** Formats WebGL2 accepts as-is for a texture of `tf` (else the pixels are converted). */
function directlyUploadable(tf: TexFormat, format: number, type: number): boolean {
  if (tf.base === 'intensity') return false;
  if (format !== tf.format) return false;
  if (type === tf.type) return true;
  if (tf.type === E.FLOAT && type === E.HALF_FLOAT && (tf.internal === E.RGBA16F || tf.internal === E.RGB16F || tf.internal === E.RG16F || tf.internal === E.R16F)) return true;
  if (tf.internal === E.RGB565 && type === E.UNSIGNED_SHORT_5_6_5) return true;
  if (tf.internal === E.RGBA8 && (type === E.UNSIGNED_SHORT_4_4_4_4 || type === E.UNSIGNED_SHORT_5_5_5_1)) return false;
  if (tf.internal === E.R11F_G11F_B10F && type === E.UNSIGNED_INT_10F_11F_11F_REV) return true;
  if (tf.internal === E.RGB9_E5 && type === E.UNSIGNED_INT_5_9_9_9_REV) return true;
  return false;
}

/**
 * Client pixels (tight, format/type) → what texImage gets for `tf`: the
 * format, type and data. Fast paths for BGRA bytes; everything else goes
 * through decodePixels.
 */
export function convertForUpload(tf: TexFormat, data: Uint8Array, n: number, format: number, type: number): { format: number; type: number; data: ArrayBufferView } {
  if (directlyUploadable(tf, format, type)) return { format, type, data: viewFor(type, data) };
  // BGRA / 8_8_8_8_REV bytes → RGBA bytes
  if (tf.format === E.RGBA && tf.type === E.UNSIGNED_BYTE && format === E.BGRA && (type === E.UNSIGNED_BYTE || type === E.UNSIGNED_INT_8_8_8_8_REV)) {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) { out[i] = data[i + 2]; out[i + 1] = data[i + 1]; out[i + 2] = data[i]; out[i + 3] = data[i + 3]; }
    return { format: E.RGBA, type: E.UNSIGNED_BYTE, data: out };
  }
  if (tf.format === E.RGBA && tf.type === E.UNSIGNED_BYTE && format === E.RGBA && type === E.UNSIGNED_INT_8_8_8_8_REV) {
    return { format: E.RGBA, type: E.UNSIGNED_BYTE, data };
  }
  if (tf.format === E.RGB && tf.type === E.UNSIGNED_BYTE && format === E.BGR && type === E.UNSIGNED_BYTE) {
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i += 3) { out[i] = data[i + 2]; out[i + 1] = data[i + 1]; out[i + 2] = data[i]; }
    return { format: E.RGB, type: E.UNSIGNED_BYTE, data: out };
  }
  const rgba = decodePixels(data, n, format, type);
  return { format: tf.format, type: tf.type, data: encodeFor(tf, rgba, n, tf.base === 'intensity') };
}

/**
 * RGBA bytes (or floats) read from WebGL, bottom row first, → client pixels
 * in (format, type) under the pack rules. Returns the bytes from the start of
 * the destination.
 */
export function packPixels(src: Uint8Array | Float32Array, w: number, h: number, format: number, type: number, ps: PixelStore): Uint8Array {
  const L = imageLayout(ps, w, h, format, type);
  const out = new Uint8Array(L.start + (h - 1) * L.rowBytes + w * L.group);
  const fast = src instanceof Uint8Array && type === E.UNSIGNED_BYTE && (format === E.RGBA || format === E.BGRA || format === E.RGB || format === E.BGR || format === E.RED || format === E.ALPHA || format === E.LUMINANCE);
  const dv = new DataView(out.buffer);
  for (let y = 0; y < h; y++) {
    let o = L.start + y * L.rowBytes;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const r = src[s], g = src[s + 1], b = src[s + 2], a = src[s + 3];
      if (fast) {
        switch (format) {
          case E.RGBA: out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a; o += 4; break;
          case E.BGRA: out[o] = b; out[o + 1] = g; out[o + 2] = r; out[o + 3] = a; o += 4; break;
          case E.RGB: out[o] = r; out[o + 1] = g; out[o + 2] = b; o += 3; break;
          case E.BGR: out[o] = b; out[o + 1] = g; out[o + 2] = r; o += 3; break;
          case E.ALPHA: out[o++] = a; break;
          default: out[o++] = r; break;
        }
        continue;
      }
      const sc = src instanceof Uint8Array ? 1 / 255 : 1;
      const v = [r * sc, g * sc, b * sc, a * sc];
      let comps: number[];
      switch (format) {
        case E.RED: case E.LUMINANCE: case E.DEPTH_COMPONENT: comps = [v[0]]; break;
        case E.GREEN: comps = [v[1]]; break;
        case E.BLUE: comps = [v[2]]; break;
        case E.ALPHA: comps = [v[3]]; break;
        case E.LUMINANCE_ALPHA: comps = [v[0], v[3]]; break;
        case E.RG: comps = [v[0], v[1]]; break;
        case E.RGB: comps = [v[0], v[1], v[2]]; break;
        case E.BGR: comps = [v[2], v[1], v[0]]; break;
        case E.BGRA: comps = [v[2], v[1], v[0], v[3]]; break;
        default: comps = v;
      }
      if (type === E.UNSIGNED_INT_8_8_8_8_REV || type === E.UNSIGNED_INT_8_8_8_8) {
        const bytes = comps.map((q) => Math.round(Math.min(Math.max(q, 0), 1) * 255));
        const word = type === E.UNSIGNED_INT_8_8_8_8_REV ? (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) : ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]);
        dv.setUint32(o, word >>> 0, true); o += 4;
        continue;
      }
      for (const q of comps) {
        switch (type) {
          case E.UNSIGNED_BYTE: out[o] = Math.round(Math.min(Math.max(q, 0), 1) * 255); o += 1; break;
          case E.BYTE: dv.setInt8(o, Math.round(Math.min(Math.max(q, -1), 1) * 127)); o += 1; break;
          case E.UNSIGNED_SHORT: dv.setUint16(o, Math.round(Math.min(Math.max(q, 0), 1) * 65535), true); o += 2; break;
          case E.SHORT: dv.setInt16(o, Math.round(Math.min(Math.max(q, -1), 1) * 32767), true); o += 2; break;
          case E.UNSIGNED_INT: dv.setUint32(o, Math.round(Math.min(Math.max(q, 0), 1) * 4294967295) >>> 0, true); o += 4; break;
          case E.INT: dv.setInt32(o, Math.round(Math.min(Math.max(q, -1), 1) * 2147483647), true); o += 4; break;
          default: dv.setFloat32(o, q, true); o += 4;
        }
      }
    }
  }
  return out;
}
