/**
 * Linux x86-64 Syscall Emulation.
 * Maps Linux syscalls to Shiro VFS and I/O operations.
 */

import { CPU, RAX, RDI, RSI, RDX, R8, R10 } from './cpu';
import { VirtualMemory } from './memory';
import type { FileSystem } from '../filesystem';

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

// File descriptor table entry
interface FDEntry {
  path: string;
  offset: number;
  content: Uint8Array | null;  // null = stdin/stdout/stderr
  flags: number;
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
  private nextFd = 3;
  private brkAddr: bigint;
  private startTime: number;

  // I/O callbacks
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  stdinBuffer: string;

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
      case 16:  result = this.sysIoctl(arg0, arg1, arg2); break;
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
      case 13:  result = 0n; break; // rt_sigaction — stub
      case 14:  result = 0n; break; // rt_sigprocmask — stub
      case 20:  result = this.sysWritev(arg0, arg1, arg2); break;
      case 72:  result = this.sysFcntl(arg0, arg1, arg2); break;
      case 89:  result = this.sysReadlink(arg0, arg1, arg2); break;
      case 158: result = this.sysArchPrctl(arg0, arg1); break;
      case 218: result = 1000n; break; // set_tid_address — return fake TID
      case 271: result = 0n; break; // ppoll — stub (return timeout)
      case 302: result = this.sysPrlimit64(arg0, arg1, arg2, arg3); break;
      case 318: result = this.sysGetrandom(arg0, arg1, arg2); break;
      case 7:   result = 0n; break; // poll — stub
      case 17:  result = await this.sysPread64(arg0, arg1, arg2, arg3); break;
      case 18:  result = await this.sysPwrite64(arg0, arg1, arg2, arg3); break;
      case 19:  result = this.sysReadv(arg0, arg1, arg2); break;
      case 28:  result = 0n; break; // madvise — no-op
      case 35:  result = this.sysNanosleep(arg0, arg1); break;
      case 41:  result = -BigInt(ENOSYS); break; // socket — not supported
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
      case 233: result = -BigInt(ENOSYS); break; // epoll_ctl
      case 234: result = -BigInt(ENOSYS); break; // tgkill
      case 267: result = this.sysReadlinkat(arg0, arg1, arg2, arg3); break;
      case 273: result = 0n; break; // set_robust_list — stub
      case 291: result = -BigInt(ENOSYS); break; // epoll_create1
      case 293: result = -BigInt(ENOSYS); break; // pipe2 — not supported
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

    if (fd === 0) {
      // Read from stdin
      const data = this.stdinBuffer.slice(0, n);
      this.stdinBuffer = this.stdinBuffer.slice(n);
      const encoded = new TextEncoder().encode(data);
      this.mem.writeBytes(buf, encoded);
      return BigInt(encoded.length);
    }

    const entry = this.fdTable.get(fd);
    if (!entry || !entry.content) return -BigInt(EBADF);

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
    this.fdTable.delete(fd);
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

  private sysIoctl(fdNum: bigint, request: bigint, arg: bigint): bigint {
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
    return BigInt(newFd);
  }

  private sysDup2(oldFd: bigint, newFd: bigint): bigint {
    const entry = this.fdTable.get(Number(oldFd));
    if (!entry) return -BigInt(EBADF);
    const nfd = Number(newFd);
    this.fdTable.set(nfd, { ...entry });
    return BigInt(nfd);
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

  private sysWritev(fdNum: bigint, iovAddr: bigint, iovcnt: bigint): bigint {
    const fd = Number(fdNum);
    const cnt = Number(iovcnt);
    let totalWritten = 0;

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
      return BigInt(entry ? entry.flags : 0);
    }
    if (c === 4) return 0n; // F_SETFL → ok
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

  private sysReadv(fdNum: bigint, iovAddr: bigint, iovcnt: bigint): bigint {
    const fd = Number(fdNum);
    const cnt = Number(iovcnt);
    let totalRead = 0;

    for (let i = 0; i < cnt; i++) {
      const base = iovAddr + BigInt(i * 16);
      const bufAddr = this.mem.read64(base);
      const bufLen = Number(this.mem.read64(base + 8n));
      if (bufLen === 0) continue;

      if (fd === 0) {
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
}
