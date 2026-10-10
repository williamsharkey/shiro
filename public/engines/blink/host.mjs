// Shiro host for the Blink x86-64 engine (blink.mjs/blink.wasm, built by
// vendor/blink/build.sh). Runs inside a Worker (browser) or worker_thread
// (Node/vitest); the page side is src/x86-engine/blink.ts.
//
// One worker runs one guest process, as a kernel process (src/kernel): the
// page starts it with the kernel's start message
//   { type: 'shiro-start', sab, pid, argv, env, cwd, path, moduleUrl, mounts, pool }
//
// - The guest's fd, filesystem and process syscalls go straight to the
//   kernel (Blink patch 0011, vendor/blink/shiro-kernel.js): guest fd N is
//   kernel fd N, so files, pipes, the terminal (/dev/tty, /dev/ptmx),
//   sockets, fork/exec/wait and job control are the same as for every other
//   Shiro process. Guest threads' calls arrive here as proxied calls and run
//   on `pool`, a set of kernel channels the page serves on request
//   ('blink-sys' → 'blink-done'), so a call blocked on one channel (a read
//   from the tty) doesn't hold up the others.
// - `sab` is this worker's own channel, used synchronously for what the
//   engine itself needs: every top-level Shiro directory in `mounts` is
//   mounted as SHIROFS, a MEMFS faulted in through kernel syscalls, from
//   which Blink loads programs and their ELF interpreters.
// - Signals the kernel hands to the guest (a reply's signal word) are queued
//   in Blink, which runs the guest's handler; then rt_sigreturn.
// - The guest's exit status goes to the kernel as exit_group.

const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof self === 'undefined';
let port;
if (isNode) {
  const wt = await import('node:worker_threads');
  port = wt.parentPort;
} else {
  port = self;
}
const post = (msg) => port.postMessage(msg);
const onMessage = (fn) => (isNode ? port.on('message', fn) : port.addEventListener('message', (e) => fn(e.data)));

// ── Kernel channel (docs/KERNEL_ABI.md; constants from src/kernel/abi.ts) ──
const CH_STATE = 0, CH_SYSNO = 1, CH_RESULT = 2, CH_SIGNAL = 3, CH_ARGS = 4, CH_NARGS = 12, CH_DATA = 64;
const SYS = {
  read: 0, write: 1, close: 3, lstat: 6, pread64: 17, poll: 7, rt_sigaction: 13, rt_sigreturn: 15, ioctl: 16, getpid: 39, kill: 62, rename: 82, mkdir: 83, rmdir: 84,
  unlink: 87, readlink: 89, getdents64: 217, exit_group: 231, openat: 257,
};
// Negative Linux errno → emscripten's (WASI) errno numbering.
const LINUX_TO_WASI = {
  1: 63, 2: 44, 4: 27, 5: 29, 9: 8, 11: 6, 12: 48, 13: 2, 14: 21, 17: 20, 20: 54, 21: 31, 22: 28, 24: 33,
  25: 59, 28: 51, 30: 69, 32: 64, 36: 37, 38: 52, 39: 55, 40: 32, 88: 57, 89: 17, 90: 35, 91: 67, 92: 50,
  93: 66, 95: 138, 97: 5, 98: 3, 99: 4, 100: 38, 101: 40, 103: 13, 104: 15, 105: 42, 106: 30, 107: 53,
  110: 73, 111: 14, 113: 23, 114: 7, 115: 26,
};
const wasiErrno = (res) => LINUX_TO_WASI[-res] || 29;
// Signals the kernel forwards into the guest; SIGPIPE stays the guest's business.
const FORWARDED_SIGNALS = [1, 2, 3, 10, 12, 15, 28]; // HUP INT QUIT USR1 USR2 TERM WINCH
const SIGPIPE = 13, SIG_IGN = 1, FORWARD_HANDLER = 0x5348; // any value but SIG_DFL/SIG_IGN
const TCGETS = 0x5401, TIOCGWINSZ = 0x5413;
const O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 0o100, O_TRUNC = 0o1000, O_DIRECTORY = 0o200000, AT_FDCWD = -100;
const POLLIN = 1, POLLOUT = 4;
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
const MAP_SHARED = 1, PROT_WRITE = 2;
/** Files at least this big are read and mapped through pread, not loaded whole (see SHIROFS). */
const DIRECT_MIN = 1 << 20;

let i32 = null, data = null, debug = false, debugPid = 0, progPath = '';
// The kernel watches the channel's state word (Atomics.waitAsync): no message per call
let atomicsWake = false;
const enc = new TextEncoder();
const dec = new TextDecoder();

function sys(nr, ...args) {
  for (let i = 0; i < CH_NARGS; i++) i32[CH_ARGS + i] = args[i] ?? 0;
  i32[CH_SYSNO] = nr;
  Atomics.store(i32, CH_STATE, 1);
  Atomics.notify(i32, CH_STATE);
  if (!atomicsWake) post('sys');
  while (Atomics.load(i32, CH_STATE) === 1) Atomics.wait(i32, CH_STATE, 1);
  const r = i32[CH_RESULT];
  Atomics.store(i32, CH_STATE, 0);
  const sig = Atomics.exchange(i32, CH_SIGNAL, 0);
  if (debug) console.error(`[blink] sys ${nr}(${args.join(', ')}) = ${r}` + (args.length && nr !== 0 && nr !== 1 ? ` ${JSON.stringify(dec.decode(data.slice(0, Math.min(args[nr === 257 ? 1 : 0] > 0 ? args[nr === 257 ? 1 : 0] : 0, 200))))}` : ''));
  if (sig) takeSignal(sig);
  return r;
}
// A caught signal the kernel handed over in a reply's signal word: queue it
// in the guest (Blink runs the guest's handler or default action), then
// rt_sigreturn so the kernel unblocks it again.
// (One that arrives before the guest is loaded is dropped.)
let blinkModule = null;
function takeSignal(sig) {
  if (debug) console.error('[blink] signal', sig);
  blinkModule?._blink_shiro_signal?.(sig);
  sys(SYS.rt_sigreturn);
}

function putStr(s, off = 0) {
  const b = enc.encode(s);
  if (off + b.length > data.length) return -36; // ENAMETOOLONG
  data.set(b, off);
  return b.length;
}
const pathCall = (nr, path, ...rest) => {
  const len = putStr(path);
  return len < 0 ? len : sys(nr, len, ...rest);
};
const openPath = (path, flags, mode = 0) => {
  const len = putStr(path);
  return len < 0 ? len : sys(SYS.openat, AT_FDCWD, len, flags, mode);
};
function pollFd(fd, events, timeoutMs = 0) {
  const dv = new DataView(data.buffer, data.byteOffset, 8);
  dv.setInt32(0, fd, true);
  dv.setInt16(4, events, true);
  dv.setInt16(6, 0, true);
  const r = sys(SYS.poll, 1, timeoutMs);
  return r > 0 ? dv.getInt16(6, true) : 0;
}
function lstat(path) {
  const r = pathCall(SYS.lstat, path);
  if (r < 0) return r;
  const dv = new DataView(data.buffer, data.byteOffset, 144);
  const u64 = (o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;
  return { mode: dv.getUint32(24, true), size: u64(48), mtimeMs: u64(88) * 1000 + Math.floor(u64(96) / 1e6) };
}
function readlink(path) {
  const r = pathCall(SYS.readlink, path, data.length);
  return r < 0 ? r : dec.decode(data.slice(0, r)); // browsers can't decode SAB views
}
function readDir(path) {
  const fd = openPath(path, O_RDONLY | O_DIRECTORY);
  if (fd < 0) return fd;
  const names = [];
  try {
    for (;;) {
      const n = sys(SYS.getdents64, fd, data.length);
      if (n < 0) return n;
      if (n === 0) break;
      const dv = new DataView(data.buffer, data.byteOffset, n);
      for (let off = 0; off < n;) {
        const reclen = dv.getUint16(off + 16, true);
        let end = off + 19;
        while (end < off + reclen && data[end]) end++;
        const name = dec.decode(data.slice(off + 19, end));
        if (name !== '.' && name !== '..') names.push(name);
        off += reclen;
      }
    }
  } finally {
    sys(SYS.close, fd);
  }
  return names;
}
function readWhole(path, sizeHint = -1) {
  const fd = openPath(path, O_RDONLY);
  if (fd < 0) return fd;
  // Into one buffer of the expected size (a 60 MB binary used to sit in 1 MiB
  // chunks and again in the joined copy); grows only if the file did
  let buf = new Uint8Array(sizeHint > 0 ? sizeHint : 65536);
  let total = 0;
  try {
    for (;;) {
      const n = sys(SYS.read, fd, data.length);
      if (n < 0) return n;
      if (n === 0) break;
      if (total + n > buf.length) {
        const next = new Uint8Array(Math.max(total + n, buf.length * 2));
        next.set(buf.subarray(0, total));
        buf = next;
      }
      buf.set(data.subarray(0, n), total);
      total += n;
    }
  } finally {
    sys(SYS.close, fd);
  }
  return total === buf.length ? buf : buf.slice(0, total);
}
function writeFd(fd, bytes) {
  let off = 0;
  while (off < bytes.length) {
    const part = bytes.subarray(off, off + data.length);
    data.set(part);
    const n = sys(SYS.write, fd, part.length);
    if (n < 0) return n;
    off += n;
  }
  return bytes.length;
}
function writeWhole(path, bytes, mode) {
  const fd = openPath(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
  if (fd < 0) return fd;
  try {
    const r = writeFd(fd, bytes);
    return r < 0 ? r : 0;
  } finally {
    sys(SYS.close, fd);
  }
}

// ── SHIROFS: MEMFS nodes faulted in from the kernel ─────────────────────────
function makeShiroFS(FS, M) {
  const MEMFS = FS.filesystems.MEMFS;
  const err = (res) => new FS.ErrnoError(wasiErrno(res));
  const check = (res) => { if (typeof res === 'number' && res < 0) throw err(res); return res; };
  const isOurs = (node) => node && node.mount && node.mount.type === SHIROFS;
  const pathOf = (node) => FS.getPath(node);
  const joinPath = (dir, name) => (dir === '/' ? '/' + name : dir + '/' + name);

  function ensureLoaded(node) {
    if (!node.shiroLazy) return;
    const buf = check(readWhole(pathOf(node), node.shiroSize ?? -1));
    node.contents = buf;
    node.usedBytes = buf.length;
    node.shiroLazy = false;
  }
  function writeBack(node) {
    if (!node.shiroDirty || node.shiroLazy) return;
    const bytes = node.contents ? node.contents.subarray(0, node.usedBytes) : new Uint8Array(0);
    check(writeWhole(pathOf(node), bytes, node.mode & 0o7777));
    node.shiroDirty = false;
  }
  function makeNode(parent, name, path, st) {
    const type = st.mode & S_IFMT;
    let node;
    if (type === S_IFDIR) {
      node = MEMFS.createNode(parent, name, S_IFDIR | (st.mode & 0o7777 || 0o755), 0);
    } else if (type === S_IFLNK) {
      node = MEMFS.createNode(parent, name, S_IFLNK | 0o777, 0);
      const target = readlink(path);
      node.link = typeof target === 'string' ? target : '';
    } else {
      // Shiro doesn't enforce the x bit, but Blink won't start a program
      // without it: the binary being run is always executable here.
      const perm = (st.mode & 0o7777 || 0o644) | (path === progPath ? 0o111 : 0);
      node = MEMFS.createNode(parent, name, S_IFREG | perm, 0);
      node.shiroLazy = true;
      node.shiroSize = st.size;
    }
    if (st.mtimeMs) node.mtime = node.ctime = node.atime = st.mtimeMs;
    return node;
  }

  const base = { dir: MEMFS.ops_table.dir, file: MEMFS.ops_table.file };

  const dirNodeOps = {
    ...base.dir.node,
    lookup(parent, name) {
      if (parent.shiroListed && !parent.shiroListed.has(name)) throw new FS.ErrnoError(44);
      const path = joinPath(pathOf(parent), name);
      const st = check(lstat(path));
      return makeNode(parent, name, path, st);
    },
    readdir(node) {
      if (!node.shiroListed) node.shiroListed = new Set(check(readDir(pathOf(node))));
      const names = new Set(node.shiroListed);
      for (const k of Object.keys(node.contents || {})) names.add(k);
      return ['.', '..', ...names];
    },
    mknod(parent, name, mode, dev) {
      const path = joinPath(pathOf(parent), name);
      if (FS.isDir(mode)) check(pathCall(SYS.mkdir, path, mode & 0o7777));
      else check(writeWhole(path, new Uint8Array(0), mode & 0o7777));
      parent.shiroListed?.add(name);
      return base.dir.node.mknod(parent, name, mode, dev);
    },
    symlink() {
      throw new FS.ErrnoError(63); // EPERM: the kernel ABI has no symlink(2) yet
    },
    rename(oldNode, newDir, newName) {
      if (oldNode.shiroDirty) writeBack(oldNode);
      const a = putStr(pathOf(oldNode));
      const b = a < 0 ? a : putStr(joinPath(pathOf(newDir), newName), a);
      check(a < 0 || b < 0 ? -36 : sys(SYS.rename, a, b));
      oldNode.parent.shiroListed?.delete(oldNode.name);
      newDir.shiroListed?.add(newName);
      return base.dir.node.rename(oldNode, newDir, newName);
    },
    unlink(parent, name) {
      check(pathCall(SYS.unlink, joinPath(pathOf(parent), name)));
      parent.shiroListed?.delete(name);
      return base.dir.node.unlink(parent, name);
    },
    rmdir(parent, name) {
      check(pathCall(SYS.rmdir, joinPath(pathOf(parent), name)));
      parent.shiroListed?.delete(name);
      return base.dir.node.rmdir(parent, name);
    },
  };

  const fileNodeOps = {
    ...base.file.node,
    getattr(node) {
      const a = base.file.node.getattr(node);
      if (node.shiroLazy) { a.size = node.shiroSize; a.blocks = Math.ceil(a.size / 4096); }
      return a;
    },
    setattr(node, attr) {
      if (attr.size === 0 && node.shiroLazy) { node.shiroLazy = false; node.contents = null; node.usedBytes = 0; }
      if (attr.size !== undefined) { ensureLoaded(node); node.shiroDirty = true; }
      base.file.node.setattr(node, attr);
      if (attr.size !== undefined) writeBack(node);
    },
  };

  // A file is loaded whole (into node.contents) only when a program reads
  // through it or writes it. Reads that peek (an ELF header, a section) and
  // mappings go to the kernel with pread: Blink running a 50 MB binary used to
  // hold it twice, once in JS and once copied into wasm memory.
  const kfds = new WeakMap(); // stream → kernel fd for its pread calls
  function kfdOf(stream) {
    let fd = kfds.get(stream);
    if (fd === undefined) {
      fd = check(openPath(pathOf(stream.node), O_RDONLY));
      kfds.set(stream, fd);
    }
    return fd;
  }
  function dropKfd(stream) {
    const fd = kfds.get(stream);
    if (fd === undefined) return;
    kfds.delete(stream);
    sys(SYS.close, fd);
  }
  /** pread [position, position + length) of a lazy file into `dest` at `at`; the bytes read. */
  function preadInto(stream, dest, at, length, position) {
    const fd = kfdOf(stream);
    let done = 0;
    while (done < length) {
      const off = position + done;
      const n = check(sys(SYS.pread64, fd, Math.min(length - done, data.length), off % 0x100000000, Math.floor(off / 0x100000000)));
      if (n === 0) break;
      // dest may be a view of wasm memory that grew: take it fresh each time
      (typeof dest === 'function' ? dest() : dest).set(data.subarray(0, n), at + done);
      done += n;
    }
    return done;
  }

  const fileStreamOps = {
    ...base.file.stream,
    write(stream, buffer, offset, length, position) {
      ensureLoaded(stream.node);
      stream.node.shiroDirty = true;
      return base.file.stream.write(stream, buffer, offset, length, position, false);
    },
    llseek(stream, offset, whence) {
      const node = stream.node;
      if (whence === 2 && node.shiroLazy) { // SEEK_END: MEMFS would read usedBytes
        const pos = node.shiroSize + offset;
        if (pos < 0) throw new FS.ErrnoError(28);
        return pos;
      }
      return base.file.stream.llseek(stream, offset, whence);
    },
    read(stream, buffer, offset, length, position) {
      const node = stream.node;
      if (node.shiroLazy && node.shiroSize >= DIRECT_MIN) {
        const n = preadInto(stream, buffer, offset, Math.max(0, Math.min(length, node.shiroSize - position)), position);
        // A program reading through the file gets it loaded (one syscall per read is the slow way)
        stream.shiroRead = (stream.shiroRead || 0) + n;
        if (stream.shiroRead >= DIRECT_MIN) { dropKfd(stream); ensureLoaded(node); }
        return n;
      }
      ensureLoaded(node);
      return base.file.stream.read(stream, buffer, offset, length, position);
    },
    mmap(stream, length, position, prot, flags) {
      const node = stream.node;
      const sharedWrite = (flags & MAP_SHARED) && (prot & PROT_WRITE);
      if (node.shiroLazy && !sharedWrite && node.shiroSize >= DIRECT_MIN) {
        // A fresh (zeroed) block from MEMFS, filled straight from the kernel
        node.contents = new Uint8Array(0);
        let r;
        try { r = base.file.stream.mmap(stream, length, position, prot, flags); } finally { node.contents = null; }
        preadInto(stream, () => M.HEAPU8, r.ptr, Math.max(0, Math.min(length, node.shiroSize - position)), position);
        return r;
      }
      ensureLoaded(node);
      const r = base.file.stream.mmap(stream, length, position, prot, flags);
      // MEMFS copied the bytes into wasm memory: a big clean file's JS copy is
      // now a duplicate, so let it go; a later read or mapping goes to the
      // kernel again. Shared writable mappings keep it (msync).
      if (r.allocated && !sharedWrite && !node.shiroDirty && node.usedBytes >= DIRECT_MIN) {
        node.shiroSize = node.usedBytes;
        node.contents = null;
        node.usedBytes = 0;
        node.shiroLazy = true;
      }
      return r;
    },
    msync(stream, buffer, offset, length, mmapFlags) {
      ensureLoaded(stream.node);
      stream.node.shiroDirty = true;
      return base.file.stream.msync(stream, buffer, offset, length, mmapFlags);
    },
    close(stream) { dropKfd(stream); writeBack(stream.node); },
    fsync(stream) { writeBack(stream.node); return 0; },
  };

  function patch(node) {
    if (FS.isDir(node.mode)) node.node_ops = dirNodeOps;
    else if (FS.isFile(node.mode)) { node.node_ops = fileNodeOps; node.stream_ops = fileStreamOps; }
    return node;
  }

  const origCreate = MEMFS.createNode;
  MEMFS.createNode = (parent, name, mode, dev) => {
    const node = origCreate(parent, name, mode, dev);
    return isOurs(parent) ? patch(node) : node;
  };

  const SHIROFS = {
    mount() { return patch(origCreate(null, '/', S_IFDIR | 0o755, 0)); },
  };
  return SHIROFS;
}

// ── fds 0/1/2: the kernel process's own fds ────────────────────────────────
// Kernel fd → FS node, for the page's readiness pings (stdio and sockets).
const watched = new Map();

function termiosFromKernel(b) {
  const dv = new DataView(b.buffer, b.byteOffset, 36);
  const c_cc = [];
  for (let i = 0; i < 32; i++) c_cc.push(i < 19 ? b[17 + i] : 0);
  return { c_iflag: dv.getUint32(0, true), c_oflag: dv.getUint32(4, true), c_cflag: dv.getUint32(8, true), c_lflag: dv.getUint32(12, true), c_cc };
}

function installKernelStdio(FS) {
  // emscripten's ioctl(2) only does termios for streams with a `tty`;
  // these hooks pass TCGETS/TCSETS*/TIOCGWINSZ to the kernel (ENOTTY when
  // the kernel fd isn't a terminal).
  const tty = {
    ops: {
      ioctl_tcgets(stream) {
        const r = sys(SYS.ioctl, stream.node.kfd, TCGETS, 36);
        if (r < 0) throw new FS.ErrnoError(wasiErrno(r));
        return termiosFromKernel(data);
      },
      ioctl_tcsets(t, op, termios) {
        const dv = new DataView(data.buffer, data.byteOffset, 36);
        dv.setUint32(0, termios.c_iflag >>> 0, true);
        dv.setUint32(4, termios.c_oflag >>> 0, true);
        dv.setUint32(8, termios.c_cflag >>> 0, true);
        dv.setUint32(12, termios.c_lflag >>> 0, true);
        data[16] = 0;
        for (let i = 0; i < 19; i++) data[17 + i] = termios.c_cc[i] & 255;
        const r = sys(SYS.ioctl, t.kfd, op, 36);
        return r < 0 ? -wasiErrno(r) : 0;
      },
      ioctl_tiocgwinsz(t) {
        const r = sys(SYS.ioctl, t.kfd, TIOCGWINSZ, 8);
        if (r < 0) throw new FS.ErrnoError(wasiErrno(r));
        const dv = new DataView(data.buffer, data.byteOffset, 8);
        return [dv.getUint16(0, true), dv.getUint16(2, true)];
      },
    },
  };
  const nodes = {};
  const ops = {
    read(stream, buffer, offset, length) {
      const kfd = stream.node.kfd;
      // Never block this thread on input: other guest threads' syscalls are
      // proxied here. Blink polls (and waits) before reading a blocking fd.
      if (!(pollFd(kfd, POLLIN) & ~POLLOUT)) throw new FS.ErrnoError(6); // EAGAIN
      const n = sys(SYS.read, kfd, Math.min(length, data.length));
      if (n < 0) throw new FS.ErrnoError(n === -11 ? 6 : 29);
      buffer.set(data.subarray(0, n), offset);
      return n;
    },
    write(stream, buffer, offset, length) {
      const n = writeFd(stream.node.kfd, buffer.subarray(offset, offset + length));
      if (n < 0) throw new FS.ErrnoError(n === -32 ? 64 : 29); // EPIPE
      return n;
    },
    poll(stream) {
      return pollFd(stream.node.kfd, POLLIN | POLLOUT) || 0;
    },
  };
  const dev = FS.makedev(64, 0);
  FS.registerDevice(dev, ops);
  for (const fd of [0, 1, 2]) {
    const path = '/dev/kfd' + fd;
    FS.mkdev(path, 0o666, dev);
    if (FS.getStream(fd)) FS.closeStream(fd);
    const stream = FS.open(path, fd === 0 ? 0 : 1);
    if (stream.fd !== fd) {
      FS.closeStream(stream.fd);
      stream.fd = fd;
      FS.streams[fd] = stream;
    }
    stream.node.kfd = fd;
    stream.tty = { ...tty, kfd: fd };
    nodes[fd] = stream.node;
    watched.set(fd, stream.node);
  }
  return nodes;
}

function rmTree(FS, path) {
  let st;
  try { st = FS.lstat(path); } catch { return; }
  if (FS.isDir(st.mode)) {
    for (const n of FS.readdir(path)) if (n !== '.' && n !== '..') rmTree(FS, path + '/' + n);
    FS.rmdir(path);
  } else {
    FS.unlink(path);
  }
}

let exiting = false;
let failGuest = null; // run()'s fail, once the guest is starting

// An engine abort after an await (in an async syscall's continuation) is a
// rejected promise, and a worker's unhandled rejection fires no 'error' event
// on the page's Worker: the kernel never heard the process end and its parent
// (dpkg under apt) waited forever with no CPU. End the guest as any abort does.
const onRejection = (reason) => {
  if (reason === 'unwind' || exiting) return;
  if (reason && reason.name === 'ExitStatus') { try { exitGuest(reason.status); } catch { /* unwind */ } return; }
  const text = String((reason && reason.stack) || reason);
  if (failGuest) { try { failGuest(text, 134); } catch { /* unwind */ } return; }
  setTimeout(() => { throw reason instanceof Error ? reason : new Error(text); }); // the page's onError
};
if (isNode) process.on('unhandledRejection', onRejection);
else self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); onRejection(e.reason); });

function exitGuest(code) {
  if (exiting) return;
  exiting = true;
  sys(SYS.exit_group, code & 255);
  // The kernel terminates this worker. Unwind out of Blink back to the event
  // loop rather than park: Chromium takes 2 s to terminate a Worker blocked in
  // a wait, and only then starts on Blink's thread Workers (another 2 s).
  throw 'unwind';
}

async function run(msg) {
  debug = !!msg.debug;
  debugPid = msg.pid;
  progPath = msg.path || '';
  atomicsWake = msg.wake === 'atomics';
  i32 = new Int32Array(msg.sab, 0, CH_DATA / 4);
  data = new Uint8Array(msg.sab, CH_DATA);
  const errTail = [];
  const fail = (text, code) => {
    if (errTail.length) text = `${text}\n${errTail.join('\n')}`;
    // The page logs it to the kernel log (dmesg): an engine abort or out of memory
    if (!exiting) post({ type: 'blink-abort', text: String(text) });
    if (!exiting) writeFd(2, enc.encode(`blink: ${text}\n`));
    exitGuest(code);
  };
  failGuest = fail;
  let M = null;

  // ── The channel pool for the guest's own syscalls (shiro-kernel.js) ──
  const pool = (msg.pool || []).map((sab) => ({
    i32: new Int32Array(sab, 0, CH_DATA / 4), data: new Uint8Array(sab, CH_DATA), busy: false, done: null,
  }));
  const chunk = pool.length ? pool[0].data.length : 0;
  const waiting = [];
  // Every channel busy (threads or same-instance fork children blocked in
  // the kernel: epoll_wait, a pipe read): ask the page for another one
  // rather than queue behind them, up to its cap ('blink-grow' → 'blink-channel')
  let growing = false;
  const acquire = () => new Promise((resolve) => {
    const ch = pool.find((c) => !c.busy);
    if (ch) { ch.busy = true; resolve(ch); return; }
    waiting.push(resolve);
    if (!growing && pool.length) { growing = true; post({ type: 'blink-grow' }); }
  });
  const addChannel = (sab) => {
    growing = false;
    if (!sab) return; // at the cap: the waiters queue for a free channel
    const ch = { i32: new Int32Array(sab, 0, CH_DATA / 4), data: new Uint8Array(sab, CH_DATA), busy: true, done: null };
    pool.push(ch);
    release(ch);
    if (waiting.length && !growing) { growing = true; post({ type: 'blink-grow' }); }
  };
  const release = (ch) => {
    const next = waiting.shift();
    if (next) next(ch); else ch.busy = false;
  };
  // One request on `ch`; the page serves it and posts 'blink-done'.
  const hosted = new Set();  // kernel pids of same-instance fork children
  const issue = (ch, nr, args, as) => new Promise((resolve) => {
    for (let i = 0; i < CH_NARGS; i++) ch.i32[CH_ARGS + i] = args[i] ?? 0;
    ch.i32[CH_SYSNO] = nr;
    ch.done = resolve;
    Atomics.store(ch.i32, CH_STATE, 1);
    post({ type: 'blink-sys', ch: pool.indexOf(ch), as });
  });
  // The guest is exiting (Blink's ShiroQuiesce): the calls its other threads
  // have in flight, and any they make now, end with EINTR so the threads get
  // back to Blink, which ends them before the kernel hears exit_group.
  let dying = false;
  const EINTR_REPLY = { r: -4, hi: -1, out: null };
  const shiroDying = () => {
    dying = true;
    for (const ch of pool) {
      const done = ch.done;
      ch.done = null;
      done?.({ r: -4, hi: -1, sig: 0 });
    }
  };
  const call = async (nr, args, as, input, outCap) => {
    if (exiting) return new Promise(() => {}); // the kernel ends this worker
    if (dying) return EINTR_REPLY;
    const ch = await acquire();
    if (dying) { release(ch); return EINTR_REPLY; }
    try {
      if (input.length > ch.data.length) return { r: -7 /* E2BIG */, hi: -1, out: null };
      ch.data.set(input);
      let res = await issue(ch, nr, args, as);
      const out = outCap ? ch.data.slice(0, Math.min(outCap, ch.data.length)) : null;
      // A signal for the guest rode on the reply: queue it, then rt_sigreturn
      while (res.sig) {
        if (debug) console.error(`[blink] ${debugPid} signal ${res.sig}${as ? ' for ' + as : ''}`);
        // a hosted child's signal goes to its own System (vfork children,
        // which have none, run on ours)
        if (as && hosted.has(as)) blinkModule?._blink_shiro_signal_pid?.(as, res.sig);
        else blinkModule?._blink_shiro_signal?.(res.sig);
        res = { ...res, sig: (await issue(ch, SYS.rt_sigreturn, [], as)).sig };
      }
      return { r: res.r, hi: res.hi, out };
    } finally {
      release(ch);
    }
  };
  onMessage((m) => {
    // Once the guest has exited this worker only waits to be terminated
    if (!m || exiting) return;
    if (m.type === 'blink-done') {
      const ch = pool[m.ch];
      if (!ch || Atomics.load(ch.i32, CH_STATE) !== 2) return;
      const r = ch.i32[CH_RESULT], hi = ch.i32[CH_ARGS];
      Atomics.store(ch.i32, CH_STATE, 0);
      const sig = Atomics.exchange(ch.i32, CH_SIGNAL, 0);
      const done = ch.done;
      ch.done = null;
      if (debug) console.error(`[blink] ${debugPid} ksys ${ch.i32[CH_SYSNO]}(${Array.from(ch.i32.subarray(CH_ARGS + 1, CH_ARGS + 4)).join(',')}) = ${r}`);
      done?.({ r, hi, sig });
    } else if (m.type === 'blink-channel') {
      addChannel(m.sab);
    } else if (m.type === 'blink-signal' && !exiting) {
      // The kernel signalled us: any syscall reply carries the signal word.
      if (m.pid) void call(SYS.getpid, [], m.pid, new Uint8Array(0), 0);
      else sys(SYS.getpid);
    } else if (m.type === 'blink-reap') {
      // a hosted child's process ended in the kernel (killed): end its System
      if (hosted.delete(m.pid)) blinkModule?._blink_shiro_signal_pid?.(m.pid, 9);
    }
  });
  const sigaction = (sig, handler) => {
    const dv = new DataView(data.buffer, data.byteOffset, 64);
    for (let i = 0; i < 64; i++) data[i] = 0;
    dv.setUint32(0, handler, true);
    sys(SYS.rt_sigaction, sig, 1, 0);
  };
  // Signals this process starts out ignoring (nohup, background jobs): the
  // guest inherits them, as across exec on Linux.
  let ignLo = 0, ignHi = 0;
  for (let sig = 1; sig < 64; sig++) {
    if (sig === 9 || sig === 19) continue;
    for (let i = 0; i < 64; i++) data[i] = 0;
    if (sys(SYS.rt_sigaction, sig, 0, 1) < 0) continue;
    if (new DataView(data.buffer, data.byteOffset + 32, 8).getUint32(0, true) === SIG_IGN) {
      if (sig <= 32) ignLo |= 1 << (sig - 1); else ignHi |= 1 << (sig - 33);
    }
  }
  const kernel = {
    sys,
    call,
    // same-instance fork: this worker runs kernel process `pid` too
    hosted(pid) {
      hosted.add(pid);
      port.postMessage({ type: 'blink-hosted', pid });
    },
    // fork(): the page starts the snapshot as the kernel's child `pid`
    fork(pid, bytes) {
      port.postMessage({ type: 'blink-fork', pid, snapshot: bytes.buffer }, [bytes.buffer]);
      return 0;
    },
    // a thread waiting on a direct channel has a signal to take (Blink
    // patch 0065): the page interrupts the process's blocking calls
    kick() { post({ type: 'blink-kick' }); },
    get data() { return data; },
    poll: (kfd, events, timeoutMs = 0) => pollFd(kfd, events, timeoutMs),
    watch(kfd, node) { watched.set(kfd, node); post({ type: 'blink-watch', fd: kfd }); },
    unwatch(kfd) { watched.delete(kfd); post({ type: 'blink-unwatch', fd: kfd }); },
    errno: wasiErrno,
  };
  try {
    const { default: createBlink } = await import(msg.moduleUrl || './blink.mjs');
    M = await createBlink({
      // blink.wasm's content-hashed URL when the page has one (cached for good)
      ...(msg.wasmUrl ? { locateFile: (p, prefix) => (p.endsWith('.wasm') ? msg.wasmUrl : prefix + p) } : {}),
      // The page's compiled blink.wasm: V8 keeps its optimized code while the
      // page holds it, rather than dropping it whenever no Blink worker is
      // left and compiling it again (Liftoff first) for the next process
      ...(msg.wasmModule ? {
        instantiateWasm: (imports, receive) => {
          WebAssembly.instantiate(msg.wasmModule, imports).then((inst) => receive(inst, msg.wasmModule), (e) => fail(String(e), 134));
          return {};
        },
      } : {}),
      shiroKernel: kernel,
      thisProgram: 'blink',
      noInitialRun: true,
      print: () => {},
      // Blink's own messages: logged with TABCOMPUTER_BLINK_DEBUG=1, and the
      // last few go with an abort's report (an assertion's file:line)
      printErr: (s) => { errTail.push(String(s)); if (errTail.length > 12) errTail.shift(); if (msg.debug) console.error(s); },
      // Blink calls shiroExit on this thread as soon as the guest exits;
      // onExit only fires if emscripten's own teardown completes.
      shiroExit: (code) => exitGuest(code),
      shiroDying: () => shiroDying(),
      // A signal's default action killed the guest: die of it in the kernel
      // too (default disposition, then kill self), so waitpid sees WTERMSIG.
      shiroKill: (sig) => {
        if (exiting) return;
        sigaction(sig, 0 /* SIG_DFL */);
        if (sys(SYS.kill, msg.pid, sig) < 0) exitGuest(128 + sig);
        exiting = true;
      },
      onExit: (code) => exitGuest(code),
      onAbort: (what) => fail('aborted: ' + what, 134),
      preRun: [(M) => {
        const FS = M.FS;
        FS.init(() => null, () => {}, () => {});
        const SHIROFS = makeShiroFS(FS, M);
        for (const dir of msg.mounts || []) {
          if (!/^\/[^/]+$/.test(dir) || dir === '/dev' || dir === '/proc') continue;
          rmTree(FS, dir);
          FS.mkdir(dir);
          FS.mount(SHIROFS, {}, dir);
        }
        for (const k of Object.keys(M.ENV)) delete M.ENV[k];
        Object.assign(M.ENV, msg.env || {});
        try { FS.chdir(msg.cwd || '/'); } catch { /* cwd missing: stay at / */ }
      }],
    });
    blinkModule = M;
    // Diagnostics (memory work, devtools): the wasm memory and the SHIROFS file copies
    globalThis.__blinkStats = () => {
      let files = 0;
      const walk = (node) => {
        if (node.contents instanceof Uint8Array) files += node.contents.byteLength;
        else if (node.contents && typeof node.contents === 'object') for (const c of Object.values(node.contents)) walk(c);
      };
      try { walk(M.FS.root); } catch { /* best effort */ }
      return { wasmBytes: M.HEAPU8.buffer.byteLength, fileBytes: files };
    };
    if (pool.length) M._blink_shiro_enable(msg.pid, chunk, ignLo >>> 0, ignHi >>> 0);
    // Direct channels (Blink patch 0065): in Blink's wasm memory, used by its
    // threads themselves and served by the page watching their state words,
    // so a kernel call skips the proxy to this thread and both messages.
    // The pool above stays for the rest (other processes in this instance,
    // all direct channels busy). Opt-in, TABCOMPUTER_BLINK_DIRECT=1: the
    // page then holds this worker's wasm memory, which (we think) a finished
    // process gives back only at the page's next GC (peak RSS +10-17 MiB for vim
    // and Go's net/http in Chromium, against -11-17% time).
    const directOn = msg.env?.TABCOMPUTER_BLINK_DIRECT === '1' || (isNode && process.env.TABCOMPUTER_BLINK_DIRECT === '1');
    if (pool.length && M._blink_shiro_direct && directOn) {
      // 64 KiB of data each: bigger transfers take the pool (its 1 MiB
      // chunks), and four of them cost the process 256 KiB, not 4 MiB
      const n = 4, size = Math.min(chunk, 65536), stride = (CH_DATA + size + 63) & ~63;
      const raw = M._malloc(n * stride + 64);
      if (raw) {
        const base = (raw + 63) & ~63;
        // only the headers: the data areas are written before they're read
        for (let i = 0; i < n; i++) M.HEAPU8.fill(0, base + i * stride, base + i * stride + CH_DATA);
        M._blink_shiro_direct(base, n, stride, size);
        post({ type: 'blink-direct', buffer: M.HEAPU8.buffer, base, n, stride, size });
      }
    }
    if (msg.restore) {
      // This process is a fork(): Blink rebuilds the parent's snapshot instead of loading the program
      const snap = new Uint8Array(msg.restore);
      const ptr = M._malloc(snap.length);
      M.HEAPU8.set(snap, ptr);
      M._blink_shiro_set_restore(ptr, snap.length);
    }
    const argv = msg.argv && msg.argv.length ? msg.argv : [msg.path];
    // blink -0 PROGRAM ARGV0 ARGS...: load PROGRAM (the resolved path, never
    // a PATH search of argv[0]) and give the guest argv[0] as invoked.
    // Blink's own log goes to the in-memory root, not the guest's cwd.
    M.callMain([...(msg.debug && msg.env?.TABCOMPUTER_BLINK_STRACE ? ['-s', '-e'] : []), '-L', '/blink.log', '-0', msg.path || argv[0], argv[0], ...argv.slice(1)]);
  } catch (e) {
    try {
      if (e && e.name === 'ExitStatus') exitGuest(e.status);
      else if (e !== 'unwind') fail(String((e && e.stack) || e), 134);
    } catch (e2) {
      if (e2 !== 'unwind') throw e2;
    }
  }
}

onMessage((msg) => {
  if (msg && msg.type === 'shiro-start') run(msg);
});
