/**
 * abi.ts — WASI-side translations of the kernel ABI (src/kernel/abi.ts):
 * Linux errno → WASI errno, struct stat mode / dirent type → WASI filetype,
 * and the WASI filestat layout.
 */

import * as A from '../kernel/abi';

/** Linux errno → WASI errno (wasi_snapshot_preview1 numbering). */
const LINUX_TO_WASI: Record<number, number> = {
  [A.EPERM]: 63, [A.ENOENT]: 44, [A.ESRCH]: 71, [A.EINTR]: 27, [A.EIO]: 29, [A.ENXIO]: 60,
  [A.E2BIG]: 1, [A.ENOEXEC]: 45, [A.EBADF]: 8, [A.ECHILD]: 12, [A.EAGAIN]: 6, [A.ENOMEM]: 48,
  [A.EACCES]: 2, [A.EFAULT]: 21, [A.EBUSY]: 10, [A.EEXIST]: 20, [A.EXDEV]: 75, [A.ENODEV]: 43,
  [A.ENOTDIR]: 54, [A.EISDIR]: 31, [A.EINVAL]: 28, [A.ENFILE]: 41, [A.EMFILE]: 33, [A.ENOTTY]: 59,
  [A.EFBIG]: 22, [A.ENOSPC]: 51, [A.ESPIPE]: 70, [A.EROFS]: 69, [A.EPIPE]: 64, [A.ERANGE]: 68,
  [A.ENAMETOOLONG]: 37, [A.ENOSYS]: 52, [A.ENOTEMPTY]: 55, [A.ELOOP]: 32, [A.ENOTSUP]: 58,
  [A.ETIMEDOUT]: 73,
};

/** Translate a syscall result to a WASI errno (0 for success). */
export function wasiErrno(ret: number): number {
  if (ret >= 0) return 0;
  return LINUX_TO_WASI[-ret] ?? 29; // EIO
}

// WASI errno values used directly
export const WASI_ESUCCESS = 0, WASI_EBADF = 8, WASI_ECHILD = 12, WASI_EINVAL = 28,
  WASI_ENOSYS = 52, WASI_ENOTSUP = 58, WASI_EOVERFLOW = 61, WASI_ENOTTY = 59;

/** WASI filetypes. */
export const FT_UNKNOWN = 0, FT_BLOCK = 1, FT_CHAR = 2, FT_DIR = 3, FT_REG = 4,
  FT_SOCK_DGRAM = 5, FT_SOCK_STREAM = 6, FT_SYMLINK = 7;

export function filetypeFromMode(mode: number): number {
  switch (mode & A.S_IFMT) {
    case A.S_IFDIR: return FT_DIR;
    case A.S_IFREG: return FT_REG;
    case A.S_IFLNK: return FT_SYMLINK;
    case A.S_IFCHR: return FT_CHAR;
    case A.S_IFSOCK: return FT_SOCK_STREAM;
    default: return FT_UNKNOWN; // FIFOs have no WASI type
  }
}

export function filetypeFromDtype(t: number): number {
  switch (t) {
    case A.DT_DIR: return FT_DIR;
    case A.DT_REG: return FT_REG;
    case A.DT_LNK: return FT_SYMLINK;
    case A.DT_CHR: return FT_CHAR;
    default: return FT_UNKNOWN;
  }
}

/** WASI `filestat` (64 bytes) from a kernel struct stat. */
export function writeFilestat(st: A.KStat, view: DataView, ptr: number): void {
  const ns = (ms: number) => BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n;
  view.setBigUint64(ptr, BigInt(st.dev), true);
  view.setBigUint64(ptr + 8, BigInt(st.ino), true);
  view.setUint8(ptr + 16, filetypeFromMode(st.mode));
  for (let i = 17; i < 24; i++) view.setUint8(ptr + i, 0);
  view.setBigUint64(ptr + 24, BigInt(st.nlink), true);
  view.setBigUint64(ptr + 32, BigInt(Math.max(0, st.size)), true);
  view.setBigUint64(ptr + 40, ns(st.atimeMs), true);
  view.setBigUint64(ptr + 48, ns(st.mtimeMs), true);
  view.setBigUint64(ptr + 56, ns(st.ctimeMs), true);
}

/**
 * Shiro syscall registered by host.ts (kernel.registerSyscalls): start a
 * wasi-threads thread. args[0] = start_arg; returns the new tid or -errno.
 */
export const SYS_wasi_thread_spawn = 1100;

/**
 * WASIX fork (host.ts): copy the calling process (memory, fds, signal
 * state) into a new kernel process that resumes from the guest's captured
 * stack. The guest posts a `wasix-fork` message with the state first.
 * Returns the child pid or -errno.
 */
export const SYS_wasix_fork = 1101;

/**
 * WASIX exec (host.ts): replace the program of the calling process, keeping
 * its pid, fds (minus close-on-exec) and ignored signals. data = JSON
 * `{path, argv, env?}` (path resolved like SYS_spawn). Never returns on
 * success; -ENOENT when nothing can run `path`, -ENOSYS when the process
 * can't exec (then the guest emulates exec as spawn + wait + exit).
 */
export const SYS_wasix_exec = 1102;

/**
 * WASIX signal bookkeeping (host.ts). args[0] = op:
 *   WASIX_SIG_CATCH: the guest registered a signal callback, so every
 *     catchable signal not ignored goes to the guest (disposition
 *     WASIX_HANDLER); WASIX libc runs default actions itself.
 *   WASIX_SIG_DEFAULT (args[1] = sig): take the kernel's default action for
 *     sig now (terminate, or stop until continued), then restore the
 *     disposition. Used when the guest's libc would print "Program recieved
 *     ... signal" and abort.
 *   WASIX_SIG_IGNORED: bitmask of ignored signals 1..31 (proc_signals_get).
 */
export const SYS_wasix_signal = 1103;
export const WASIX_SIG_CATCH = 0, WASIX_SIG_DEFAULT = 1, WASIX_SIG_IGNORED = 2;
/** Disposition value standing for "the WASIX guest's libc decides". */
export const WASIX_HANDLER = 0x5751;

/** A syscall as the WASI layer issues it (transport-neutral). */
export interface SysRequest {
  nr: number;
  args: number[];
  /** Input bytes, placed at data offset 0. */
  data?: Uint8Array;
  /** Bytes of output the call may write at data offset 0 (sizes the JSPI buffer). */
  out?: number;
}

/** `data` is the data area after the call; copy what you need before the next call. */
export interface SysReply {
  ret: number;
  data: Uint8Array;
}
