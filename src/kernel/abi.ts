/**
 * Kernel ABI: syscall numbers, errno, flags and struct layouts shared by the
 * kernel (page side) and guests (worker side). See docs/KERNEL_ABI.md.
 *
 * Syscall numbers and errno values are Linux x86-64's, so the x86 engine can
 * forward guest syscalls unchanged. Shiro-specific calls start at 1000.
 * This file must stay dependency-free: guest bundles import it.
 */

// ── Syscall numbers (Linux x86-64) ─────────────────────────────────────────
export const SYS_read = 0;
export const SYS_write = 1;
export const SYS_open = 2;
export const SYS_close = 3;
export const SYS_stat = 4;
export const SYS_fstat = 5;
export const SYS_lstat = 6;
export const SYS_poll = 7;
export const SYS_lseek = 8;
export const SYS_ioctl = 16;
export const SYS_pipe = 22;
export const SYS_dup = 32;
export const SYS_dup2 = 33;
export const SYS_nanosleep = 35;
export const SYS_getpid = 39;
export const SYS_exit = 60;
export const SYS_wait4 = 61;
export const SYS_kill = 62;
export const SYS_fcntl = 72;
export const SYS_fsync = 74;
export const SYS_ftruncate = 77;
export const SYS_getcwd = 79;
export const SYS_chdir = 80;
export const SYS_rename = 82;
export const SYS_mkdir = 83;
export const SYS_rmdir = 84;
export const SYS_unlink = 87;
export const SYS_readlink = 89;
export const SYS_umask = 95;
export const SYS_getuid = 102;
export const SYS_getgid = 104;
export const SYS_setpgid = 109;
export const SYS_getppid = 110;
export const SYS_getpgrp = 111;
export const SYS_setsid = 112;
export const SYS_getpgid = 121;
export const SYS_getsid = 124;
export const SYS_getdents64 = 217;
export const SYS_exit_group = 231;
export const SYS_openat = 257;
export const SYS_dup3 = 292;
export const SYS_pipe2 = 293;

export const SYS_rt_sigaction = 13;
export const SYS_rt_sigprocmask = 14;
export const SYS_rt_sigreturn = 15;
export const SYS_pread64 = 17;
export const SYS_pwrite64 = 18;
export const SYS_access = 21;
export const SYS_select = 23;
export const SYS_sched_yield = 24;
export const SYS_getrandom = 318;
export const SYS_truncate = 76;
export const SYS_fchdir = 81;
export const SYS_link = 86;
export const SYS_symlink = 88;
export const SYS_chmod = 90;
export const SYS_fchmod = 91;
export const SYS_rt_sigpending = 127;
export const SYS_rt_sigsuspend = 130;
export const SYS_sigaltstack = 131;
export const SYS_gettid = 186;
export const SYS_tkill = 200;
export const SYS_epoll_create = 213;
export const SYS_epoll_wait = 232;
export const SYS_epoll_ctl = 233;
export const SYS_tgkill = 234;
export const SYS_mkdirat = 258;
export const SYS_newfstatat = 262;
export const SYS_unlinkat = 263;
export const SYS_renameat = 264;
export const SYS_linkat = 265;
export const SYS_symlinkat = 266;
export const SYS_readlinkat = 267;
export const SYS_fchmodat = 268;
export const SYS_faccessat = 269;
export const SYS_pselect6 = 270;
export const SYS_utimensat = 280;
export const SYS_epoll_pwait = 281;
export const SYS_epoll_create1 = 291;
export const SYS_renameat2 = 316;

// Sockets (handlers live in net.ts, registered through kernel.registerSyscalls)
export const SYS_socket = 41;
export const SYS_connect = 42;
export const SYS_accept = 43;
export const SYS_sendto = 44;
export const SYS_recvfrom = 45;
export const SYS_sendmsg = 46;
export const SYS_recvmsg = 47;
export const SYS_shutdown = 48;
export const SYS_bind = 49;
export const SYS_listen = 50;
export const SYS_getsockname = 51;
export const SYS_getpeername = 52;
export const SYS_socketpair = 53;
export const SYS_setsockopt = 54;
export const SYS_getsockopt = 55;
export const SYS_accept4 = 288;
/** Every socket syscall number, for registerSyscalls. */
export const SOCKET_SYSCALLS = [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 288];

/**
 * Shiro: posix_spawn. Data area holds UTF-8 JSON
 * `{ path, argv, env?, cwd?, fds?: [[childFd, parentFd], ...], inherit?, pgid?, setsid? }`.
 * Without `fds` the child inherits every non-cloexec fd; with `fds` only
 * those, unless `inherit: true`. Returns the child pid.
 */
export const SYS_spawn = 1000;
/** Shiro: environment of the calling process as JSON `{argv, env, cwd, pid}` written to the data area; returns byte length. */
export const SYS_getenv = 1001;

// ── errno (Linux) ──────────────────────────────────────────────────────────
export const EPERM = 1;
export const ENOENT = 2;
export const ESRCH = 3;
export const EINTR = 4;
export const EIO = 5;
export const ENXIO = 6;
export const E2BIG = 7;
export const ENOEXEC = 8;
export const EBADF = 9;
export const ECHILD = 10;
export const EAGAIN = 11;
export const ENOMEM = 12;
export const EACCES = 13;
export const EFAULT = 14;
export const EBUSY = 16;
export const EEXIST = 17;
export const EXDEV = 18;
export const ENODEV = 19;
export const ENOTDIR = 20;
export const EISDIR = 21;
export const EINVAL = 22;
export const ENFILE = 23;
export const EMFILE = 24;
export const ENOTTY = 25;
export const EFBIG = 27;
export const ENOSPC = 28;
export const ESPIPE = 29;
export const EROFS = 30;
export const EPIPE = 32;
export const ERANGE = 34;
export const ENAMETOOLONG = 36;
export const ENOSYS = 38;
export const ENOTEMPTY = 39;
export const ELOOP = 40;
export const ENOTSUP = 95;
export const ETIMEDOUT = 110;
export const EPROTO = 71;
export const EOVERFLOW = 75;
// Network errno (88–115)
export const ENOTSOCK = 88;
export const EDESTADDRREQ = 89;
export const EMSGSIZE = 90;
export const EPROTOTYPE = 91;
export const ENOPROTOOPT = 92;
export const EPROTONOSUPPORT = 93;
export const ESOCKTNOSUPPORT = 94;
export const EOPNOTSUPP = 95;
export const EPFNOSUPPORT = 96;
export const EAFNOSUPPORT = 97;
export const EADDRINUSE = 98;
export const EADDRNOTAVAIL = 99;
export const ENETDOWN = 100;
export const ENETUNREACH = 101;
export const ENETRESET = 102;
export const ECONNABORTED = 103;
export const ECONNRESET = 104;
export const ENOBUFS = 105;
export const EISCONN = 106;
export const ENOTCONN = 107;
export const ESHUTDOWN = 108;
export const ETOOMANYREFS = 109;
export const ECONNREFUSED = 111;
export const EHOSTDOWN = 112;
export const EHOSTUNREACH = 113;
export const EALREADY = 114;
export const EINPROGRESS = 115;

/**
 * UTF-8 decode that is safe on views of a SharedArrayBuffer: browsers throw
 * on TextDecoder.decode(shared view), so shared input is copied first.
 */
export function decodeText(bytes: Uint8Array): string {
  const shared = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer;
  return utf8Decoder.decode(shared ? bytes.slice() : bytes);
}
const utf8Decoder = new TextDecoder();

/** Map a Node-style error code (`err.code`, as thrown by src/filesystem.ts) to a negative errno. */
export function errnoFromError(err: unknown, fallback = EIO): number {
  const code = (err as { code?: string } | null)?.code;
  const map: Record<string, number> = {
    EPERM, ENOENT, ESRCH, EINTR, EIO, EBADF, EAGAIN, EACCES, EEXIST, ENOTDIR,
    EISDIR, EINVAL, EMFILE, ENOTTY, ENOSPC, ESPIPE, EROFS, EPIPE, ENAMETOOLONG,
    ENOSYS, ENOTEMPTY, ELOOP, ENOTSUP, EXDEV, EBUSY, EFBIG, E2BIG, ENXIO, ENODEV,
    ECONNREFUSED, ECONNRESET, ETIMEDOUT, EADDRINUSE, ENOTCONN, EHOSTUNREACH, ENETUNREACH,
  };
  return -(code && map[code] ? map[code] : fallback);
}

// ── open(2) flags ──────────────────────────────────────────────────────────
export const O_RDONLY = 0o0;
export const O_WRONLY = 0o1;
export const O_RDWR = 0o2;
export const O_ACCMODE = 0o3;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_NOCTTY = 0o400;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;
export const O_NONBLOCK = 0o4000;
export const O_DIRECTORY = 0o200000;
export const O_NOFOLLOW = 0o400000;
export const O_CLOEXEC = 0o2000000;

export const AT_FDCWD = -100;
export const AT_SYMLINK_NOFOLLOW = 0x100;
export const AT_REMOVEDIR = 0x200;
export const AT_SYMLINK_FOLLOW = 0x400;
export const AT_EMPTY_PATH = 0x1000;
export const RENAME_NOREPLACE = 1;

/** access(2) modes */
export const F_OK = 0;
export const X_OK = 1;
export const W_OK = 2;
export const R_OK = 4;

/** utimensat special nsec values */
export const UTIME_NOW = (1 << 30) - 1;
export const UTIME_OMIT = (1 << 30) - 2;

// ── lseek whence ───────────────────────────────────────────────────────────
export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;

// ── fcntl ──────────────────────────────────────────────────────────────────
export const F_DUPFD = 0;
export const F_GETFD = 1;
export const F_SETFD = 2;
export const F_GETFL = 3;
export const F_SETFL = 4;
export const F_DUPFD_CLOEXEC = 1030;
export const FD_CLOEXEC = 1;

// ── poll ───────────────────────────────────────────────────────────────────
export const POLLIN = 0x001;
export const POLLPRI = 0x002;
export const POLLOUT = 0x004;
export const POLLERR = 0x008;
export const POLLHUP = 0x010;
export const POLLNVAL = 0x020;
export const POLLRDNORM = 0x040;
export const POLLRDBAND = 0x080;
export const POLLWRNORM = 0x100;
export const POLLWRBAND = 0x200;
export const POLLRDHUP = 0x2000;
/** struct pollfd { int fd; short events; short revents; } */
export const POLLFD_SIZE = 8;

// ── wait ───────────────────────────────────────────────────────────────────
export const WNOHANG = 1;
export const WUNTRACED = 2;
export const WCONTINUED = 8;

/** Linux wait-status encoding. */
export const W_EXITCODE = (code: number) => (code & 0xff) << 8;
export const W_TERMSIG = (sig: number) => sig & 0x7f;
export const W_STOPCODE = (sig: number) => ((sig & 0xff) << 8) | 0x7f;
export const WIFEXITED = (s: number) => (s & 0x7f) === 0;
export const WEXITSTATUS = (s: number) => (s >> 8) & 0xff;
export const WIFSIGNALED = (s: number) => (s & 0x7f) !== 0 && (s & 0x7f) !== 0x7f;
export const WTERMSIG = (s: number) => s & 0x7f;
export const WIFSTOPPED = (s: number) => (s & 0xff) === 0x7f;
export const WSTOPSIG = (s: number) => (s >> 8) & 0xff;
export const WIFCONTINUED = (s: number) => s === 0xffff;
/** Shell-style exit code ($?): the exit status, or 128 + signal. */
export function shellExitCode(status: number): number {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  if (WIFSTOPPED(status)) return 128 + WSTOPSIG(status);
  return 0;
}

// ── Signals (Linux numbering; dispositions live in signals.ts) ─────────────
export const SIGHUP = 1;
export const SIGINT = 2;
export const SIGQUIT = 3;
export const SIGILL = 4;
export const SIGTRAP = 5;
export const SIGABRT = 6;
export const SIGBUS = 7;
export const SIGFPE = 8;
export const SIGKILL = 9;
export const SIGUSR1 = 10;
export const SIGSEGV = 11;
export const SIGUSR2 = 12;
export const SIGPIPE = 13;
export const SIGALRM = 14;
export const SIGTERM = 15;
export const SIGCHLD = 17;
export const SIGCONT = 18;
export const SIGSTOP = 19;
export const SIGTSTP = 20;
export const SIGTTIN = 21;
export const SIGTTOU = 22;
export const SIGURG = 23;
export const SIGWINCH = 28;
export const NSIG = 65;

export const SIGNAL_NAMES: Record<number, string> = {
  1: 'HUP', 2: 'INT', 3: 'QUIT', 4: 'ILL', 5: 'TRAP', 6: 'ABRT', 7: 'BUS', 8: 'FPE',
  9: 'KILL', 10: 'USR1', 11: 'SEGV', 12: 'USR2', 13: 'PIPE', 14: 'ALRM', 15: 'TERM',
  17: 'CHLD', 18: 'CONT', 19: 'STOP', 20: 'TSTP', 21: 'TTIN', 22: 'TTOU', 23: 'URG',
  28: 'WINCH',
};

/** Default action for a signal with no handler installed. */
export function defaultSignalAction(sig: number): 'term' | 'ignore' | 'stop' | 'cont' {
  switch (sig) {
    case SIGCHLD: case SIGURG: case SIGWINCH: return 'ignore';
    case SIGSTOP: case SIGTSTP: case SIGTTIN: case SIGTTOU: return 'stop';
    case SIGCONT: return 'cont';
    default: return 'term';
  }
}

// ── epoll ──────────────────────────────────────────────────────────────────
export const EPOLL_CTL_ADD = 1;
export const EPOLL_CTL_DEL = 2;
export const EPOLL_CTL_MOD = 3;
export const EPOLLIN = 0x001;
export const EPOLLPRI = 0x002;
export const EPOLLOUT = 0x004;
export const EPOLLERR = 0x008;
export const EPOLLHUP = 0x010;
export const EPOLLRDHUP = 0x2000;
export const EPOLLEXCLUSIVE = 1 << 28;
export const EPOLLWAKEUP = 1 << 29;
export const EPOLLONESHOT = 1 << 30;
export const EPOLLET = 1 << 31;
export const EPOLL_CLOEXEC = 0o2000000;
/** struct epoll_event is packed on x86-64: u32 events, u64 data. */
export const EPOLL_EVENT_SIZE = 12;

// ── Signal actions ─────────────────────────────────────────────────────────
export const SIG_DFL = 0;
export const SIG_IGN = 1;
export const SIG_BLOCK = 0;
export const SIG_UNBLOCK = 1;
export const SIG_SETMASK = 2;
export const SA_NOCLDSTOP = 0x00000001;
export const SA_NOCLDWAIT = 0x00000002;
export const SA_SIGINFO = 0x00000004;
export const SA_ONSTACK = 0x08000000;
export const SA_RESTART = 0x10000000;
export const SA_NODEFER = 0x40000000;
export const SA_RESETHAND = 0x80000000;
export const SS_ONSTACK = 1;
export const SS_DISABLE = 2;
/** struct kernel_sigaction (x86-64): u64 handler, u64 flags, u64 restorer, u64 mask. */
export const SIGACTION_SIZE = 32;
/** stack_t (x86-64): u64 ss_sp, i32 ss_flags, pad, u64 ss_size. */
export const STACK_T_SIZE = 24;

/** 64-bit sigset (bit sig-1) as [lo, hi] uint32 words. */
export function sigsetToWords(set: Iterable<number>): [number, number] {
  let lo = 0, hi = 0;
  for (const s of set) {
    if (s >= 1 && s <= 32) lo |= 1 << (s - 1);
    else if (s > 32 && s <= 64) hi |= 1 << (s - 33);
  }
  return [lo >>> 0, hi >>> 0];
}
export function sigsetFromWords(lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < 32; i++) {
    if ((lo >>> i) & 1) out.add(i + 1);
    if ((hi >>> i) & 1) out.add(i + 33);
  }
  return out;
}

// ── Sockets ────────────────────────────────────────────────────────────────
export const AF_UNSPEC = 0;
export const AF_UNIX = 1;
export const AF_INET = 2;
export const AF_INET6 = 10;
export const SOCK_STREAM = 1;
export const SOCK_DGRAM = 2;
export const SOCK_RAW = 3;
export const SOCK_SEQPACKET = 5;
export const SOCK_NONBLOCK = 0o4000;
export const SOCK_CLOEXEC = 0o2000000;
export const SOL_SOCKET = 1;
export const IPPROTO_IP = 0;
export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;
export const IPPROTO_IPV6 = 41;
export const SO_DEBUG = 1;
export const SO_REUSEADDR = 2;
export const SO_TYPE = 3;
export const SO_ERROR = 4;
export const SO_DONTROUTE = 5;
export const SO_BROADCAST = 6;
export const SO_SNDBUF = 7;
export const SO_RCVBUF = 8;
export const SO_KEEPALIVE = 9;
export const SO_OOBINLINE = 10;
export const SO_LINGER = 13;
export const SO_REUSEPORT = 15;
export const SO_RCVLOWAT = 18;
export const SO_SNDLOWAT = 19;
export const SO_RCVTIMEO = 20;
export const SO_SNDTIMEO = 21;
export const SO_ACCEPTCONN = 30;
export const SO_PROTOCOL = 38;
export const SO_DOMAIN = 39;
export const TCP_NODELAY = 1;
export const TCP_KEEPIDLE = 4;
export const TCP_KEEPINTVL = 5;
export const TCP_KEEPCNT = 6;
export const IPV6_V6ONLY = 26;
export const MSG_OOB = 0x1;
export const MSG_PEEK = 0x2;
export const MSG_DONTROUTE = 0x4;
export const MSG_TRUNC = 0x20;
export const MSG_DONTWAIT = 0x40;
export const MSG_EOR = 0x80;
export const MSG_WAITALL = 0x100;
export const MSG_NOSIGNAL = 0x4000;
export const SHUT_RD = 0;
export const SHUT_WR = 1;
export const SHUT_RDWR = 2;
/** Room recvfrom/accept reserve after the payload for a sockaddr (sockaddr_in6 = 28 bytes). */
export const SOCKADDR_ROOM = 28;

// ── ioctl (just the ones the core needs; termios is pty.ts) ─────────────────
export const TCGETS = 0x5401;
export const TIOCGWINSZ = 0x5413;
export const FIONREAD = 0x541b;
export const FIONBIO = 0x5421;
export const FIOCLEX = 0x5451;
export const FIONCLEX = 0x5450;

// ── File types (st_mode) ───────────────────────────────────────────────────
export const S_IFMT = 0o170000;
export const S_IFSOCK = 0o140000;
export const S_IFLNK = 0o120000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;

/** Pipe capacity and the atomic-write limit. */
export const PIPE_BUF = 4096;
export const PIPE_CAPACITY = 65536;

/** Most fds a process may hold. */
export const OPEN_MAX = 1024;

// ── struct stat ─────────────────────────────────────────────────────────────
export interface KStat {
  dev: number;
  ino: number;
  mode: number;       // S_IF* | permission bits
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** Size of the Linux x86-64 `struct stat` that encodeStat/decodeStat use. */
export const STAT_SIZE = 144;

function setU64(dv: DataView, off: number, v: number) {
  dv.setUint32(off, v >>> 0, true);
  dv.setUint32(off + 4, Math.floor(v / 0x100000000) >>> 0, true);
}
function getU64(dv: DataView, off: number): number {
  return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;
}

/** Write `st` into `out` (≥ STAT_SIZE bytes) with the Linux x86-64 layout. */
export function encodeStat(st: KStat, out: Uint8Array): void {
  const dv = new DataView(out.buffer, out.byteOffset, STAT_SIZE);
  for (let i = 0; i < STAT_SIZE; i++) out[i] = 0;
  setU64(dv, 0, st.dev);
  setU64(dv, 8, st.ino);
  setU64(dv, 16, st.nlink);
  dv.setUint32(24, st.mode, true);
  dv.setUint32(28, st.uid, true);
  dv.setUint32(32, st.gid, true);
  setU64(dv, 40, st.rdev);
  setU64(dv, 48, st.size);
  setU64(dv, 56, st.blksize);
  setU64(dv, 64, st.blocks);
  const ts = (off: number, ms: number) => {
    setU64(dv, off, Math.floor(ms / 1000));
    setU64(dv, off + 8, Math.floor((ms % 1000) * 1e6));
  };
  ts(72, st.atimeMs);
  ts(88, st.mtimeMs);
  ts(104, st.ctimeMs);
}

export function decodeStat(buf: Uint8Array): KStat {
  const dv = new DataView(buf.buffer, buf.byteOffset, STAT_SIZE);
  const ts = (off: number) => getU64(dv, off) * 1000 + Math.floor(getU64(dv, off + 8) / 1e6);
  return {
    dev: getU64(dv, 0),
    ino: getU64(dv, 8),
    nlink: getU64(dv, 16),
    mode: dv.getUint32(24, true),
    uid: dv.getUint32(28, true),
    gid: dv.getUint32(32, true),
    rdev: getU64(dv, 40),
    size: getU64(dv, 48),
    blksize: getU64(dv, 56),
    blocks: getU64(dv, 64),
    atimeMs: ts(72),
    mtimeMs: ts(88),
    ctimeMs: ts(104),
  };
}

/** `struct linux_dirent64` d_type values. */
export const DT_UNKNOWN = 0;
export const DT_FIFO = 1;
export const DT_CHR = 2;
export const DT_DIR = 4;
export const DT_REG = 8;
export const DT_LNK = 10;

// ── Syscall channel layout (see channel.ts) ─────────────────────────────────
export const CH_STATE = 0;      // Int32 index: 0 idle, 1 request posted, 2 reply ready
export const CH_SYSNO = 1;
export const CH_RESULT = 2;     // result or -errno
export const CH_SIGNAL = 3;     // pending-signal flag (kernel sets; guest checks after every reply)
export const CH_ARGS = 4;       // Int32[4..15]: args; 64-bit = lo, hi. CH_ARGS also carries the high word of a 64-bit result.
export const CH_NARGS = 12;
export const CH_DATA = 64;      // byte offset of the data area
export const CH_DEFAULT_DATA_SIZE = 1 << 20;

export const STATE_IDLE = 0;
export const STATE_REQUEST = 1;
export const STATE_REPLY = 2;
