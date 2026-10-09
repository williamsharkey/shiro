/** CRC-32 (IEEE 802.3, reflected), as used by gzip, zip and xz */

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(b: Uint8Array, start = 0, end = b.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ TABLE[(c ^ b[i]) & 0xff];
  return ~c >>> 0;
}
