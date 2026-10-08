/**
 * Linux x86-64 Syscall Emulation.
 * Maps Linux syscalls to Shiro VFS and I/O operations.
 */

import { CPU, RAX, RDI, RSI, RDX, R8, R10 } from './cpu';
import { VirtualMemory } from './memory';
import type { FileSystem } from '../filesystem';
import {
  netStack, NetStack, KSocket, KDatagramSocket, decodeSockaddr, encodeSockaddr, type SockAddr,
  AF_UNIX, O_NONBLOCK, POLLIN, POLLOUT, POLLNVAL, SOL_SOCKET, SO_RCVTIMEO, SO_SNDTIMEO, SO_LINGER, FIONREAD,
  ENOTSOCK, EOPNOTSUPP, EAFNOSUPPORT as NET_EAFNOSUPPORT,
} from '../kernel/net';
import { retain, release, type OpenFile } from '../kernel/fd';
import { EpollFile } from '../kernel/epoll';

// Linux error codes (negated — syscalls return -ERRNO)
const ENOENT = 2;
const EBADF = 9;
const ENOMEM = 12;
const EACCES = 13;
const EFAULT = 14;
const ENOTTY = 25;
const EPERM = 1;
const EINVAL = 22;
const ENOSPC = 28;
const ENOSYS = 38;
const ENETUNREACH = 101;
const ECONNREFUSED = 111;

// File descriptor table entry
interface FDEntry {
  path: string;
  offset: number;
  content: Uint8Array | null;  // null = stdin/stdout/stderr
  flags: number;
  pipe?: PipeBuffer;  // if this FD is a pipe endpoint
  sock?: KSocket | KDatagramSocket;  // if this FD is a kernel socket (src/kernel/net.ts)
  epoll?: EpollFile;  // if this FD is an epoll instance (src/kernel/epoll.ts)
  legacyHttp?: LegacyHttp;  // port-80 fetch emulation when no TCP relay is configured
}

// In-memory ring buffer for pipe(2)
interface PipeBuffer {
  data: Uint8Array;
  readPos: number;
  writePos: number;
  closed: boolean;
}

// Plain-HTTP-over-fetch emulation, the pre-relay behavior, kept for port 80 when no relay is configured
interface LegacyHttp {
  targetHost: string;
  targetPort: number;
  writeBuffer: Uint8Array[];
  readBuffer: Uint8Array;
  readOffset: number;
}

// Stat struct size (Linux x86-64 stat struct = 144 bytes)
const STAT_SIZE = 144;

export class X86Exit {
  constructor(public code: number) {}
}

export class LinuxSyscalls {
  private cpu: CPU;
  private mem: VirtualMemory;
  private fs: FileSystem;
  private cwd: string;
  private fdTable: Map<number, FDEntry> = new Map();
  /** Network stack backing socket fds (tests swap in their own). */
  net: NetStack = netStack;
  private nextFd = 3;
  private brkAddr: bigint;
  private startTime: number;

  // I/O callbacks
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  stdinBuffer: string;
  /** Blocking stdin (kernel processes): replaces stdinBuffer when set */
  readStdin?: (n: number) => Promise<Uint8Array>;

  constructor(
    cpu: CPU, mem: VirtualMemory, fs: FileSystem, cwd: string,
    onStdout: (data: string) => void,
    onStderr: (data: string) => void,
    stdinBuffer: string = '',
  ) {
    this.cpu = cpu;
    this.mem = mem;
    this.fs = fs;
    this.cwd = cwd;
    this.onStdout = onStdout;
    this.onStderr = onStderr;
    this.stdinBuffer = stdinBuffer;
    this.brkAddr = 0x1000000n; // initial break at 16MB
    this.startTime = performance.now();

    // Set up standard FDs
    this.fdTable.set(0, { path: '/dev/stdin', offset: 0, content: null, flags: 0 });
    this.fdTable.set(1, { path: '/dev/stdout', offset: 0, content: null, flags: 1 });
    this.fdTable.set(2, { path: '/dev/stderr', offset: 0, content: null, flags: 1 });
  }

  /** Handle a SYSCALL instruction. Reads args from registers, writes result to RAX. */
  async handleSyscall(): Promise<void> {
    const nr = Number(this.cpu.getReg64(RAX));
    const arg0 = this.cpu.getReg64(RDI);
    const arg1 = this.cpu.getReg64(RSI);
    const arg2 = this.cpu.getReg64(RDX);
    const arg3 = this.cpu.getReg64(R10);
    const arg4 = this.cpu.getReg64(R8);
    const arg5 = this.cpu.getReg64(R8 + 1); // R9

    let result: bigint;

    switch (nr) {
      case 0:   result = await this.sysRead(arg0, arg1, arg2); break;
      case 1:   result = await this.sysWrite(arg0, arg1, arg2); break;
      case 2:   result = await this.sysOpen(arg0, arg1, arg2); break;
      case 3:   result = this.sysClose(arg0); break;
      case 4:   result = await this.sysStat(arg0, arg1); break;
      case 5:   result = await this.sysFstat(arg0, arg1); break;
      case 6:   result = await this.sysLstat(arg0, arg1); break;
      case 8:   result = this.sysLseek(arg0, arg1, arg2); break;
      case 9:   result = this.sysMmap(arg0, arg1, arg2, arg3, arg4, arg5); break;
      case 10:  result = 0n; break; // mprotect — no-op
      case 11:  result = this.sysMunmap(arg0, arg1); break;
      case 12:  result = this.sysBrk(arg0); break;
      case 16:  result = await this.sysIoctl(arg0, arg1, arg2); break;
      case 21:  result = await this.sysAccess(arg0, arg1); break;
      case 32:  result = this.sysDup(arg0); break;
      case 33:  result = this.sysDup2(arg0, arg1); break;
      case 39:  result = 1000n; break; // getpid
      case 60:  throw new X86Exit(Number(arg0 & 0xFFn)); // exit
      case 63:  result = this.sysUname(arg0); break;
      case 79:  result = this.sysGetcwd(arg0, arg1); break;
      case 80:  result = await this.sysChdir(arg0); break;
      case 102: result = 1000n; break; // getuid
      case 104: result = 1000n; break; // getgid
      case 107: result = 1000n; break; // geteuid
      case 108: result = 1000n; break; // getegid
      case 110: result = 1000n; break; // getppid
      case 13:  result = this.sysRtSigaction(arg0, arg1, arg2); break;
      case 14:  result = this.sysRtSigprocmask(arg0, arg1, arg2, arg3); break;
      case 22:  result = this.sysPipe(arg0); break; // pipe
      case 20:  result = await this.sysWritev(arg0, arg1, arg2); break;
      case 72:  result = this.sysFcntl(arg0, arg1, arg2); break;
      case 89:  result = this.sysReadlink(arg0, arg1, arg2); break;
      case 158: result = this.sysArchPrctl(arg0, arg1); break;
      case 218: result = 1000n; break; // set_tid_address — return fake TID
      case 271: result = await this.sysPpoll(arg0, arg1, arg2); break; // ppoll
      case 302: result = this.sysPrlimit64(arg0, arg1, arg2, arg3); break;
      case 318: result = this.sysGetrandom(arg0, arg1, arg2); break;
      case 7:   result = await this.sysPoll(arg0, Number(arg1), Number(BigInt.asIntN(32, arg2))); break; // poll
      case 17:  result = await this.sysPread64(arg0, arg1, arg2, arg3); break;
      case 18:  result = await this.sysPwrite64(arg0, arg1, arg2, arg3); break;
      case 19:  result = await this.sysReadv(arg0, arg1, arg2); break;
      case 28:  result = 0n; break; // madvise — no-op
      case 35:  result = this.sysNanosleep(arg0, arg1); break;
      case 41:  result = this.sysSocket(arg0, arg1, arg2); break; // socket
      case 42:  result = await this.sysConnect(arg0, arg1, arg2); break; // connect
      case 43:  result = await this.sysAccept(arg0, arg1, arg2, 0n); break; // accept
      case 288: result = await this.sysAccept(arg0, arg1, arg2, arg3); break; // accept4
      case 44:  result = await this.sysSendto(arg0, arg1, arg2, arg3, arg4, arg5); break; // sendto
      case 45:  result = await this.sysRecvfrom(arg0, arg1, arg2, arg3, arg4, arg5); break; // recvfrom
      case 46:  result = await this.sysSendmsg(arg0, arg1, arg2); break; // sendmsg
      case 47:  result = await this.sysRecvmsg(arg0, arg1, arg2); break; // recvmsg
      case 48:  result = this.sysShutdown(arg0, arg1); break; // shutdown
      case 49:  result = this.sysBind(arg0, arg1, arg2); break; // bind
      case 50:  result = this.sysListen(arg0, arg1); break; // listen
      case 51:  result = this.sysGetsockname(arg0, arg1, arg2); break; // getsockname
      case 52:  result = this.sysGetpeername(arg0, arg1, arg2); break; // getpeername
      case 53:  result = this.sysSocketpair(arg0, arg1, arg2, arg3); break; // socketpair
      case 54:  result = this.sysGetsockopt(arg0, arg1, arg2, arg3, arg4); break; // getsockopt
      case 55:  result = this.sysSetsockopt(arg0, arg1, arg2, arg3, arg4); break; // setsockopt
      case 56:  result = -BigInt(ENOSYS); break; // clone — not supported
      case 99:  result = this.sysSysinfo(arg0); break;
      case 131: result = -BigInt(EACCES); break; // sigaltstack — stub
      case 137: result = 0n; break; // statfs — stub return ok
      case 157: result = 0n; break; // prctl — stub
      case 186: result = 1000n; break; // gettid
      case 200: result = -BigInt(ENOSYS); break; // tkill — stub
      case 202: result = 0n; break; // futex — stub (return success)
      case 204: result = 0n; break; // sched_getaffinity — stub
      case 217: result = this.sysGetdents64(arg0, arg1, arg2); break;
      case 233: result = this.sysEpollCtl(arg0, arg1, arg2, arg3); break; // epoll_ctl
      case 232: result = await this.sysEpollWait(arg0, arg1, arg2, arg3); break; // epoll_wait
      case 281: result = await this.sysEpollWait(arg0, arg1, arg2, arg3); break; // epoll_pwait (sigmask ignored)
      case 213: result = this.sysEpollCreate(Number(arg0) > 0 ? 0n : -1n); break; // epoll_create
      case 234: result = -BigInt(ENOSYS); break; // tgkill
      case 267: result = this.sysReadlinkat(arg0, arg1, arg2, arg3); break;
      case 273: result = 0n; break; // set_robust_list — stub
      case 291: result = this.sysEpollCreate(arg0); break; // epoll_create1
      case 293: result = this.sysPipe2(arg0, arg1); break; // pipe2
      case 228: result = this.sysClockGettime(arg0, arg1); break;
      case 231: throw new X86Exit(Number(arg0 & 0xFFn)); // exit_group
      case 257: result = await this.sysOpenat(arg0, arg1, arg2, arg3); break;
      case 262: result = await this.sysNewfstatat(arg0, arg1, arg2, arg3); break;
      default:
        // Unimplemented syscall — return ENOSYS
        result = -BigInt(ENOSYS);
    }

    this.cpu.setReg64(RAX, result & 0xFFFFFFFFFFFFFFFFn);
  }

  // ─── Syscall implementations ──────────────────────────────────────────────

  private async sysRead(fdNum: bigint, buf: bigint, count: bigint): Promise<bigint> {
    const fd = Number(fdNum);
    const n = Number(count);

    const sockEntry = this.fdTable.get(fd);
    if (sockEntry?.sock || sockEntry?.legacyHttp) return this.sysRecvfrom(fdNum, buf, count, 0n, 0n, 0n);
    if (fd === 0 && this.readStdin) {
      const bytes = await this.readStdin(n);
      this.mem.writeBytes(buf, bytes);
      return BigInt(bytes.length);
    }

    if (fd === 0) {
      // Read from stdin
      const data = this.stdinBuffer.slice(0, n);
      this.stdinBuffer = this.stdinBuffer.slice(n);
      const encoded = new TextEncoder().encode(data);
      this.mem.writeBytes(buf, encoded);
      return BigInt(encoded.length);
    }

    const entry = this.fdTable.get(fd);
    if (!entry) return -BigInt(EBADF);

    // Pipe read
    if (entry.pipe) {
      const pipe = entry.pipe;
      const available = pipe.writePos - pipe.readPos;
      if (available <= 0) return 0n; // EOF or empty
      const toRead = Math.min(n, available);
      const slice = pipe.data.slice(pipe.readPos, pipe.readPos + toRead);
      this.mem.writeBytes(buf, slice);
      pipe.readPos += toRead;
      return BigInt(toRead);
    }

    if (!entry.content) return -BigInt(EBADF);

    const available = entry.content.length - entry.offset;
    const toRead = Math.min(n, available);
    if (toRead <= 0) return 0n;

    const slice = entry.content.slice(entry.offset, entry.offset + toRead);
    this.mem.writeBytes(buf, slice);
    entry.offset += toRead;
    return BigInt(toRead);
  }

  private async sysWrite(fdNum: bigint, buf: bigint, count: bigint): Promise<bigint> {
    const fd = Number(fdNum);
    const n = Number(count);

    const sockEntry = this.fdTable.get(fd);
    if (sockEntry?.sock || sockEntry?.legacyHttp) return this.sockSend(sockEntry, this.mem.readBytes(buf, n), 0, null);

    const data = this.mem.readBytes(buf, n);
    const text = new TextDecoder().decode(data);

    if (fd === 1) {
      this.onStdout(text);
      return BigInt(n);
    }
    if (fd === 2) {
      this.onStderr(text);
      return BigInt(n);
    }

    const entry = this.fdTable.get(fd);
    if (!entry) return -BigInt(EBADF);

    // Pipe write
    if (entry.pipe) {
      const pipe = entry.pipe;
      const space = pipe.data.length - pipe.writePos;
      const toWrite = Math.min(n, space);
      if (toWrite <= 0) return -BigInt(ENOSPC);
      pipe.data.set(data.slice(0, toWrite), pipe.writePos);
      pipe.writePos += toWrite;
      return BigInt(toWrite);
    }

    // Write to file — accumulate and flush on close
    // For simplicity, we buffer writes in content
    if (entry.content) {
      const newContent = new Uint8Array(Math.max(entry.content.length, entry.offset + n));
      newContent.set(entry.content);
      newContent.set(data, entry.offset);
      entry.content = newContent;
      entry.offset += n;
    }
    return BigInt(n);
  }

  private async sysOpen(pathAddr: bigint, flags: bigint, mode: bigint): Promise<bigint> {
    const path = this.mem.readString(pathAddr);
    return this.openFile(path, Number(flags));
  }

  private async sysOpenat(dirfd: bigint, pathAddr: bigint, flags: bigint, mode: bigint): Promise<bigint> {
    const path = this.mem.readString(pathAddr);
    // AT_FDCWD = -100 — use cwd
    return this.openFile(path, Number(flags));
  }

  private async openFile(path: string, flags: number): Promise<bigint> {
    const resolved = path.startsWith('/') ? path : this.cwd + '/' + path;
    try {
      const data = await this.fs.readFile(resolved) as string;
      const encoded = new TextEncoder().encode(data);
      const fd = this.nextFd++;
      this.fdTable.set(fd, { path: resolved, offset: 0, content: encoded, flags });
      return BigInt(fd);
    } catch {
      return -BigInt(ENOENT);
    }
  }

  private sysClose(fdNum: bigint): bigint {
    const fd = Number(fdNum);
    if (fd < 3) return 0n; // Don't close stdin/stdout/stderr
    if (!this.fdTable.has(fd)) return -BigInt(EBADF);
    const entry = this.fdTable.get(fd);
    this.fdTable.delete(fd);
    this.releaseSock(entry);
    return 0n;
  }

  private async sysStat(pathAddr: bigint, statBuf: bigint): Promise<bigint> {
    const path = this.mem.readString(pathAddr);
    return this.fillStat(path, statBuf);
  }

  private async sysFstat(fdNum: bigint, statBuf: bigint): Promise<bigint> {
    const fd = Number(fdNum);
    if (fd < 3) {
      // stdin/stdout/stderr — fill with tty-like stat
      this.fillStatBuf(statBuf, 0, 0o20666, 0); // char device
      return 0n;
    }
    const entry = this.fdTable.get(fd);
    if (!entry) return -BigInt(EBADF);
    if (entry.sock || entry.legacyHttp) {
      this.fillStatBuf(statBuf, 0, 0o140777, 1); // S_IFSOCK
      return 0n;
    }
    return this.fillStat(entry.path, statBuf);
  }

  private async sysLstat(pathAddr: bigint, statBuf: bigint): Promise<bigint> {
    // Same as stat (no symlink support)
    return this.sysStat(pathAddr, statBuf);
  }

  private async sysNewfstatat(dirfd: bigint, pathAddr: bigint, statBuf: bigint, flags: bigint): Promise<bigint> {
    const path = this.mem.readString(pathAddr);
    return this.fillStat(path, statBuf);
  }

  private async fillStat(path: string, statBuf: bigint): Promise<bigint> {
    const resolved = path.startsWith('/') ? path : this.cwd + '/' + path;
    try {
      const stat = await this.fs.stat(resolved);
      const size = stat.size || 0;
      const mode = stat.isDirectory() ? 0o40755 : 0o100644;
      this.fillStatBuf(statBuf, size, mode, stat.isDirectory() ? 2 : 1);
      return 0n;
    } catch {
      return -BigInt(ENOENT);
    }
  }

  private fillStatBuf(buf: bigint, size: number, mode: number, nlink: number): void {
    // Zero the struct first
    for (let i = 0; i < STAT_SIZE; i++) this.mem.write8(buf + BigInt(i), 0);
    // st_mode at offset 24 (4 bytes)
    this.mem.write32(buf + 24n, mode);
    // st_nlink at offset 28 (8 bytes)
    this.mem.write64(buf + 28n, BigInt(nlink));
    // st_uid at offset 36 (4 bytes)
    this.mem.write32(buf + 36n, 1000);
    // st_gid at offset 40 (4 bytes)
    this.mem.write32(buf + 40n, 1000);
    // st_size at offset 48 (8 bytes)
    this.mem.write64(buf + 48n, BigInt(size));
    // st_blksize at offset 56 (8 bytes)
    this.mem.write64(buf + 56n, 4096n);
  }

  private sysLseek(fdNum: bigint, offset: bigint, whence: bigint): bigint {
    const fd = Number(fdNum);
    const entry = this.fdTable.get(fd);
    if (!entry || !entry.content) return -BigInt(EBADF);

    const off = Number(BigInt.asIntN(64, offset));
    switch (Number(whence)) {
      case 0: entry.offset = off; break; // SEEK_SET
      case 1: entry.offset += off; break; // SEEK_CUR
      case 2: entry.offset = entry.content.length + off; break; // SEEK_END
    }
    return BigInt(entry.offset);
  }

  private sysMmap(addr: bigint, length: bigint, prot: bigint, flags: bigint, fd: bigint, offset: bigint): bigint {
    const len = Number(length);
    const f = Number(flags);
    const pages = Math.ceil(len / 4096);

    // MAP_FIXED (0x10) — use the specified address
    const useFixed = (f & 0x10) !== 0 && addr !== 0n;

    // MAP_ANONYMOUS (0x20) — just allocate memory
    if (f & 0x20) {
      const allocAddr = useFixed ? addr : this.brkAddr;
      this.mem.allocatePages(allocAddr, pages);
      // Zero-fill for MAP_ANONYMOUS
      for (let i = 0n; i < BigInt(len); i++) {
        this.mem.write8(allocAddr + i, 0);
      }
      if (!useFixed) this.brkAddr += BigInt(pages * 4096);
      return allocAddr;
    }

    // File mapping — read file content into memory
    const fdEntry = this.fdTable.get(Number(fd));
    if (!fdEntry || !fdEntry.content) return -BigInt(EBADF);

    const allocAddr = useFixed ? addr : this.brkAddr;
    this.mem.allocatePages(allocAddr, pages);
    const off = Number(offset);
    const data = fdEntry.content.slice(off, off + len);
    this.mem.writeBytes(allocAddr, data);
    if (!useFixed) this.brkAddr += BigInt(pages * 4096);
    return allocAddr;
  }

  private sysMunmap(addr: bigint, length: bigint): bigint {
    const pages = Math.ceil(Number(length) / 4096);
    this.mem.freePages(addr, pages);
    return 0n;
  }

  private sysBrk(newBrk: bigint): bigint {
    if (newBrk === 0n) return this.brkAddr;
    if (newBrk > this.brkAddr) {
      const pages = Math.ceil(Number(newBrk - this.brkAddr) / 4096);
      this.mem.allocatePages(this.brkAddr, pages);
    }
    this.brkAddr = newBrk;
    return this.brkAddr;
  }

  private async sysIoctl(fdNum: bigint, request: bigint, arg: bigint): Promise<bigint> {
    const sock = this.fdTable.get(Number(fdNum))?.sock;
    if (sock) {
      const req = Number(request);
      if (req === 0x5421) { // FIONBIO
        sock.flags = this.mem.read32(arg) ? sock.flags | O_NONBLOCK : sock.flags & ~O_NONBLOCK;
        return 0n;
      }
      if (req === FIONREAD) {
        const out = new Uint8Array(4);
        const r = await sock.ioctl(req, out);
        if (r === 0) this.mem.writeBytes(arg, out);
        return BigInt(r);
      }
      return -BigInt(ENOTTY);
    }
    // TIOCGWINSZ (0x5413) — return terminal size
    if (Number(request) === 0x5413 && Number(fdNum) <= 2) {
      // struct winsize { rows(2), cols(2), xpixel(2), ypixel(2) }
      this.mem.write16(arg, 24); // rows
      this.mem.write16(arg + 2n, 80); // cols
      this.mem.write16(arg + 4n, 0);
      this.mem.write16(arg + 6n, 0);
      return 0n;
    }
    return -BigInt(ENOTTY);
  }

  private async sysAccess(pathAddr: bigint, mode: bigint): Promise<bigint> {
    const path = this.mem.readString(pathAddr);
    const resolved = path.startsWith('/') ? path : this.cwd + '/' + path;
    try {
      await this.fs.stat(resolved);
      return 0n;
    } catch {
      return -BigInt(ENOENT);
    }
  }

  private sysDup(oldFd: bigint): bigint {
    const entry = this.fdTable.get(Number(oldFd));
    if (!entry) return -BigInt(EBADF);
    const newFd = this.nextFd++;
    this.fdTable.set(newFd, { ...entry });
    const kf = this.kfile(entry);
    if (kf) retain(kf);
    return BigInt(newFd);
  }

  private sysDup2(oldFd: bigint, newFd: bigint): bigint {
    const entry = this.fdTable.get(Number(oldFd));
    if (!entry) return -BigInt(EBADF);
    const nfd = Number(newFd);
    // Close existing FD at newFd if any
    if (nfd === Number(oldFd)) return BigInt(nfd);
    const replaced = this.fdTable.get(nfd);
    this.fdTable.delete(nfd);
    this.fdTable.set(nfd, { ...entry });
    const kf = this.kfile(entry);
    if (kf) retain(kf);
    this.releaseSock(replaced);
    return BigInt(nfd);
  }

  // ─── Pipe syscalls ────────────────────────────────────────────────────────

  private sysPipe(pipefdAddr: bigint): bigint {
    return this.createPipe(pipefdAddr, 0);
  }

  private sysPipe2(pipefdAddr: bigint, flags: bigint): bigint {
    return this.createPipe(pipefdAddr, Number(flags));
  }

  private createPipe(pipefdAddr: bigint, _flags: number): bigint {
    const buf: PipeBuffer = {
      data: new Uint8Array(65536), // 64KB ring buffer
      readPos: 0,
      writePos: 0,
      closed: false,
    };

    const readFd = this.nextFd++;
    const writeFd = this.nextFd++;

    this.fdTable.set(readFd, {
      path: `pipe:[${readFd}]`,
      offset: 0,
      content: null,
      flags: 0, // O_RDONLY
      pipe: buf,
    });

    this.fdTable.set(writeFd, {
      path: `pipe:[${writeFd}]`,
      offset: 0,
      content: null,
      flags: 1, // O_WRONLY
      pipe: buf,
    });

    // Write [readFd, writeFd] as int32 pair to user memory
    this.mem.write32(pipefdAddr, readFd);
    this.mem.write32(pipefdAddr + 4n, writeFd);

    return 0n;
  }

  // ─── Signal syscalls (enhanced stubs) ─────────────────────────────────────

  private sigActions: Map<number, bigint> = new Map(); // signal → handler address
  private sigMask: bigint = 0n; // blocked signal mask

  private sysRtSigaction(signum: bigint, act: bigint, oldact: bigint): bigint {
    const sig = Number(signum);
    if (sig < 1 || sig > 64) return -BigInt(EINVAL);

    // Save old action if oldact is non-null
    if (oldact !== 0n) {
      const oldHandler = this.sigActions.get(sig) || 0n; // SIG_DFL
      this.mem.write64(oldact, oldHandler);       // sa_handler
      this.mem.write64(oldact + 8n, 0n);          // sa_flags
      this.mem.write64(oldact + 16n, 0n);         // sa_restorer
      this.mem.write64(oldact + 24n, 0n);         // sa_mask
    }

    // Set new action if act is non-null
    if (act !== 0n) {
      const handler = this.mem.read64(act);
      this.sigActions.set(sig, handler);
    }

    return 0n;
  }

  private sysRtSigprocmask(how: bigint, set: bigint, oldset: bigint, _sigsetsize: bigint): bigint {
    // Save old mask
    if (oldset !== 0n) {
      this.mem.write64(oldset, this.sigMask);
    }

    // Modify mask
    if (set !== 0n) {
      const newMask = this.mem.read64(set);
      switch (Number(how)) {
        case 0: // SIG_BLOCK
          this.sigMask |= newMask;
          break;
        case 1: // SIG_UNBLOCK
          this.sigMask &= ~newMask;
          break;
        case 2: // SIG_SETMASK
          this.sigMask = newMask;
          break;
        default:
          return -BigInt(EINVAL);
      }
    }

    return 0n;
  }

  private sysUname(buf: bigint): bigint {
    // struct utsname: 5 fields × 65 bytes each
    const fields = ['Linux', 'shiro', '6.1.0-shiro', '#1 SMP', 'x86_64'];
    for (let i = 0; i < fields.length; i++) {
      this.mem.writeString(buf + BigInt(i * 65), fields[i]);
    }
    return 0n;
  }

  private sysGetcwd(buf: bigint, size: bigint): bigint {
    const encoded = new TextEncoder().encode(this.cwd);
    if (encoded.length + 1 > Number(size)) return -BigInt(ENOMEM);
    this.mem.writeBytes(buf, encoded);
    this.mem.write8(buf + BigInt(encoded.length), 0);
    return buf;
  }

  private async sysChdir(pathAddr: bigint): Promise<bigint> {
    const path = this.mem.readString(pathAddr);
    const resolved = path.startsWith('/') ? path : this.cwd + '/' + path;
    try {
      const stat = await this.fs.stat(resolved);
      if (!stat.isDirectory()) return -BigInt(ENOTTY);
      this.cwd = resolved;
      return 0n;
    } catch {
      return -BigInt(ENOENT);
    }
  }

  private async sysWritev(fdNum: bigint, iovAddr: bigint, iovcnt: bigint): Promise<bigint> {
    const fd = Number(fdNum);
    const cnt = Number(iovcnt);
    let totalWritten = 0;

    const sockEntry = this.fdTable.get(fd);
    if (sockEntry?.sock || sockEntry?.legacyHttp) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < cnt; i++) {
        const base = iovAddr + BigInt(i * 16);
        parts.push(this.mem.readBytes(this.mem.read64(base), Number(this.mem.read64(base + 8n))));
      }
      const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) { data.set(p, off); off += p.length; }
      return this.sockSend(sockEntry, data, 0, null);
    }

    for (let i = 0; i < cnt; i++) {
      const base = iovAddr + BigInt(i * 16);
      const bufAddr = this.mem.read64(base);
      const bufLen = Number(this.mem.read64(base + 8n));
      if (bufLen === 0) continue;

      const data = this.mem.readBytes(bufAddr, bufLen);
      const text = new TextDecoder().decode(data);

      if (fd === 1) {
        this.onStdout(text);
      } else if (fd === 2) {
        this.onStderr(text);
      } else {
        const entry = this.fdTable.get(fd);
        if (!entry) return -BigInt(EBADF);
        if (entry.content) {
          const newContent = new Uint8Array(Math.max(entry.content.length, entry.offset + bufLen));
          newContent.set(entry.content);
          newContent.set(data, entry.offset);
          entry.content = newContent;
          entry.offset += bufLen;
        }
      }
      totalWritten += bufLen;
    }
    return BigInt(totalWritten);
  }

  private sysFcntl(fdNum: bigint, cmd: bigint, arg: bigint): bigint {
    const fd = Number(fdNum);
    if (fd > 2 && !this.fdTable.has(fd)) return -BigInt(EBADF);
    const c = Number(cmd);
    // F_GETFD=1, F_SETFD=2, F_GETFL=3, F_SETFL=4
    if (c === 1) return 0n; // F_GETFD → no flags
    if (c === 2) return 0n; // F_SETFD → ok
    if (c === 3) {
      const entry = this.fdTable.get(fd);
      if (entry?.sock) return BigInt(2 | (entry.sock.flags & O_NONBLOCK)); // O_RDWR
      return BigInt(entry ? entry.flags : 0);
    }
    if (c === 4) { // F_SETFL: sockets honor O_NONBLOCK
      const sock = this.fdTable.get(fd)?.sock;
      if (sock) sock.flags = (sock.flags & ~O_NONBLOCK) | (Number(arg) & O_NONBLOCK);
      return 0n;
    }
    return -BigInt(EINVAL);
  }

  private sysReadlink(pathAddr: bigint, buf: bigint, bufsiz: bigint): bigint {
    const path = this.mem.readString(pathAddr);
    if (path === '/proc/self/exe') {
      const exe = '/usr/bin/program';
      const encoded = new TextEncoder().encode(exe);
      const len = Math.min(encoded.length, Number(bufsiz));
      this.mem.writeBytes(buf, encoded.subarray(0, len));
      return BigInt(len);
    }
    return -BigInt(ENOENT);
  }

  private sysPrlimit64(pid: bigint, resource: bigint, newLimit: bigint, oldLimit: bigint): bigint {
    if (oldLimit !== 0n) {
      // Write RLIM_INFINITY to old limit struct {rlim_cur, rlim_max} (2 × uint64)
      const RLIM_INFINITY = 0xFFFFFFFFFFFFFFFFn;
      this.mem.write64(oldLimit, RLIM_INFINITY);      // rlim_cur
      this.mem.write64(oldLimit + 8n, RLIM_INFINITY); // rlim_max
    }
    return 0n;
  }

  private sysGetrandom(buf: bigint, buflen: bigint, flags: bigint): bigint {
    const len = Number(buflen);
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    this.mem.writeBytes(buf, bytes);
    return BigInt(len);
  }

  private async sysPread64(fdNum: bigint, buf: bigint, count: bigint, offset: bigint): Promise<bigint> {
    const fd = Number(fdNum);
    const entry = this.fdTable.get(fd);
    if (!entry || !entry.content) return -BigInt(EBADF);
    const off = Number(offset);
    const n = Number(count);
    const available = entry.content.length - off;
    const toRead = Math.min(n, Math.max(0, available));
    if (toRead <= 0) return 0n;
    const slice = entry.content.slice(off, off + toRead);
    this.mem.writeBytes(buf, slice);
    return BigInt(toRead);
  }

  private async sysPwrite64(fdNum: bigint, buf: bigint, count: bigint, offset: bigint): Promise<bigint> {
    const fd = Number(fdNum);
    const entry = this.fdTable.get(fd);
    if (!entry) return -BigInt(EBADF);
    const n = Number(count);
    const off = Number(offset);
    const data = this.mem.readBytes(buf, n);
    if (entry.content) {
      const newContent = new Uint8Array(Math.max(entry.content.length, off + n));
      newContent.set(entry.content);
      newContent.set(data, off);
      entry.content = newContent;
    }
    return BigInt(n);
  }

  private async sysReadv(fdNum: bigint, iovAddr: bigint, iovcnt: bigint): Promise<bigint> {
    const fd = Number(fdNum);
    const cnt = Number(iovcnt);
    let totalRead = 0;

    const sockEntry = this.fdTable.get(fd);
    if (sockEntry?.sock || sockEntry?.legacyHttp) {
      const iov: { addr: bigint; len: number }[] = [];
      for (let i = 0; i < cnt; i++) {
        const base = iovAddr + BigInt(i * 16);
        iov.push({ addr: this.mem.read64(base), len: Number(this.mem.read64(base + 8n)) });
      }
      const r = await this.sockRecv(sockEntry, iov.reduce((n, v) => n + v.len, 0), 0);
      if (typeof r === 'bigint') return r;
      let off = 0;
      for (const v of iov) {
        if (off >= r.data.length) break;
        const k = Math.min(v.len, r.data.length - off);
        this.mem.writeBytes(v.addr, r.data.subarray(off, off + k));
        off += k;
      }
      return BigInt(r.data.length);
    }

    for (let i = 0; i < cnt; i++) {
      const base = iovAddr + BigInt(i * 16);
      const bufAddr = this.mem.read64(base);
      const bufLen = Number(this.mem.read64(base + 8n));
      if (bufLen === 0) continue;

      if (fd === 0 && this.readStdin) {
        // One blocking read, like readv on a tty: return what arrived
        const bytes = await this.readStdin(bufLen);
        this.mem.writeBytes(bufAddr, bytes);
        totalRead += bytes.length;
        if (bytes.length < bufLen) break;
      } else if (fd === 0) {
        const data = this.stdinBuffer.slice(0, bufLen);
        this.stdinBuffer = this.stdinBuffer.slice(bufLen);
        const encoded = new TextEncoder().encode(data);
        this.mem.writeBytes(bufAddr, encoded);
        totalRead += encoded.length;
      } else {
        const entry = this.fdTable.get(fd);
        if (!entry || !entry.content) return -BigInt(EBADF);
        const available = entry.content.length - entry.offset;
        const toRead = Math.min(bufLen, available);
        if (toRead > 0) {
          const slice = entry.content.slice(entry.offset, entry.offset + toRead);
          this.mem.writeBytes(bufAddr, slice);
          entry.offset += toRead;
          totalRead += toRead;
        }
      }
    }
    return BigInt(totalRead);
  }

  private sysNanosleep(req: bigint, rem: bigint): bigint {
    // Stub: just return success (we can't actually sleep in single-threaded emulation)
    if (rem !== 0n) {
      this.mem.write64(rem, 0n);
      this.mem.write64(rem + 8n, 0n);
    }
    return 0n;
  }

  private sysSysinfo(buf: bigint): bigint {
    // struct sysinfo = 112 bytes on x86-64
    for (let i = 0; i < 112; i++) this.mem.write8(buf + BigInt(i), 0);
    const uptime = BigInt(Math.floor((performance.now() - this.startTime) / 1000));
    this.mem.write64(buf, uptime);          // uptime
    this.mem.write64(buf + 32n, 268435456n); // totalram (256MB)
    this.mem.write64(buf + 40n, 134217728n); // freeram (128MB)
    this.mem.write64(buf + 48n, 134217728n); // sharedram
    this.mem.write64(buf + 56n, 0n);         // bufferram
    this.mem.write64(buf + 64n, 268435456n); // totalswap
    this.mem.write64(buf + 72n, 268435456n); // freeswap
    this.mem.write16(buf + 80n, 0);          // procs
    this.mem.write32(buf + 104n, 1);         // mem_unit
    return 0n;
  }

  private sysGetdents64(fdNum: bigint, dirp: bigint, count: bigint): bigint {
    // Return 0 = empty directory (end of entries)
    return 0n;
  }

  private sysReadlinkat(dirfd: bigint, pathAddr: bigint, buf: bigint, bufsiz: bigint): bigint {
    const path = this.mem.readString(pathAddr);
    if (path === '/proc/self/exe') {
      const exe = '/usr/bin/program';
      const encoded = new TextEncoder().encode(exe);
      const len = Math.min(encoded.length, Number(bufsiz));
      this.mem.writeBytes(buf, encoded.subarray(0, len));
      return BigInt(len);
    }
    return -BigInt(ENOENT);
  }

  private sysArchPrctl(code: bigint, addr: bigint): bigint {
    const ARCH_SET_FS = 0x1002;
    const ARCH_GET_FS = 0x1003;
    const ARCH_SET_GS = 0x1001;
    const ARCH_GET_GS = 0x1004;

    switch (Number(code)) {
      case ARCH_SET_FS: this.cpu.fsBase = addr; return 0n;
      case ARCH_GET_FS: this.mem.write64(addr, this.cpu.fsBase); return 0n;
      case ARCH_SET_GS: this.cpu.gsBase = addr; return 0n;
      case ARCH_GET_GS: this.mem.write64(addr, this.cpu.gsBase); return 0n;
    }
    return -BigInt(ENOSYS);
  }

  private sysClockGettime(clockId: bigint, tp: bigint): bigint {
    const now = performance.now();
    const sec = BigInt(Math.floor(now / 1000));
    const nsec = BigInt(Math.floor((now % 1000) * 1_000_000));
    this.mem.write64(tp, sec);
    this.mem.write64(tp + 8n, nsec);
    return 0n;
  }

  // ─── Sockets (kernel sockets from src/kernel/net.ts) ──────────────────────

  private allocSock(sock: KSocket | KDatagramSocket): bigint {
    const fd = this.nextFd++;
    this.fdTable.set(fd, { path: `socket:[${sock.ino}]`, offset: 0, content: null, flags: 2, sock: retain(sock) as typeof sock });
    return BigInt(fd);
  }

  /** The kernel OpenFile behind an fd, if any (sockets, epoll). Each fd entry holds one reference. */
  private kfile(entry: FDEntry | undefined): OpenFile | undefined {
    return entry?.sock ?? entry?.epoll;
  }

  private sockEntry(fdNum: bigint): FDEntry | bigint {
    const entry = this.fdTable.get(Number(fdNum));
    if (!entry) return -BigInt(EBADF);
    if (!entry.sock && !entry.legacyHttp) return -BigInt(ENOTSOCK);
    return entry;
  }

  /** Drop an fd's reference to its socket/epoll; the last one closes it. */
  private releaseSock(entry: FDEntry | undefined): void {
    const f = this.kfile(entry);
    if (f) void release(f);
  }

  private readSockaddr(addr: bigint, len: bigint): SockAddr | bigint {
    if (addr === 0n) return -BigInt(EFAULT);
    const sa = decodeSockaddr(this.mem.readBytes(addr, Math.min(Number(len), 128)));
    return typeof sa === 'number' ? BigInt(sa) : sa;
  }

  private writeSockaddr(sa: SockAddr, addr: bigint, lenPtr: bigint): void {
    if (addr === 0n || lenPtr === 0n) return;
    const bytes = sa.family === AF_UNIX ? new Uint8Array([AF_UNIX, 0]) : encodeSockaddr(sa);
    const cap = this.mem.read32(lenPtr);
    this.mem.writeBytes(addr, bytes.subarray(0, Math.min(cap, bytes.length)));
    this.mem.write32(lenPtr, bytes.length);
  }

  private sysSocket(domain: bigint, type: bigint, protocol: bigint): bigint {
    const sock = this.net.socket(Number(domain), Number(type), Number(protocol));
    if (typeof sock === 'number') return BigInt(sock);
    return this.allocSock(sock);
  }

  private async sysConnect(fdNum: bigint, addrPtr: bigint, addrLen: bigint): Promise<bigint> {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    const sa = this.readSockaddr(addrPtr, addrLen);
    if (typeof sa === 'bigint') return sa;
    const sock = entry.sock!;
    if (sock instanceof KDatagramSocket) return BigInt(sock.connect(sa));
    const r = await sock.connect(sa);
    if (r === -ENETUNREACH && !this.net.config.relayUrl && sa.port === 80) {
      entry.legacyHttp = { targetHost: sa.address, targetPort: 80, writeBuffer: [], readBuffer: new Uint8Array(0), readOffset: 0 };
      return 0n;
    }
    return BigInt(r);
  }

  private async sysAccept(fdNum: bigint, addrPtr: bigint, lenPtr: bigint, flags: bigint): Promise<bigint> {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    if (!(entry.sock instanceof KSocket)) return -BigInt(EOPNOTSUPP);
    const conn = await entry.sock.accept(Number(flags));
    if (typeof conn === 'number') return BigInt(conn);
    const fd = this.allocSock(conn);
    const peer = conn.getpeername();
    if (typeof peer !== 'number') this.writeSockaddr(peer, addrPtr, lenPtr);
    return fd;
  }

  /** send/sendto/sendmsg/write on a socket fd. */
  private async sockSend(entry: FDEntry, data: Uint8Array, flags: number, to: SockAddr | null): Promise<bigint> {
    if (entry.legacyHttp) {
      entry.legacyHttp.writeBuffer.push(data.slice());
      return BigInt(data.length);
    }
    const sock = entry.sock!;
    if (sock instanceof KDatagramSocket) return BigInt(await sock.sendto(data, flags, to));
    return BigInt(await sock.send(data, flags));
  }

  /** recv/recvfrom/recvmsg/read on a socket fd. */
  private async sockRecv(entry: FDEntry, len: number, flags: number): Promise<{ data: Uint8Array; from: SockAddr | null } | bigint> {
    if (entry.legacyHttp) {
      const n = await this.legacyRecv(entry.legacyHttp, len);
      return typeof n === 'bigint' ? n : { data: n, from: null };
    }
    const sock = entry.sock!;
    const buf = new Uint8Array(len);
    if (sock instanceof KDatagramSocket) {
      const r = await sock.recvfrom(buf, flags);
      return typeof r === 'number' ? BigInt(r) : { data: buf.subarray(0, r.n), from: r.from };
    }
    const n = await sock.recv(buf, flags);
    if (n < 0) return BigInt(n);
    const peer = sock.getpeername();
    return { data: buf.subarray(0, n), from: typeof peer === 'number' ? null : peer };
  }

  private async sysSendto(fdNum: bigint, buf: bigint, len: bigint, flags: bigint, destAddr: bigint, addrLen: bigint): Promise<bigint> {
    const entry = this.fdTable.get(Number(fdNum));
    if (!entry) return -BigInt(EBADF);
    if (!entry.sock && !entry.legacyHttp) return this.sysWrite(fdNum, buf, len);
    let to: SockAddr | null = null;
    if (destAddr !== 0n && entry.sock instanceof KDatagramSocket) {
      const sa = this.readSockaddr(destAddr, addrLen);
      if (typeof sa === 'bigint') return sa;
      to = sa;
    }
    return this.sockSend(entry, this.mem.readBytes(buf, Number(len)), Number(flags), to);
  }

  private async sysRecvfrom(fdNum: bigint, buf: bigint, len: bigint, flags: bigint, srcAddr: bigint, addrLen: bigint): Promise<bigint> {
    const entry = this.fdTable.get(Number(fdNum));
    if (!entry) return -BigInt(EBADF);
    if (!entry.sock && !entry.legacyHttp) return this.sysRead(fdNum, buf, len);
    const r = await this.sockRecv(entry, Number(len), Number(flags));
    if (typeof r === 'bigint') return r;
    this.mem.writeBytes(buf, r.data);
    if (r.from) this.writeSockaddr(r.from, srcAddr, addrLen);
    return BigInt(r.data.length);
  }

  // struct msghdr: name(0) namelen(8) iov(16) iovlen(24) control(32) controllen(40) flags(48)
  private iovecs(msg: bigint): { addr: bigint; len: number }[] {
    const iov = this.mem.read64(msg + 16n);
    const cnt = Math.min(Number(this.mem.read64(msg + 24n)), 1024);
    const out: { addr: bigint; len: number }[] = [];
    for (let i = 0; i < cnt; i++) {
      const base = iov + BigInt(i * 16);
      out.push({ addr: this.mem.read64(base), len: Number(this.mem.read64(base + 8n)) });
    }
    return out;
  }

  private async sysSendmsg(fdNum: bigint, msg: bigint, flags: bigint): Promise<bigint> {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    const parts = this.iovecs(msg).map((v) => this.mem.readBytes(v.addr, v.len));
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { data.set(p, off); off += p.length; }
    let to: SockAddr | null = null;
    const name = this.mem.read64(msg);
    if (name !== 0n && entry.sock instanceof KDatagramSocket) {
      const sa = this.readSockaddr(name, BigInt(this.mem.read32(msg + 8n)));
      if (typeof sa === 'bigint') return sa;
      to = sa;
    }
    return this.sockSend(entry, data, Number(flags), to);
  }

  private async sysRecvmsg(fdNum: bigint, msg: bigint, flags: bigint): Promise<bigint> {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    const iov = this.iovecs(msg);
    const r = await this.sockRecv(entry, iov.reduce((n, v) => n + v.len, 0), Number(flags));
    if (typeof r === 'bigint') return r;
    let off = 0;
    for (const v of iov) {
      if (off >= r.data.length) break;
      const k = Math.min(v.len, r.data.length - off);
      this.mem.writeBytes(v.addr, r.data.subarray(off, off + k));
      off += k;
    }
    const name = this.mem.read64(msg);
    if (name !== 0n && r.from) this.writeSockaddr(r.from, name, msg + 8n);
    else this.mem.write32(msg + 8n, 0);
    this.mem.write64(msg + 40n, 0n); // no ancillary data
    this.mem.write32(msg + 48n, 0);
    return BigInt(r.data.length);
  }

  private sysShutdown(fdNum: bigint, how: bigint): bigint {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    return entry.sock ? BigInt(entry.sock.shutdown(Number(how))) : 0n;
  }

  private sysBind(fdNum: bigint, addrPtr: bigint, addrLen: bigint): bigint {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    const sa = this.readSockaddr(addrPtr, addrLen);
    if (typeof sa === 'bigint') return sa;
    return BigInt(entry.sock!.bind(sa));
  }

  private sysListen(fdNum: bigint, backlog: bigint): bigint {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    if (!(entry.sock instanceof KSocket)) return -BigInt(EOPNOTSUPP);
    return BigInt(entry.sock.listen(Number(backlog)));
  }

  private sysGetsockname(fdNum: bigint, addrPtr: bigint, lenPtr: bigint): bigint {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    if (!entry.sock) return -BigInt(EOPNOTSUPP);
    this.writeSockaddr(entry.sock.getsockname(), addrPtr, lenPtr);
    return 0n;
  }

  private sysGetpeername(fdNum: bigint, addrPtr: bigint, lenPtr: bigint): bigint {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    if (!entry.sock) return -BigInt(EOPNOTSUPP);
    const peer = entry.sock.getpeername();
    if (typeof peer === 'number') return BigInt(peer);
    this.writeSockaddr(peer, addrPtr, lenPtr);
    return 0n;
  }

  private sysSocketpair(domain: bigint, type: bigint, _protocol: bigint, sv: bigint): bigint {
    if (Number(domain) !== AF_UNIX) return -BigInt(Number(domain) === 2 || Number(domain) === 10 ? EOPNOTSUPP : NET_EAFNOSUPPORT);
    const pair = this.net.socketpair(Number(type));
    if (typeof pair === 'number') return BigInt(pair);
    this.mem.write32(sv, Number(this.allocSock(pair[0])));
    this.mem.write32(sv + 4n, Number(this.allocSock(pair[1])));
    return 0n;
  }

  private isTimeoutOpt(level: number, name: number) {
    return level === SOL_SOCKET && (name === SO_RCVTIMEO || name === SO_SNDTIMEO);
  }

  private sysGetsockopt(fdNum: bigint, level: bigint, optname: bigint, optval: bigint, optlen: bigint): bigint {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    if (!entry.sock || optval === 0n || optlen === 0n) return entry.sock ? -BigInt(EFAULT) : 0n;
    const v = entry.sock.getsockopt(Number(level), Number(optname));
    if (v < 0) return BigInt(v);
    if (this.isTimeoutOpt(Number(level), Number(optname))) {
      if (this.mem.read32(optlen) < 16) return -BigInt(EINVAL);
      this.mem.write64(optval, BigInt(Math.floor(v / 1000)));
      this.mem.write64(optval + 8n, BigInt((v % 1000) * 1000));
      this.mem.write32(optlen, 16);
      return 0n;
    }
    if (this.mem.read32(optlen) < 4) return -BigInt(EINVAL);
    this.mem.write32(optval, v);
    this.mem.write32(optlen, 4);
    return 0n;
  }

  private sysSetsockopt(fdNum: bigint, level: bigint, optname: bigint, optval: bigint, optlen: bigint): bigint {
    const entry = this.sockEntry(fdNum);
    if (typeof entry === 'bigint') return entry;
    if (!entry.sock) return 0n;
    const lvl = Number(level), name = Number(optname), len = Number(optlen);
    let value = 0;
    if (optval !== 0n && this.isTimeoutOpt(lvl, name) && len >= 16) {
      value = Number(this.mem.read64(optval)) * 1000 + Math.floor(Number(this.mem.read64(optval + 8n)) / 1000);
    } else if (optval !== 0n && len >= 4) {
      value = this.mem.read32(optval) | 0; // SO_LINGER: l_onoff comes first
    } else if (optval !== 0n && len >= 1) {
      value = this.mem.read8(optval);
    }
    if (lvl === SOL_SOCKET && name === SO_LINGER) value = value ? 1 : 0;
    return BigInt(entry.sock.setsockopt(lvl, name, value));
  }

  /** poll(2). Only sets that include a socket wait; others keep the old "timed out" answer. */
  private async sysPoll(fdsPtr: bigint, nfds: number, timeoutMs: number): Promise<bigint> {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    for (;;) {
      let ready = 0;
      const socks: OpenFile[] = [];
      for (let i = 0; i < nfds; i++) {
        const p = fdsPtr + BigInt(i * 8);
        const fd = this.mem.read32(p) | 0;
        if (fd < 0) { this.mem.write16(p + 6n, 0); continue; }
        const entry = this.fdTable.get(fd);
        const kf = this.kfile(entry);
        if (kf) socks.push(kf);
        const events = this.mem.read16(p + 4n);
        const rev = !entry ? POLLNVAL
          : kf ? kf.poll(events)
          : entry.legacyHttp ? events & (POLLIN | POLLOUT)
          : 0;
        this.mem.write16(p + 6n, rev);
        if (rev) ready++;
      }
      if (ready || timeoutMs === 0 || !socks.length) return BigInt(ready);
      const left = deadline ? deadline - Date.now() : -1;
      if (deadline && left <= 0) return 0n;
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const offs: (() => void)[] = [];
        const done = () => { offs.forEach((off) => off()); if (timer) clearTimeout(timer); resolve(); };
        for (const s of socks) offs.push(s.onReady(done));
        if (left > 0) timer = setTimeout(done, left);
      });
    }
  }

  private async sysPpoll(fdsPtr: bigint, nfds: bigint, tsp: bigint): Promise<bigint> {
    const timeout = tsp === 0n ? -1
      : Number(this.mem.read64(tsp)) * 1000 + Math.ceil(Number(this.mem.read64(tsp + 8n)) / 1e6);
    return this.sysPoll(fdsPtr, Number(nfds), timeout);
  }

  // ─── epoll (src/kernel/epoll.ts) over socket and epoll fds ────────────────

  private sysEpollCreate(flags: bigint): bigint {
    if (flags !== 0n && flags !== 0o2000000n) return -BigInt(EINVAL); // only EPOLL_CLOEXEC
    const ep = retain(new EpollFile()) as EpollFile;
    const fd = this.nextFd++;
    this.fdTable.set(fd, { path: 'anon_inode:[eventpoll]', offset: 0, content: null, flags: 2, epoll: ep });
    return BigInt(fd);
  }

  // struct epoll_event is packed on x86-64: u32 events, u64 data (12 bytes)
  private sysEpollCtl(epfd: bigint, op: bigint, fdNum: bigint, event: bigint): bigint {
    const ep = this.fdTable.get(Number(epfd))?.epoll;
    if (!this.fdTable.has(Number(epfd))) return -BigInt(EBADF);
    if (!ep) return -BigInt(EINVAL);
    const entry = this.fdTable.get(Number(fdNum));
    if (!entry) return -BigInt(EBADF);
    const file = this.kfile(entry);
    if (!file) return -BigInt(EPERM); // emulator-local files and pipes aren't pollable kernel files
    const o = Number(op);
    if (o !== 2 && event === 0n) return -BigInt(EFAULT); // EPOLL_CTL_DEL may pass NULL
    const events = event === 0n ? 0 : this.mem.read32(event);
    const lo = event === 0n ? 0 : this.mem.read32(event + 4n);
    const hi = event === 0n ? 0 : this.mem.read32(event + 8n);
    return BigInt(ep.ctl(o, Number(fdNum), file, events, lo, hi));
  }

  private async sysEpollWait(epfd: bigint, events: bigint, maxevents: bigint, timeout: bigint): Promise<bigint> {
    const entry = this.fdTable.get(Number(epfd));
    if (!entry) return -BigInt(EBADF);
    if (!entry.epoll) return -BigInt(EINVAL);
    const max = Number(BigInt.asIntN(32, maxevents));
    if (max <= 0) return -BigInt(EINVAL);
    const out = new Uint8Array(Math.min(max, 1024) * 12);
    const n = await entry.epoll.wait(out, max, Number(BigInt.asIntN(32, timeout)));
    if (n > 0) this.mem.writeBytes(events, out.subarray(0, n * 12));
    return BigInt(n);
  }

  /** The pre-relay behavior: buffer an HTTP request, answer it with fetch(). */
  private async legacyRecv(sock: LegacyHttp, len: number): Promise<Uint8Array | bigint> {
    if (sock.readOffset >= sock.readBuffer.length && sock.writeBuffer.length > 0) {
      try {
        sock.readBuffer = await this.fetchFromSocket(sock);
        sock.readOffset = 0;
        sock.writeBuffer = [];
      } catch {
        return -BigInt(ECONNREFUSED);
      }
    }
    const n = Math.min(len, sock.readBuffer.length - sock.readOffset);
    const out = sock.readBuffer.slice(sock.readOffset, sock.readOffset + Math.max(0, n));
    sock.readOffset += out.length;
    return out;
  }

  /** Attempt to perform an HTTP fetch based on buffered socket writes */
  private async fetchFromSocket(sock: LegacyHttp): Promise<Uint8Array> {
    // Concatenate write buffers to get the raw HTTP request
    const totalLen = sock.writeBuffer.reduce((s, b) => s + b.length, 0);
    const rawRequest = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of sock.writeBuffer) {
      rawRequest.set(buf, offset);
      offset += buf.length;
    }
    const requestText = new TextDecoder().decode(rawRequest);

    // Parse HTTP request line
    const firstLine = requestText.split('\r\n')[0] || requestText.split('\n')[0];
    const parts = firstLine.split(' ');
    const method = parts[0] || 'GET';
    const path = parts[1] || '/';

    // Extract Host header
    const hostMatch = requestText.match(/Host:\s*([^\r\n]+)/i);
    const host = hostMatch ? hostMatch[1].trim() : sock.targetHost;

    const protocol = sock.targetPort === 443 ? 'https' : 'http';
    const url = `${protocol}://${host}${path}`;

    // Use fetch() to make the actual HTTP request
    const response = await fetch(url, {
      method,
      headers: { 'User-Agent': 'Shiro-x86/1.0' },
    });

    // Build HTTP response
    const body = await response.arrayBuffer();
    const bodyBytes = new Uint8Array(body);
    const statusLine = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
    const headers: string[] = [];
    response.headers.forEach((value, key) => {
      headers.push(`${key}: ${value}`);
    });
    headers.push(`Content-Length: ${bodyBytes.length}`);
    const headerText = statusLine + headers.join('\r\n') + '\r\n\r\n';
    const headerBytes = new TextEncoder().encode(headerText);

    const result = new Uint8Array(headerBytes.length + bodyBytes.length);
    result.set(headerBytes);
    result.set(bodyBytes, headerBytes.length);
    return result;
  }
}
