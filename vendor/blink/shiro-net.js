/**
 * Shiro sockets for the Blink wasm build (an emscripten --js-library).
 *
 * Replaces emscripten's WebSocket-backed SOCKFS syscalls with kernel sockets
 * (src/kernel/net.ts): every socket the guest creates is a kernel fd, so TCP
 * goes through the WebSocket relay, loopback reaches any kernel listener
 * (other guests, node scripts, the iframe server), and UDP to port 53 is
 * answered by DNS-over-HTTPS.
 *
 * The kernel is reached through Module.shiroKernel, which host.mjs installs:
 *   sys(nr, ...args)  one syscall over the SAB channel (blocks this thread)
 *   data              the channel's data area (Uint8Array)
 *   poll(kfd, events[, timeoutMs])  revents
 *   watch(kfd, node)  ask the page to ping when kfd's readiness changes;
 *                     host.mjs then calls node.notifyListeners(revents)
 *   unwatch(kfd)
 *   errno(-linux)     the emscripten (WASI) errno for a negative Linux errno
 *
 * Kernel sockets are always opened O_NONBLOCK, so no call here parks this
 * thread for long (it serves every guest thread's proxied syscalls). A guest
 * socket without O_NONBLOCK blocks in accept, connect, send and recv calls by
 * returning a Promise from the proxied syscall; Blink polls before a
 * blocking read(). socketpair() stays emscripten's native ENOSYS stub.
 */

var ShiroNetLibrary = {
  $SHIRONET__deps: ['$FS'],
  $SHIRONET__postset: () => {
    addAtInit('SHIRONET.root = FS.mount(SHIRONET, {}, null);');
  },
  $SHIRONET: {
    root: null,
    nextId: 0,
    // Linux numbers used on the kernel side
    L: {
      SYS_read: 0, SYS_write: 1, SYS_close: 3, SYS_ioctl: 16,
      SYS_socket: 41, SYS_connect: 42, SYS_sendto: 44, SYS_recvfrom: 45, SYS_shutdown: 48,
      SYS_bind: 49, SYS_listen: 50, SYS_getsockname: 51, SYS_getpeername: 52,
      SYS_setsockopt: 54, SYS_getsockopt: 55, SYS_accept4: 288,
      SOCK_NONBLOCK: 0o4000, SOCK_CLOEXEC: 0o2000000, MSG_DONTWAIT: 0x40, MSG_NOSIGNAL: 0x4000,
      EAGAIN: 11, EINPROGRESS: 115, ENOPROTOOPT: 92, SOL_SOCKET: 1, SO_ERROR: 4,
      SO_RCVTIMEO: 20, SO_SNDTIMEO: 21, FIONREAD: 0x541b, SOCKADDR_ROOM: 28,
    },
    mount(mount) {
      return FS.createNode(null, '/', {{{ cDefs.S_IFDIR }}} | 0o777, 0);
    },
    K() {
      var k = Module['shiroKernel'];
      if (!k) throw new FS.ErrnoError({{{ cDefs.ENETDOWN }}});
      return k;
    },
    fail(r) {
      throw new FS.ErrnoError(SHIRONET.K().errno(r));
    },
    check(r) {
      if (r < 0) SHIRONET.fail(r);
      return r;
    },

    wrap(kfd, family, type, nonblock) {
      var node = FS.createNode(SHIRONET.root, 'socket[' + (SHIRONET.nextId++) + ']', {{{ cDefs.S_IFSOCK }}} | 0o777, 0);
      node.kfd = kfd;
      node.refs = 1;
      node.family = family;
      node.socktype = type;
      var flags = {{{ cDefs.O_RDWR }}} | (nonblock ? {{{ cDefs.O_NONBLOCK }}} : 0);
      var stream = FS.createStream({ path: node.name, node, flags, seekable: false, stream_ops: SHIRONET.stream_ops });
      SHIRONET.K().watch(kfd, node);
      return stream;
    },

    get(fd) {
      var stream = FS.getStream(fd);
      if (!stream) throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      if (stream.node.kfd === undefined || !stream.node.socktype) throw new FS.ErrnoError({{{ cDefs.ENOTSOCK }}});
      return stream;
    },
    nonblocking(stream) {
      return !!(stream.flags & {{{ cDefs.O_NONBLOCK }}});
    },

    // Run `attempt` (a kernel call that returns -EAGAIN when not ready);
    // a blocking guest socket waits for `events` and tries again.
    retry(stream, events, attempt) {
      var r = attempt();
      if (r !== -SHIRONET.L.EAGAIN || SHIRONET.nonblocking(stream)) return r;
      var node = stream.node;
      var mask = events | {{{ cDefs.POLLERR }}} | {{{ cDefs.POLLHUP }}};
      return new Promise((resolve) => {
        var reg;
        var tryAgain = () => {
          if (!(SHIRONET.K().poll(node.kfd, events) & mask)) return;
          var n = attempt();
          if (n === -SHIRONET.L.EAGAIN) return;
          reg.listeners.delete(reg.entry);
          resolve(n);
        };
        reg = node.addListener(() => tryAgain());
        tryAgain();
      });
    },

    // Map a retry() result (a number, or a Promise of one) through `then`.
    after(r, then) {
      var safe = (n) => {
        try { return then(n); } catch (e) {
          if (e.name !== 'ErrnoError') throw e;
          return -e.errno;
        }
      };
      return r && typeof r.then === 'function' ? r.then(safe) : then(r);
    },

    putAddr(addr, len) {
      if (len > 128) throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      SHIRONET.K().data.set(HEAPU8.subarray(addr, addr + len), 0);
      return len;
    },
    addrLen(bytes, off) {
      var family = bytes[off] | (bytes[off + 1] << 8);
      return family == {{{ cDefs.AF_INET6 }}} ? 28 : family == {{{ cDefs.AF_INET }}} ? 16 : 110;
    },
    // Copy a sockaddr of `n` bytes at data[off] to guest memory (addr, *lenp).
    takeAddr(off, n, addr, lenp) {
      if (!addr || !lenp) return;
      var data = SHIRONET.K().data;
      var cap = {{{ makeGetValue('lenp', 0, 'i32') }}};
      for (var i = 0; i < Math.min(cap, n); i++) HEAPU8[addr + i] = data[off + i];
      {{{ makeSetValue('lenp', 0, 'n', 'i32') }}};
    },

    // Stream send of `bytes` (a copy); may resolve later on a blocking socket.
    send(stream, bytes, flags, done = 0) {
      var K = SHIRONET.K(), L = SHIRONET.L;
      while (done < bytes.length) {
        var part = bytes.subarray(done, done + K.data.length);
        var r = SHIRONET.retry(stream, {{{ cDefs.POLLOUT }}}, () => {
          K.data.set(part, 0);
          return K.sys(L.SYS_sendto, stream.node.kfd, part.length, flags | L.MSG_NOSIGNAL, 0);
        });
        if (r && typeof r.then === 'function') {
          var sofar = done;
          return r.then((n) => n < 0 ? (sofar || -K.errno(n)) : SHIRONET.send(stream, bytes, flags, sofar + n));
        }
        if (r < 0) return done || -K.errno(r);
        done += r;
      }
      return done;
    },

    stream_ops: {
      getattr(stream) {
        return { dev: 1, ino: stream.node.id, mode: {{{ cDefs.S_IFSOCK }}} | 0o777, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0,
          atime: new Date(0), mtime: new Date(0), ctime: new Date(0), blksize: 4096, blocks: 0 };
      },
      poll(stream) {
        return SHIRONET.K().poll(stream.node.kfd, {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLOUT }}} | {{{ cDefs.POLLRDHUP }}});
      },
      ioctl(stream, request, argp) {
        var K = SHIRONET.K();
        if (request == {{{ cDefs.FIONREAD }}}) {
          SHIRONET.check(K.sys(SHIRONET.L.SYS_ioctl, stream.node.kfd, SHIRONET.L.FIONREAD, 4));
          var v = K.data[0] | (K.data[1] << 8) | (K.data[2] << 16) | (K.data[3] << 24);
          {{{ makeSetValue('argp', 0, 'v', 'i32') }}};
          return 0;
        }
        return -{{{ cDefs.ENOTTY }}};
      },
      read(stream, buffer, offset, length) {
        var K = SHIRONET.K();
        var r = K.sys(SHIRONET.L.SYS_read, stream.node.kfd, Math.min(length, K.data.length));
        if (r < 0) SHIRONET.fail(r);
        buffer.set(K.data.subarray(0, r), offset);
        return r;
      },
      write(stream, buffer, offset, length) {
        var K = SHIRONET.K();
        var total = 0;
        while (total < length) {
          var n = Math.min(length - total, K.data.length);
          K.data.set(buffer.subarray(offset + total, offset + total + n), 0);
          var r = K.sys(SHIRONET.L.SYS_write, stream.node.kfd, n);
          if (r === -SHIRONET.L.EAGAIN && !SHIRONET.nonblocking(stream)) {
            // write() can't return a Promise: wait for room right here.
            K.poll(stream.node.kfd, {{{ cDefs.POLLOUT }}}, 50);
            continue;
          }
          if (r < 0) {
            if (total) return total;
            SHIRONET.fail(r);
          }
          total += r;
        }
        return total;
      },
      dup(stream) {
        stream.node.refs++;
      },
      close(stream) {
        var node = stream.node;
        if (--node.refs > 0) return;
        var K = SHIRONET.K();
        K.unwatch(node.kfd);
        K.sys(SHIRONET.L.SYS_close, node.kfd);
      },
    },
  },

  __syscall_socket__deps: ['$SHIRONET'],
  __syscall_socket: (domain, type, protocol, u1, u2, u3) => {
    // Block bodies only: wrapSyscallFunction() re-wraps the body and drops
    // the implicit return of a concise arrow.
    var L = SHIRONET.L;
    var nonblock = !!(type & L.SOCK_NONBLOCK);
    var base = type & ~(L.SOCK_NONBLOCK | L.SOCK_CLOEXEC);
    var kfd = SHIRONET.check(SHIRONET.K().sys(L.SYS_socket, domain, base | L.SOCK_NONBLOCK | L.SOCK_CLOEXEC, protocol));
    return SHIRONET.wrap(kfd, domain, base, nonblock).fd;
  },

  __syscall_bind__deps: ['$SHIRONET'],
  __syscall_bind: (fd, addr, len, u1, u2, u3) => {
    var s = SHIRONET.get(fd);
    var n = SHIRONET.putAddr(addr, len);
    SHIRONET.check(SHIRONET.K().sys(SHIRONET.L.SYS_bind, s.node.kfd, n));
    return 0;
  },

  __syscall_listen__deps: ['$SHIRONET'],
  __syscall_listen: (fd, backlog, u1, u2, u3, u4) => {
    var s = SHIRONET.get(fd);
    SHIRONET.check(SHIRONET.K().sys(SHIRONET.L.SYS_listen, s.node.kfd, backlog));
    return 0;
  },

  __syscall_connect__deps: ['$SHIRONET'],
  __syscall_connect__async: 'auto',
  __syscall_connect: (fd, addr, len, u1, u2, u3) => {
    var s = SHIRONET.get(fd), K = SHIRONET.K(), L = SHIRONET.L;
    var n = SHIRONET.putAddr(addr, len);
    var r = K.sys(L.SYS_connect, s.node.kfd, n);
    if (r !== -L.EINPROGRESS) return r < 0 ? -K.errno(r) : 0;
    if (SHIRONET.nonblocking(s)) return -K.errno(r);
    // Blocking connect: wait for the result, then report SO_ERROR.
    var node = s.node;
    var mask = {{{ cDefs.POLLOUT }}} | {{{ cDefs.POLLERR }}} | {{{ cDefs.POLLHUP }}};
    return new Promise((resolve) => {
      var reg;
      var check = () => {
        if (!(K.poll(node.kfd, {{{ cDefs.POLLOUT }}}) & mask)) return;
        reg.listeners.delete(reg.entry);
        var err = K.sys(L.SYS_getsockopt, node.kfd, L.SOL_SOCKET, L.SO_ERROR);
        resolve(err > 0 ? -K.errno(-err) : err < 0 ? -K.errno(err) : 0);
      };
      reg = node.addListener(check);
      check();
    });
  },

  __syscall_accept4__deps: ['$SHIRONET'],
  __syscall_accept4__async: 'auto',
  __syscall_accept4: (fd, addr, len, flags, u1, u2) => {
    var s = SHIRONET.get(fd), K = SHIRONET.K(), L = SHIRONET.L;
    var r = SHIRONET.retry(s, {{{ cDefs.POLLIN }}}, () => K.sys(L.SYS_accept4, s.node.kfd, L.SOCK_NONBLOCK | L.SOCK_CLOEXEC));
    return SHIRONET.after(r, (kfd) => {
      if (kfd < 0) return -K.errno(kfd);
      if (addr) SHIRONET.takeAddr(0, SHIRONET.addrLen(K.data, 0), addr, len);
      return SHIRONET.wrap(kfd, s.node.family, s.node.socktype, !!(flags & L.SOCK_NONBLOCK)).fd;
    });
  },

  __syscall_getsockname__deps: ['$SHIRONET'],
  __syscall_getsockname: (fd, addr, len, u1, u2, u3) => {
    var s = SHIRONET.get(fd);
    var n = SHIRONET.check(SHIRONET.K().sys(SHIRONET.L.SYS_getsockname, s.node.kfd));
    SHIRONET.takeAddr(0, n, addr, len);
    return 0;
  },

  __syscall_getpeername__deps: ['$SHIRONET'],
  __syscall_getpeername: (fd, addr, len, u1, u2, u3) => {
    var s = SHIRONET.get(fd);
    var n = SHIRONET.check(SHIRONET.K().sys(SHIRONET.L.SYS_getpeername, s.node.kfd));
    SHIRONET.takeAddr(0, n, addr, len);
    return 0;
  },

  __syscall_shutdown__deps: ['$SHIRONET'],
  __syscall_shutdown: (fd, how, u1, u2, u3, u4) => {
    var s = SHIRONET.get(fd);
    SHIRONET.check(SHIRONET.K().sys(SHIRONET.L.SYS_shutdown, s.node.kfd, how));
    return 0;
  },

  __syscall_setsockopt__deps: ['$SHIRONET'],
  __syscall_setsockopt: (fd, level, optname, optval, optlen, unused) => {
    var s = SHIRONET.get(fd), K = SHIRONET.K(), L = SHIRONET.L;
    var v = 0;
    if (level == L.SOL_SOCKET && (optname == L.SO_RCVTIMEO || optname == L.SO_SNDTIMEO) && optlen >= 12) {
      // struct timeval { 64-bit tv_sec; tv_usec } → milliseconds
      var sec = {{{ makeGetValue('optval', 0, 'i32') }}};
      var usec = {{{ makeGetValue('optval', 8, 'i32') }}};
      v = sec * 1000 + Math.floor(usec / 1000);
    } else if (optlen >= 4) {
      v = {{{ makeGetValue('optval', 0, 'i32') }}};
    } else if (optlen >= 1) {
      v = HEAPU8[optval];
    }
    var r = K.sys(L.SYS_setsockopt, s.node.kfd, level, optname, v);
    // Options the kernel doesn't model (IPV6_V6ONLY, SO_BROADCAST, ...) are accepted.
    if (r === -L.ENOPROTOOPT) return 0;
    return r < 0 ? -K.errno(r) : 0;
  },

  __syscall_getsockopt__deps: ['$SHIRONET'],
  __syscall_getsockopt: (fd, level, optname, optval, optlen, unused) => {
    var s = SHIRONET.get(fd), K = SHIRONET.K(), L = SHIRONET.L;
    var r = K.sys(L.SYS_getsockopt, s.node.kfd, level, optname);
    if (r === -L.ENOPROTOOPT) r = 0;
    if (r < 0) return -K.errno(r);
    {{{ makeSetValue('optval', 0, 'r', 'i32') }}};
    {{{ makeSetValue('optlen', 0, 4, 'i32') }}};
    return 0;
  },

  __syscall_sendto__deps: ['$SHIRONET'],
  __syscall_sendto__async: 'auto',
  __syscall_sendto: (fd, buf, len, flags, addr, alen) => {
    var s = SHIRONET.get(fd), K = SHIRONET.K(), L = SHIRONET.L;
    if (!addr) return SHIRONET.send(s, HEAPU8.slice(buf, buf + len), flags);
    if (len + alen > K.data.length) return -{{{ cDefs.EMSGSIZE }}};
    var payload = HEAPU8.slice(buf, buf + len);
    var sa = HEAPU8.slice(addr, addr + alen);
    var r = SHIRONET.retry(s, {{{ cDefs.POLLOUT }}}, () => {
      K.data.set(payload, 0);
      K.data.set(sa, len);
      return K.sys(L.SYS_sendto, s.node.kfd, len, flags | L.MSG_NOSIGNAL, alen);
    });
    return SHIRONET.after(r, (n) => n < 0 ? -K.errno(n) : n);
  },

  __syscall_recvfrom__deps: ['$SHIRONET'],
  __syscall_recvfrom__async: 'auto',
  __syscall_recvfrom: (fd, buf, len, flags, addr, alen) => {
    var s = SHIRONET.get(fd), K = SHIRONET.K(), L = SHIRONET.L;
    var n = Math.min(len, K.data.length - L.SOCKADDR_ROOM);
    var attempt = () => K.sys(L.SYS_recvfrom, s.node.kfd, n, flags & ~L.MSG_DONTWAIT);
    var r = (flags & L.MSG_DONTWAIT) ? attempt() : SHIRONET.retry(s, {{{ cDefs.POLLIN }}}, attempt);
    return SHIRONET.after(r, (got) => {
      if (got < 0) return -K.errno(got);
      HEAPU8.set(K.data.subarray(0, got), buf);
      if (addr) SHIRONET.takeAddr(n, SHIRONET.addrLen(K.data, n), addr, alen);
      return got;
    });
  },

  // msghdr (wasm32): name 0, namelen 4, iov 8, iovlen 12, control 16, controllen 20, flags 24
  __syscall_sendmsg__deps: ['$SHIRONET'],
  __syscall_sendmsg__async: 'auto',
  __syscall_sendmsg: (fd, message, flags, u1, u2, u3) => {
    var s = SHIRONET.get(fd), K = SHIRONET.K(), L = SHIRONET.L;
    var iov = {{{ makeGetValue('message', 8, '*') }}};
    var num = {{{ makeGetValue('message', 12, 'i32') }}};
    var parts = [], total = 0;
    for (var i = 0; i < num; i++) {
      var base = {{{ makeGetValue('iov', '8 * i', '*') }}};
      var len = {{{ makeGetValue('iov', '8 * i + 4', 'i32') }}};
      parts.push(HEAPU8.slice(base, base + len));
      total += len;
    }
    var bytes = new Uint8Array(total), off = 0;
    for (var p of parts) { bytes.set(p, off); off += p.length; }
    var name = {{{ makeGetValue('message', 0, '*') }}};
    var namelen = {{{ makeGetValue('message', 4, 'i32') }}};
    if (!name) return SHIRONET.send(s, bytes, flags);
    if (total + namelen > K.data.length) return -{{{ cDefs.EMSGSIZE }}};
    var sa = HEAPU8.slice(name, name + namelen);
    var r = SHIRONET.retry(s, {{{ cDefs.POLLOUT }}}, () => {
      K.data.set(bytes, 0);
      K.data.set(sa, total);
      return K.sys(L.SYS_sendto, s.node.kfd, total, flags | L.MSG_NOSIGNAL, namelen);
    });
    return SHIRONET.after(r, (n) => n < 0 ? -K.errno(n) : n);
  },

  __syscall_recvmsg__deps: ['$SHIRONET'],
  __syscall_recvmsg__async: 'auto',
  __syscall_recvmsg: (fd, message, flags, u1, u2, u3) => {
    var s = SHIRONET.get(fd), K = SHIRONET.K(), L = SHIRONET.L;
    var iov = {{{ makeGetValue('message', 8, '*') }}};
    var num = {{{ makeGetValue('message', 12, 'i32') }}};
    var want = 0;
    for (var i = 0; i < num; i++) want += {{{ makeGetValue('iov', '8 * i + 4', 'i32') }}};
    var n = Math.min(want, K.data.length - L.SOCKADDR_ROOM);
    var attempt = () => K.sys(L.SYS_recvfrom, s.node.kfd, n, flags & ~L.MSG_DONTWAIT);
    var r = (flags & L.MSG_DONTWAIT) ? attempt() : SHIRONET.retry(s, {{{ cDefs.POLLIN }}}, attempt);
    return SHIRONET.after(r, (got) => {
      if (got < 0) return -K.errno(got);
      var off = 0;
      for (var j = 0; j < num && off < got; j++) {
        var base = {{{ makeGetValue('iov', '8 * j', '*') }}};
        var len = Math.min({{{ makeGetValue('iov', '8 * j + 4', 'i32') }}}, got - off);
        HEAPU8.set(K.data.subarray(off, off + len), base);
        off += len;
      }
      var name = {{{ makeGetValue('message', 0, '*') }}};
      if (name) SHIRONET.takeAddr(n, SHIRONET.addrLen(K.data, n), name, message + 4);
      {{{ makeSetValue('message', 20, 0, 'i32') }}}; // msg_controllen
      {{{ makeSetValue('message', 24, 0, 'i32') }}}; // msg_flags
      return got;
    });
  },
};

for (const name of Object.keys(ShiroNetLibrary)) {
  if (name.startsWith('__syscall_')) wrapSyscallFunction(name, ShiroNetLibrary, false);
}

addToLibrary(ShiroNetLibrary);
