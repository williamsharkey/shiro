// Shiro host for the Blink x86-64 engine (blink.mjs/blink.wasm, built by
// vendor/blink/build.sh). Runs inside a Worker (browser) or worker_thread
// (Node/vitest); the page side is src/x86-engine/blink.ts.
//
// One worker runs one guest process, as a kernel process (src/kernel): the
// page starts it with the kernel's start message
//   { type: 'shiro-start', sab, pid, argv, env, cwd, path, moduleUrl, mounts }
// and every request from here is a kernel syscall over `sab` (the channel in
// docs/KERNEL_ABI.md). This worker blocks in Atomics.wait while the kernel
// works; Blink's own threads are emscripten pthreads whose libc calls are
// proxied to this thread.
//
// - fds 0/1/2 of the guest are the process's kernel fds 0/1/2 (pipes, files,
//   the terminal): reads poll first, so a guest waiting for input doesn't
//   stall the other guest threads' proxied syscalls.
// - Every top-level Shiro directory in `mounts` is mounted as SHIROFS, a
//   MEMFS whose nodes are faulted in through kernel syscalls on first
//   lookup/open and written back on close.
// - Sockets are in-process loopback (vendor/blink/shiro-net.js).
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
  read: 0, write: 1, close: 3, lstat: 6, poll: 7, rename: 82, mkdir: 83, rmdir: 84,
  unlink: 87, readlink: 89, getdents64: 217, exit_group: 231, openat: 257,
};
const O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 0o100, O_TRUNC = 0o1000, O_DIRECTORY = 0o200000, AT_FDCWD = -100;
const POLLIN = 1, POLLOUT = 4;
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;

let i32 = null, data = null, debug = false, progPath = '';
const enc = new TextEncoder();
const dec = new TextDecoder();

function sys(nr, ...args) {
  for (let i = 0; i < CH_NARGS; i++) i32[CH_ARGS + i] = args[i] ?? 0;
  i32[CH_SYSNO] = nr;
  Atomics.store(i32, CH_STATE, 1);
  Atomics.notify(i32, CH_STATE);
  post('sys');
  while (Atomics.load(i32, CH_STATE) === 1) Atomics.wait(i32, CH_STATE, 1);
  const r = i32[CH_RESULT];
  Atomics.store(i32, CH_STATE, 0);
  if (debug) console.error(`[blink] sys ${nr}(${args.join(', ')}) = ${r}` + (args.length && nr !== 0 && nr !== 1 ? ` ${JSON.stringify(dec.decode(data.slice(0, Math.min(args[nr === 257 ? 1 : 0] > 0 ? args[nr === 257 ? 1 : 0] : 0, 200))))}` : ''));
  // Kernel signals aren't forwarded into the guest yet (Blink has its own).
  Atomics.exchange(i32, CH_SIGNAL, 0);
  return r;
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
function pollFd(fd, events) {
  const dv = new DataView(data.buffer, data.byteOffset, 8);
  dv.setInt32(0, fd, true);
  dv.setInt16(4, events, true);
  dv.setInt16(6, 0, true);
  const r = sys(SYS.poll, 1, 0);
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
function readWhole(path) {
  const fd = openPath(path, O_RDONLY);
  if (fd < 0) return fd;
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const n = sys(SYS.read, fd, data.length);
      if (n < 0) return n;
      if (n === 0) break;
      chunks.push(data.slice(0, n));
      total += n;
    }
  } finally {
    sys(SYS.close, fd);
  }
  const buf = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { buf.set(c, p); p += c.length; }
  return buf;
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
function makeShiroFS(FS) {
  const MEMFS = FS.filesystems.MEMFS;
  // The kernel answers with negative Linux errno; emscripten's FS uses the
  // WASI numbering (ENOENT is 44, not 2).
  const LINUX_TO_WASI = { 1: 63, 2: 44, 5: 29, 9: 8, 13: 2, 17: 20, 20: 54, 21: 31, 22: 28, 28: 51, 30: 69, 36: 37, 38: 52, 39: 55, 40: 32 };
  const err = (res) => new FS.ErrnoError(LINUX_TO_WASI[-res] || 29);
  const check = (res) => { if (typeof res === 'number' && res < 0) throw err(res); return res; };
  const isOurs = (node) => node && node.mount && node.mount.type === SHIROFS;
  const pathOf = (node) => FS.getPath(node);
  const joinPath = (dir, name) => (dir === '/' ? '/' + name : dir + '/' + name);

  function ensureLoaded(node) {
    if (!node.shiroLazy) return;
    const buf = check(readWhole(pathOf(node)));
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
      if (attr.size !== undefined) { ensureLoaded(node); node.shiroDirty = true; }
      base.file.node.setattr(node, attr);
      if (attr.size !== undefined) writeBack(node);
    },
  };

  const fileStreamOps = {
    ...base.file.stream,
    open(stream) { ensureLoaded(stream.node); },
    write(stream, buffer, offset, length, position) {
      stream.node.shiroDirty = true;
      return base.file.stream.write(stream, buffer, offset, length, position, false);
    },
    mmap(stream, length, position, prot, flags) {
      ensureLoaded(stream.node);
      return base.file.stream.mmap(stream, length, position, prot, flags);
    },
    close(stream) { writeBack(stream.node); },
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
function installKernelStdio(FS) {
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
    nodes[fd] = stream.node;
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
function exitGuest(code) {
  if (exiting) return;
  exiting = true;
  sys(SYS.exit_group, code & 255);
  // The kernel terminates this worker; park until it does.
  const park = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(park, 0, 0, 1000);
}

async function run(msg) {
  debug = !!msg.debug;
  progPath = msg.path || '';
  i32 = new Int32Array(msg.sab, 0, CH_DATA / 4);
  data = new Uint8Array(msg.sab, CH_DATA);
  let stdioNodes = {};
  const fail = (text, code) => {
    if (!exiting) writeFd(2, enc.encode(`blink: ${text}\n`));
    exitGuest(code);
  };
  // The page tells us when a kernel fd may have become readable, so a guest
  // blocked in poll()/epoll on stdin wakes without waiting for its timeout.
  onMessage((m) => {
    if (m && m.type === 'blink-ready' && stdioNodes[m.fd]) stdioNodes[m.fd].notifyListeners(POLLIN);
  });
  try {
    const { default: createBlink } = await import(msg.moduleUrl || './blink.mjs');
    const M = await createBlink({
      thisProgram: 'blink',
      noInitialRun: true,
      print: () => {},
      printErr: (s) => { if (msg.debug) console.error(s); },
      // Blink calls shiroExit on this thread as soon as the guest exits;
      // onExit only fires if emscripten's own teardown completes.
      shiroExit: (code) => exitGuest(code),
      onExit: (code) => exitGuest(code),
      onAbort: (what) => fail('aborted: ' + what, 134),
      preRun: [(M) => {
        const FS = M.FS;
        FS.init(() => null, () => {}, () => {});
        stdioNodes = installKernelStdio(FS);
        const SHIROFS = makeShiroFS(FS);
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
    const argv = msg.argv && msg.argv.length ? msg.argv : [msg.path];
    M.callMain(['-0', argv[0], msg.path || argv[0], ...argv.slice(1)]);
  } catch (e) {
    if (e && e.name === 'ExitStatus') exitGuest(e.status);
    else if (e !== 'unwind') fail(String((e && e.stack) || e), 134);
  }
}

onMessage((msg) => {
  if (msg && msg.type === 'shiro-start') run(msg);
});
