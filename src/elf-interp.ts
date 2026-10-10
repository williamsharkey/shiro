/** ELF loader (PT_INTERP) lookups for exec: the kernel and the shell. */

/**
 * The PT_INTERP path of an x86-64 ELF (a dynamic executable's loader, as
 * /lib64/ld-linux-x86-64.so.2), or null: static, not an ELF, or truncated.
 */
export function elfInterpreter(data: Uint8Array): string | null {
  if (data.length < 64 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46 || data[4] !== 2 /* ELFCLASS64 */) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const phOff = Number(view.getBigUint64(32, true));
  const phEntSize = view.getUint16(54, true);
  const phNum = view.getUint16(56, true);
  for (let i = 0; i < phNum; i++) {
    const off = phOff + i * phEntSize;
    if (off + 40 > data.length) break;
    if (view.getUint32(off, true) !== 3 /* PT_INTERP */) continue;
    const at = Number(view.getBigUint64(off + 8, true));
    const size = Number(view.getBigUint64(off + 32, true));
    if (!size || at + size > data.length) return null;
    const bytes = data.subarray(at, at + size);
    const nul = bytes.indexOf(0);
    return new TextDecoder().decode(nul >= 0 ? bytes.subarray(0, nul) : bytes);
  }
  return null;
}

/** What bash says when exec fails with ENOENT for a missing loader, plus how to get one here. */
export function missingInterpreterMessage(name: string, interp: string): string {
  const glibc = /\/ld-linux[^/]*\.so/.test(interp);
  return `tabcomputer: ${name}: cannot execute: required file not found\n` +
    (glibc ? '(this program needs glibc: run `debian install`)\n' : `(its loader ${interp} is missing)\n`);
}
