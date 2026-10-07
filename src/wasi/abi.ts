/**
 * abi.ts — syscall numbers, errno and channel layout used by WASM guests.
 *
 * TEMPORARY SHIM for src/kernel/abi.ts (owned by the unix/kernel branch,
 * see docs/KERNEL_ABI.md). Numbers follow Linux x86-64 so they line up with
 * src/x86/syscalls.ts; Shiro-specific calls start at 1000. When unix/kernel
 * lands, re-export its names from here and delete the duplicates.
 */

// ── Syscall numbers (Linux x86-64 where one exists) ──────────────────

export const SYS_read = 0;
export const SYS_write = 1;
export const SYS_close = 3;
export const SYS_fstat = 5;
export const SYS_lseek = 8;
export const SYS_pread64 = 17;
export const SYS_pwrite64 = 18;
export const SYS_dup = 32;
export const SYS_dup2 = 33;
export const SYS_getpid = 39;
export const SYS_wait4 = 61;
export const SYS_kill = 62;
export const SYS_fcntl = 72;
export const SYS_fsync = 74;
export const SYS_ftruncate = 77;
export const SYS_getcwd = 79;
export const SYS_chdir = 80;
export const SYS_getppid = 110;
export const SYS_getdents64 = 217;
export const SYS_exit_group = 231;
export const SYS_openat = 257;
export const SYS_mkdirat = 258;
export const SYS_newfstatat = 262;
export const SYS_unlinkat = 263;
export const SYS_renameat = 264;
export const SYS_linkat = 265;
export const SYS_symlinkat = 266;
export const SYS_readlinkat = 267;
export const SYS_ppoll = 271;
export const SYS_utimensat = 280;
export const SYS_pipe2 = 293;
/** Shiro: spawn a child. data = JSON SpawnRequest; ret = pid. */
export const SYS_spawn = 1000;
/** Shiro: start a wasi-threads thread. args[0] = start_arg; ret = tid. */
export const SYS_thread_spawn = 1001;

// ── Linux errno ──────────────────────────────────────────────────────

export const EPERM = 1, ENOENT = 2, ESRCH = 3, EINTR = 4, EIO = 5, ENOEXEC = 8,
  EBADF = 9, ECHILD = 10, EAGAIN = 11, ENOMEM = 12, EACCES = 13, EFAULT = 14,
  EBUSY = 16, EEXIST = 17, EXDEV = 18, ENOTDIR = 20, EISDIR = 21, EINVAL = 22,
  EMFILE = 24, ENOTTY = 25, EFBIG = 27, ENOSPC = 28, ESPIPE = 29, EROFS = 30,
  EMLINK = 31, EPIPE = 32, ERANGE = 34, ENAMETOOLONG = 36, ENOSYS = 38,
  ENOTEMPTY = 39, ELOOP = 40, ENOTSUP = 95, ETIMEDOUT = 110;

/** Linux errno → WASI errno (wasi_snapshot_preview1 numbering). */
const LINUX_TO_WASI: Record<number, number> = {
  [EPERM]: 63, [ENOENT]: 44, [ESRCH]: 71, [EINTR]: 27, [EIO]: 29, [ENOEXEC]: 45,
  [EBADF]: 8, [ECHILD]: 12, [EAGAIN]: 6, [ENOMEM]: 48, [EACCES]: 2, [EFAULT]: 21,
  [EBUSY]: 10, [EEXIST]: 20, [EXDEV]: 75, [ENOTDIR]: 54, [EISDIR]: 31,
  [EINVAL]: 28, [EMFILE]: 33, [ENOTTY]: 59, [EFBIG]: 22, [ENOSPC]: 51,
  [ESPIPE]: 70, [EROFS]: 69, [EMLINK]: 34, [EPIPE]: 64, [ERANGE]: 68,
  [ENAMETOOLONG]: 37, [ENOSYS]: 52, [ENOTEMPTY]: 55, [ELOOP]: 32,
  [ENOTSUP]: 58, [ETIMEDOUT]: 73,
};

/** Translate a negative syscall result to a WASI errno (0 for success). */
export function wasiErrno(ret: number): number {
  if (ret >= 0) return 0;
  return LINUX_TO_WASI[-ret] ?? 29; // EIO
}

// ── open flags (Linux) ───────────────────────────────────────────────

export const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_ACCMODE = 3;
export const O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000,
  O_NONBLOCK = 0o4000, O_DIRECTORY = 0o200000, O_NOFOLLOW = 0o400000, O_CLOEXEC = 0o2000000;
export const AT_FDCWD = -100;
export const AT_SYMLINK_NOFOLLOW = 0x100;
export const AT_REMOVEDIR = 0x200;
export const F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4;
export const SEEK_SET = 0, SEEK_CUR = 1, SEEK_END = 2;
export const WNOHANG = 1;

// ── poll ─────────────────────────────────────────────────────────────

export const POLLIN = 0x1, POLLOUT = 0x4, POLLERR = 0x8, POLLHUP = 0x10, POLLNVAL = 0x20;

// ── signals ──────────────────────────────────────────────────────────

export const SIGHUP = 1, SIGINT = 2, SIGQUIT = 3, SIGILL = 4, SIGABRT = 6,
  SIGKILL = 9, SIGSEGV = 11, SIGPIPE = 13, SIGTERM = 15;

// ── stat (returned by fstat/newfstatat in WASI filestat layout) ──────

/** File types, WASI numbering (stat records use these). */
export const FT_UNKNOWN = 0, FT_CHAR = 2, FT_DIR = 3, FT_REG = 4, FT_SOCK_STREAM = 6, FT_SYMLINK = 7;

export interface KStat {
  dev: number;
  ino: number;
  filetype: number;
  nlink: number;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  mode?: number;
}

/** WASI `filestat`: dev u64, ino u64, filetype u8 (@16), nlink u64 (@24), size, atim, mtim, ctim. */
export const STAT_SIZE = 64;

export function encodeStat(st: KStat, out = new Uint8Array(STAT_SIZE), off = 0): Uint8Array {
  const v = new DataView(out.buffer, out.byteOffset + off, STAT_SIZE);
  const ns = (ms: number) => BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n;
  v.setBigUint64(0, BigInt(st.dev), true);
  v.setBigUint64(8, BigInt(st.ino), true);
  v.setUint8(16, st.filetype);
  v.setBigUint64(24, BigInt(st.nlink), true);
  v.setBigUint64(32, BigInt(Math.max(0, st.size)), true);
  v.setBigUint64(40, ns(st.atimeMs), true);
  v.setBigUint64(48, ns(st.mtimeMs), true);
  v.setBigUint64(56, ns(st.ctimeMs), true);
  return out;
}

// ── wait status encoding (Linux) ─────────────────────────────────────

export const exitStatus = (code: number) => (code & 0xff) << 8;
export const signalStatus = (sig: number) => sig & 0x7f;
export const WIFEXITED = (s: number) => (s & 0x7f) === 0;
export const WEXITSTATUS = (s: number) => (s >> 8) & 0xff;
export const WTERMSIG = (s: number) => s & 0x7f;
/** Shell-style exit code: N for exit(N), 128+sig for a signal. */
export const shellExitCode = (s: number) => (WIFEXITED(s) ? WEXITSTATUS(s) : 128 + WTERMSIG(s));

// ── Channel layout (see KERNEL_ABI.md "Syscall channel") ─────────────

export const CH_STATE = 0;       // Int32 index: 0 idle, 1 request posted, 2 reply ready
export const CH_NR = 1;          // syscall number
export const CH_RESULT = 2;      // result or -errno
export const CH_SIGNAL = 3;      // pending-signal flag
export const CH_ARGS = 4;        // Int32 [4..15] args
export const CH_NARGS = 12;
/**
 * Extension (requested from unix/kernel): on reply the kernel stores the
 * number of reply bytes it wrote to the data area in Int32[CH_ARGS] (the
 * request's args are consumed by then).
 */
export const CH_REPLY_LEN = CH_ARGS;
/**
 * Extension (requested from unix/kernel): on request the guest stores the
 * number of request bytes in the data area in Int32[CH_RESULT], so the
 * kernel copies only those.
 */
export const CH_REQ_LEN = CH_RESULT;
export const CH_DATA = 64;       // byte offset of the data area
export const CH_DEFAULT_DATA = 1 << 20;

export const STATE_IDLE = 0, STATE_REQUEST = 1, STATE_REPLY = 2;

// ── Request/reply shape shared by both transports ────────────────────

export interface SysRequest {
  nr: number;
  args: number[];
  /** Input bytes (paths, write buffers, JSON). */
  data?: Uint8Array;
}

export interface SysReply {
  ret: number;
  /** Output bytes (read buffers, stat records, ...). */
  out?: Uint8Array;
}

/** Spawn request carried as JSON by SYS_spawn. */
export interface SpawnRequest {
  /** Program name or path as the caller gave it. */
  name: string;
  argv: string[];
  /** null = inherit the parent's environment. */
  env: Record<string, string> | null;
  /** Search PATH when name has no slash. */
  searchPath: boolean;
  /** PATH override for the search (WASIX passes it explicitly). */
  path?: string;
  /** Directory for the child (default: parent's cwd). */
  cwd?: string;
  /** File actions applied in order to a copy of the parent's fd table. */
  fileActions?: SpawnFileAction[];
  /** exec(): the caller exits with the child's status once it finishes. */
  exec?: boolean;
}

export type SpawnFileAction =
  | { op: 'close'; fd: number }
  | { op: 'dup2'; fd: number; src: number }
  | { op: 'open'; fd: number; path: string; flags: number; mode: number }
  | { op: 'chdir'; path: string }
  | { op: 'fchdir'; src: number };
