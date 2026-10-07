// Shiro host for the Blink x86-64 engine (blink.mjs/blink.wasm, built by
// vendor/blink/build.sh). Runs inside a Worker (browser) or worker_thread
// (Node/vitest); the page side is src/x86-engine/blink.ts.
//
// One worker runs one guest process. The page sends
//   { type: 'run', argv, env, cwd, stdin, mounts, chan }
// and receives { type: 'out', fd, data }, { type: 'exit', code } or
// { type: 'error', message }.
//
// Files: every top-level Shiro directory in `mounts` is mounted as SHIROFS, a
// MEMFS whose nodes are faulted in from the page on first lookup/open and
// written back on close. Requests travel over `chan`, a SharedArrayBuffer laid
// out like the kernel ABI syscall channel (docs/KERNEL_ABI.md): Int32 state /
// op / result words, then a data area at byte 64. This worker blocks in
// Atomics.wait while the page performs the async filesystem call.

const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof self === 'undefined';
let port;
if (isNode) {
  const wt = await import('node:worker_threads');
  port = wt.parentPort;
} else {
  port = self;
}
const post = (msg, transfer) => (isNode ? port.postMessage(msg, transfer) : port.postMessage(msg, transfer || []));
const onMessage = (fn) => (isNode ? port.on('message', fn) : port.addEventListener('message', (e) => fn(e.data)));

// Channel layout (Int32 indices)
const ST = 0, OP = 1, RES = 2, LEN = 4, JLEN = 5, DATA = 64;
export const FS_OPS = { STAT: 1, READDIR: 2, READ: 3, WRITE: 4, MKDIR: 5, UNLINK: 6, RMDIR: 7, RENAME: 8, SYMLINK: 9, READLINK: 10, CHMOD: 11 };

let chan = null, i32 = null, u8 = null, dataSize = 0;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Synchronous request to the page. Returns { res, bytes } (bytes is a copy). */
function rpc(op, req, payload) {
  const json = enc.encode(JSON.stringify(req));
  const plen = payload ? payload.length : 0;
  if (json.length + plen > dataSize) throw new Error('blink host: request too large');
  u8.set(json, DATA);
  if (plen) u8.set(payload, DATA + json.length);
  Atomics.store(i32, OP, op);
  Atomics.store(i32, JLEN, json.length);
  Atomics.store(i32, LEN, json.length + plen);
  Atomics.store(i32, ST, 1);
  post({ type: 'fs' });
  while (Atomics.load(i32, ST) === 1) Atomics.wait(i32, ST, 1, 1000);
  const res = Atomics.load(i32, RES);
  const n = Atomics.load(i32, LEN);
  const bytes = u8.slice(DATA, DATA + n);
  Atomics.store(i32, ST, 0);
  return { res, bytes };
}
const rpcJson = (op, req) => {
  const { res, bytes } = rpc(op, req);
  return { res, value: res >= 0 && bytes.length ? JSON.parse(dec.decode(bytes)) : null };
};

function makeShiroFS(FS) {
  const MEMFS = FS.filesystems.MEMFS;
  const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
  // The page answers with negative Linux errno; emscripten's FS uses the
  // WASI numbering (ENOENT is 44, not 2).
  const LINUX_TO_WASI = { 1: 63, 2: 44, 5: 29, 9: 8, 13: 2, 17: 20, 20: 54, 21: 31, 22: 28, 28: 51, 30: 69, 39: 55, 40: 32 };
  const err = (res) => new FS.ErrnoError(LINUX_TO_WASI[-res] || 29);
  const isOurs = (node) => node && node.mount && node.mount.type === SHIROFS;
  const pathOf = (node) => FS.getPath(node);
  const joinPath = (dir, name) => (dir === '/' ? '/' + name : dir + '/' + name);

  function ensureLoaded(node) {
    if (!node.shiroLazy) return;
    const path = pathOf(node);
    const chunks = [];
    let off = 0, total = 0;
    for (;;) {
      const { res, bytes } = rpc(FS_OPS.READ, { path, offset: off });
      if (res < 0) throw err(res);
      total = res;
      chunks.push(bytes);
      off += bytes.length;
      if (off >= total || bytes.length === 0) break;
    }
    const buf = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { buf.set(c, p); p += c.length; }
    node.contents = buf;
    node.usedBytes = total;
    node.shiroLazy = false;
  }

  function writeBack(node) {
    if (!node.shiroDirty || node.shiroLazy) return;
    const path = pathOf(node);
    const data = node.contents ? node.contents.subarray(0, node.usedBytes) : new Uint8Array(0);
    const chunk = Math.max(4096, dataSize - 4096);
    let off = 0;
    do {
      const part = data.subarray(off, off + chunk);
      const final = off + part.length >= data.length;
      const { res } = rpc(FS_OPS.WRITE, { path, offset: off, final, mode: node.mode & 0o7777 }, part);
      if (res < 0) throw err(res);
      off += part.length;
    } while (off < data.length);
    node.shiroDirty = false;
  }

  function makeNode(parent, name, st) {
    let node;
    if (st.type === 'dir') {
      node = MEMFS.createNode(parent, name, S_IFDIR | (st.mode & 0o7777 || 0o755), 0);
    } else if (st.type === 'symlink') {
      node = MEMFS.createNode(parent, name, S_IFLNK | 0o777, 0);
      node.link = st.target || '';
    } else {
      node = MEMFS.createNode(parent, name, S_IFREG | (st.mode & 0o7777 || 0o644), 0);
      node.shiroLazy = true;
      node.shiroSize = st.size;
    }
    if (st.mtime) node.mtime = node.ctime = node.atime = st.mtime;
    return node;
  }

  const base = {
    dir: MEMFS.ops_table.dir, file: MEMFS.ops_table.file, link: MEMFS.ops_table.link,
  };

  const dirNodeOps = {
    ...base.dir.node,
    getattr: (node) => base.dir.node.getattr(node),
    lookup(parent, name) {
      if (parent.shiroListed && !parent.shiroListed.has(name)) throw new FS.ErrnoError(44);
      const path = joinPath(pathOf(parent), name);
      const { res, value } = rpcJson(FS_OPS.STAT, { path });
      if (res < 0) throw err(res);
      return makeNode(parent, name, value);
    },
    readdir(node) {
      if (!node.shiroListed) {
        const { res, value } = rpcJson(FS_OPS.READDIR, { path: pathOf(node) });
        if (res < 0) throw err(res);
        node.shiroListed = new Set(value);
      }
      const names = new Set(node.shiroListed);
      for (const k of Object.keys(node.contents || {})) names.add(k);
      return ['.', '..', ...names];
    },
    mknod(parent, name, mode, dev) {
      const path = joinPath(pathOf(parent), name);
      let res;
      if (FS.isDir(mode)) res = rpc(FS_OPS.MKDIR, { path, mode: mode & 0o7777 }).res;
      else res = rpc(FS_OPS.WRITE, { path, offset: 0, final: true, mode: mode & 0o7777 }).res;
      if (res < 0) throw err(res);
      parent.shiroListed?.add(name);
      return base.dir.node.mknod(parent, name, mode, dev);
    },
    symlink(parent, name, target) {
      const { res } = rpc(FS_OPS.SYMLINK, { path: joinPath(pathOf(parent), name), target });
      if (res < 0) throw err(res);
      parent.shiroListed?.add(name);
      return base.dir.node.symlink(parent, name, target);
    },
    rename(oldNode, newDir, newName) {
      const from = pathOf(oldNode);
      const to = joinPath(pathOf(newDir), newName);
      if (oldNode.shiroDirty) writeBack(oldNode);
      const { res } = rpc(FS_OPS.RENAME, { from, to });
      if (res < 0) throw err(res);
      oldNode.parent.shiroListed?.delete(oldNode.name);
      newDir.shiroListed?.add(newName);
      return base.dir.node.rename(oldNode, newDir, newName);
    },
    unlink(parent, name) {
      const { res } = rpc(FS_OPS.UNLINK, { path: joinPath(pathOf(parent), name) });
      if (res < 0) throw err(res);
      parent.shiroListed?.delete(name);
      return base.dir.node.unlink(parent, name);
    },
    rmdir(parent, name) {
      const { res } = rpc(FS_OPS.RMDIR, { path: joinPath(pathOf(parent), name) });
      if (res < 0) throw err(res);
      parent.shiroListed?.delete(name);
      return base.dir.node.rmdir(parent, name);
    },
    setattr(node, attr) {
      if (attr.mode !== undefined) rpc(FS_OPS.CHMOD, { path: pathOf(node), mode: attr.mode & 0o7777 });
      return base.dir.node.setattr(node, attr);
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
      if (attr.mode !== undefined) rpc(FS_OPS.CHMOD, { path: pathOf(node), mode: attr.mode & 0o7777 });
      base.file.node.setattr(node, attr);
      if (attr.size !== undefined) writeBack(node);
    },
  };

  const fileStreamOps = {
    ...base.file.stream,
    open(stream) { ensureLoaded(stream.node); },
    write(stream, buffer, offset, length, position, canOwn) {
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

  const linkNodeOps = { ...base.link.node };

  function patch(node) {
    if (FS.isDir(node.mode)) node.node_ops = dirNodeOps;
    else if (FS.isFile(node.mode)) { node.node_ops = fileNodeOps; node.stream_ops = fileStreamOps; }
    else if (FS.isLink(node.mode)) node.node_ops = linkNodeOps;
    return node;
  }

  const origCreate = MEMFS.createNode;
  MEMFS.createNode = (parent, name, mode, dev) => {
    const node = origCreate(parent, name, mode, dev);
    return isOurs(parent) ? patch(node) : node;
  };

  const SHIROFS = {
    mount(mount) {
      const root = origCreate(null, '/', S_IFDIR | 0o755, 0);
      return patch(root);
    },
  };
  return SHIROFS;
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

async function run(msg) {
  chan = msg.chan;
  i32 = new Int32Array(chan);
  u8 = new Uint8Array(chan);
  dataSize = chan.byteLength - DATA;

  // Batched stdout/stderr: one message per ~4 KiB or per macrotask.
  const outBuf = { 1: [], 2: [] };
  let flushScheduled = false;
  const flush = () => {
    flushScheduled = false;
    for (const fd of [1, 2]) {
      if (outBuf[fd].length) {
        const data = Uint8Array.from(outBuf[fd]);
        outBuf[fd] = [];
        post({ type: 'out', fd, data }, [data.buffer]);
      }
    }
  };
  const emit = (fd) => (c) => {
    if (c === null || c === undefined) return;
    outBuf[fd].push(c & 255);
    if (outBuf[fd].length >= 4096) flush();
    else if (!flushScheduled) { flushScheduled = true; setTimeout(flush, 0); }
  };
  const stdin = msg.stdin || new Uint8Array(0);
  let stdinPos = 0;

  const { default: createBlink } = await import(msg.moduleUrl || './blink.mjs');
  let exited = false;
  const done = (m) => { if (exited) return; exited = true; flush(); post(m); };
  const Module = {
    thisProgram: 'blink',
    noInitialRun: true,
    stdin: () => (stdinPos < stdin.length ? stdin[stdinPos++] : null),
    stdout: emit(1),
    stderr: emit(2),
    print: () => {},
    printErr: (s) => { if (msg.debug) console.error(s); },
    onExit: (code) => done({ type: 'exit', code }),
    onAbort: (what) => done({ type: 'error', message: 'blink aborted: ' + what }),
    preRun: [(M) => {
      const FS = M.FS;
      const SHIROFS = makeShiroFS(FS);
      for (const dir of msg.mounts || []) {
        if (!/^\/[^/]+$/.test(dir) || dir === '/dev' || dir === '/proc') continue;
        rmTree(FS, dir);
        FS.mkdir(dir);
        FS.mount(SHIROFS, {}, dir);
      }
      for (const k of Object.keys(M.ENV)) delete M.ENV[k];
      Object.assign(M.ENV, msg.env || {});
      try { FS.chdir(msg.cwd || '/'); } catch { /* cwd missing in Shiro: stay at / */ }
    }],
  };
  try {
    const M = await createBlink(Module);
    M.callMain(msg.argv);
  } catch (e) {
    if (e && e.name === 'ExitStatus') done({ type: 'exit', code: e.status });
    else done({ type: 'error', message: String(e && e.stack || e) });
  }
}

onMessage((msg) => {
  if (msg && msg.type === 'run') run(msg);
});
