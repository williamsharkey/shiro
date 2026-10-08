/**
 * wasi-preview0.ts — `wasi_unstable` (WASI snapshot 0) on top of preview1
 *
 * Older WAPM packages (sqlite 0.2, fortune, lolcat, brotli, openssl, …) import
 * `wasi_unstable`. It has the same functions as `wasi_snapshot_preview1`
 * except for three ABI differences, adapted here:
 *   - fd_seek whence: CUR=0, END=1, SET=2 (preview1: SET=0, CUR=1, END=2)
 *   - filestat: nlink is u32, so the struct is 56 bytes (preview1: 64)
 *   - poll_oneoff clock subscriptions carry an extra u64 identifier,
 *     so each subscription is 56 bytes (preview1: 48); events are unchanged
 */

type Fn = (...args: any[]) => any;

const P0_WHENCE_TO_P1 = [1, 2, 0];
const P1_FILESTAT = 64;
const P0_FILESTAT = 56;
const P0_SUB = 56;
const P1_SUB = 48;
const EVENTTYPE_CLOCK = 0;

export function makePreview0Imports(p1: Record<string, Fn>, getMemory: () => WebAssembly.Memory): Record<string, Fn> {
  const p0: Record<string, Fn> = { ...p1 };
  delete p0.sock_accept; // not in snapshot 0

  p0.fd_seek = (fd: number, offset: bigint, whence: number, newOffsetPtr: number) =>
    p1.fd_seek(fd, offset, P0_WHENCE_TO_P1[whence] ?? 99, newOffsetPtr);

  // preview1 writes 64 bytes; keep the 8 bytes past the 56-byte preview0
  // struct intact and repack nlink as u32.
  const filestat = (call: () => number, bufPtr: number): number => {
    const mem = new Uint8Array(getMemory().buffer);
    const tail = mem.slice(bufPtr + P0_FILESTAT, bufPtr + P1_FILESTAT);
    const rc = call();
    const view = new DataView(getMemory().buffer);
    if (rc === 0) {
      const nlink = view.getBigUint64(bufPtr + 24, true);
      const size = view.getBigUint64(bufPtr + 32, true);
      const atim = view.getBigUint64(bufPtr + 40, true);
      const mtim = view.getBigUint64(bufPtr + 48, true);
      const ctim = view.getBigUint64(bufPtr + 56, true);
      view.setUint32(bufPtr + 20, Number(nlink & 0xffffffffn), true);
      view.setBigUint64(bufPtr + 24, size, true);
      view.setBigUint64(bufPtr + 32, atim, true);
      view.setBigUint64(bufPtr + 40, mtim, true);
      view.setBigUint64(bufPtr + 48, ctim, true);
    }
    new Uint8Array(getMemory().buffer).set(tail, bufPtr + P0_FILESTAT);
    return rc;
  };
  p0.fd_filestat_get = (fd: number, bufPtr: number) =>
    filestat(() => p1.fd_filestat_get(fd, bufPtr), bufPtr);
  p0.path_filestat_get = (dirFd: number, flags: number, pathPtr: number, pathLen: number, bufPtr: number) =>
    filestat(() => p1.path_filestat_get(dirFd, flags, pathPtr, pathLen, bufPtr), bufPtr);

  // Repack subscriptions in place (preview1 entries are smaller, so entry i
  // never overwrites unread entry i+1), call preview1, restore the input.
  p0.poll_oneoff = (inPtr: number, outPtr: number, nsubs: number, neventsPtr: number) => {
    const total = nsubs * P0_SUB;
    const saved = new Uint8Array(getMemory().buffer).slice(inPtr, inPtr + total);
    const src = new DataView(saved.buffer);
    const view = new DataView(getMemory().buffer);
    for (let i = 0; i < nsubs; i++) {
      const s = i * P0_SUB;
      const d = inPtr + i * P1_SUB;
      const userdata = src.getBigUint64(s, true);
      const tag = src.getUint8(s + 8);
      view.setBigUint64(d, userdata, true);
      view.setUint8(d + 8, tag);
      if (tag === EVENTTYPE_CLOCK) {
        view.setUint32(d + 16, src.getUint32(s + 24, true), true);       // clock id
        view.setBigUint64(d + 24, src.getBigUint64(s + 32, true), true); // timeout
        view.setBigUint64(d + 32, src.getBigUint64(s + 40, true), true); // precision
        view.setUint16(d + 40, src.getUint16(s + 48, true), true);       // flags
      } else {
        view.setUint32(d + 16, src.getUint32(s + 16, true), true);       // fd
      }
    }
    try {
      return p1.poll_oneoff(inPtr, outPtr, nsubs, neventsPtr);
    } finally {
      new Uint8Array(getMemory().buffer).set(saved, inPtr);
    }
  };

  return p0;
}
