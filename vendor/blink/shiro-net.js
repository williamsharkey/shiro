/**
 * Shiro sockets for the Blink wasm build (an emscripten --js-library).
 *
 * Replaces emscripten's WebSocket-backed SOCKFS syscalls with in-process
 * stream sockets so a guest can talk to itself: AF_INET/AF_INET6 loopback
 * (127.0.0.0/8, ::1, localhost, wildcard binds) and AF_UNIX stream sockets.
 * Readiness goes through the FS node wait-queue, so poll() and emscripten's
 * epoll (which Go's netpoll uses, edge-triggered) see it.
 *
 * Other destinations go to Module.shiroNet.connect(sock, addr, port), the
 * hook for the kernel/TCP relay (docs/UNIX_COMPAT.md, phase 4); without it
 * connect fails with ENETUNREACH.
 *
 * Blocking sockets (no O_NONBLOCK) block in accept/connect/recv*: these
 * syscalls are proxied from the guest's pthread, so they can resolve
 * asynchronously. Plain read() on a blocking socket is handled by Blink,
 * which polls for POLLIN before reading.
 */

var ShiroNetLibrary = {
  $SHIRONET__deps: ['$FS'],
  $SHIRONET__postset: () => {
    addAtInit('SHIRONET.root = FS.mount(SHIRONET, {}, null);');
  },
  $SHIRONET: {
    root: null,
    nextId: 0,
    listeners: new Map(),   // key -> listening sock
    nextPort: 40000,
    mount(mount) {
      return FS.createNode(null, '/', {{{ cDefs.S_IFDIR }}} | 0o777, 0);
    },

    isLoopback(family, addr) {
      if (family == {{{ cDefs.AF_UNIX }}}) return true;
      return addr === undefined || addr === '' || addr === 'localhost' ||
        addr === '0.0.0.0' || addr === '::' || addr === '::1' ||
        /^127\./.test(addr) || /^::ffff:127\./.test(addr);
    },
    key(family, port, path) {
      return family == {{{ cDefs.AF_UNIX }}} ? 'unix:' + path : 'inet:' + port;
    },

    create(family, type, protocol) {
      var flags = {{{ cDefs.O_RDWR }}};
      if (type & {{{ cDefs.SOCK_NONBLOCK }}}) flags |= {{{ cDefs.O_NONBLOCK }}};
      type &= ~({{{ cDefs.SOCK_NONBLOCK }}} | {{{ cDefs.SOCK_CLOEXEC }}});
      if (family != {{{ cDefs.AF_INET }}} && family != {{{ cDefs.AF_INET6 }}} && family != {{{ cDefs.AF_UNIX }}}) {
        throw new FS.ErrnoError({{{ cDefs.EAFNOSUPPORT }}});
      }
      if (type != {{{ cDefs.SOCK_STREAM }}} && type != {{{ cDefs.SOCK_DGRAM }}}) {
        throw new FS.ErrnoError({{{ cDefs.EPROTONOSUPPORT }}});
      }
      var sock = {
        family, type, protocol,
        state: 'new',           // new | listening | connected | closed
        saddr: undefined, sport: 0, spath: '',
        daddr: undefined, dport: 0, dpath: '',
        rx: [], rxBytes: 0,
        peer: null,
        eof: false,             // peer shut down its write side or closed
        wrShut: false,
        backlog: [],
        error: 0,
        opts: {},
      };
      var node = FS.createNode(SHIRONET.root, 'socket[' + (SHIRONET.nextId++) + ']', {{{ cDefs.S_IFSOCK }}} | 0o777, 0);
      node.sock = sock;
      sock.node = node;
      sock.stream = FS.createStream({ path: node.name, node, flags, seekable: false, stream_ops: SHIRONET.stream_ops });
      return sock;
    },

    notify(sock, flags) {
      sock.node.notifyListeners(flags);
    },

    pollMask(sock) {
      var m = 0;
      if (sock.state == 'listening') {
        if (sock.backlog.length) m |= {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLRDNORM }}};
        return m;
      }
      if (sock.rxBytes) m |= {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLRDNORM }}};
      if (sock.eof) m |= {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLRDHUP }}};
      if (sock.state == 'connected' && !sock.wrShut && sock.peer) m |= {{{ cDefs.POLLOUT }}} | {{{ cDefs.POLLWRNORM }}};
      if (sock.state == 'connected' && !sock.peer) m |= {{{ cDefs.POLLHUP }}};
      if (sock.error) m |= {{{ cDefs.POLLERR }}};
      if (sock.state == 'new' && sock.type == {{{ cDefs.SOCK_STREAM }}}) m |= {{{ cDefs.POLLOUT }}} | {{{ cDefs.POLLHUP }}};
      return m;
    },

    // Wait (proxied pthread caller only) until `ready()` is true, then run `done()`.
    block(sock, ready, done) {
      if (ready()) return done();
      if (sock.stream.flags & {{{ cDefs.O_NONBLOCK }}}) throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
      return new Promise((resolve) => {
        var reg = sock.node.addListener(() => {
          if (!ready()) return;
          reg.listeners.delete(reg.entry);
          try { resolve(done()); } catch (e) {
            if (e.name !== 'ErrnoError') throw e;
            resolve(-e.errno);
          }
        });
      });
    },

    bind(sock, addr, port, path) {
      if (sock.family == {{{ cDefs.AF_UNIX }}}) {
        if (SHIRONET.listeners.has(SHIRONET.key(sock.family, 0, path))) throw new FS.ErrnoError({{{ cDefs.EADDRINUSE }}});
        sock.spath = path;
        return;
      }
      if (!port) port = SHIRONET.ephemeral();
      else if (SHIRONET.listeners.has(SHIRONET.key(sock.family, port))) throw new FS.ErrnoError({{{ cDefs.EADDRINUSE }}});
      sock.saddr = addr || (sock.family == {{{ cDefs.AF_INET6 }}} ? '::' : '0.0.0.0');
      sock.sport = port;
    },

    ephemeral() {
      for (var i = 0; i < 20000; i++) {
        var p = SHIRONET.nextPort++;
        if (SHIRONET.nextPort > 60999) SHIRONET.nextPort = 40000;
        if (!SHIRONET.listeners.has('inet:' + p)) return p;
      }
      throw new FS.ErrnoError({{{ cDefs.EADDRINUSE }}});
    },

    listen(sock) {
      if (sock.type != {{{ cDefs.SOCK_STREAM }}}) throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
      if (sock.state == 'listening') return;
      if (sock.family != {{{ cDefs.AF_UNIX }}} && !sock.sport) SHIRONET.bind(sock, undefined, 0);
      var key = SHIRONET.key(sock.family, sock.sport, sock.spath);
      if (SHIRONET.listeners.has(key)) throw new FS.ErrnoError({{{ cDefs.EADDRINUSE }}});
      SHIRONET.listeners.set(key, sock);
      sock.state = 'listening';
    },

    connect(sock, addr, port, path) {
      if (sock.state == 'connected') throw new FS.ErrnoError({{{ cDefs.EISCONN }}});
      if (!SHIRONET.isLoopback(sock.family, addr)) {
        var hook = Module['shiroNet'];
        if (hook && hook.connect) return hook.connect(sock, addr, port);
        throw new FS.ErrnoError({{{ cDefs.ENETUNREACH }}});
      }
      var listener = SHIRONET.listeners.get(SHIRONET.key(sock.family, port, path));
      if (!listener) throw new FS.ErrnoError({{{ cDefs.ECONNREFUSED }}});
      var loop = sock.family == {{{ cDefs.AF_INET6 }}} ? '::1' : '127.0.0.1';
      if (sock.family != {{{ cDefs.AF_UNIX }}}) {
        if (!sock.sport) sock.sport = SHIRONET.ephemeral();
        sock.saddr = loop;
      }
      var server = SHIRONET.create(sock.family, sock.type, sock.protocol);
      server.state = sock.state = 'connected';
      server.peer = sock;
      sock.peer = server;
      server.saddr = loop; server.sport = listener.sport; server.spath = listener.spath;
      server.daddr = sock.saddr; server.dport = sock.sport; server.dpath = sock.spath;
      sock.daddr = addr || loop; sock.dport = port; sock.dpath = path || '';
      // The accepted end is not in the fd table until accept() installs it.
      FS.closeStream(server.stream.fd);
      server.stream.fd = -1;
      listener.backlog.push(server);
      SHIRONET.notify(listener, {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLRDNORM }}});
      SHIRONET.notify(sock, {{{ cDefs.POLLOUT }}} | {{{ cDefs.POLLWRNORM }}});
    },

    accept(listener, flags) {
      if (listener.state != 'listening') throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      var sock = listener.backlog.shift();
      var sflags = {{{ cDefs.O_RDWR }}};
      if (flags & {{{ cDefs.SOCK_NONBLOCK }}}) sflags |= {{{ cDefs.O_NONBLOCK }}};
      sock.stream = FS.createStream({ path: sock.node.name, node: sock.node, flags: sflags, seekable: false, stream_ops: SHIRONET.stream_ops });
      if (sock.rxBytes || sock.eof) SHIRONET.notify(sock, SHIRONET.pollMask(sock));
      return sock;
    },

    send(sock, bytes) {
      if (sock.state != 'connected') throw new FS.ErrnoError({{{ cDefs.ENOTCONN }}});
      if (sock.wrShut || !sock.peer) throw new FS.ErrnoError({{{ cDefs.EPIPE }}});
      if (!bytes.length) return 0;
      var peer = sock.peer;
      if (peer.remote) return peer.remote.send(bytes);
      peer.rx.push(bytes.slice());
      peer.rxBytes += bytes.length;
      SHIRONET.notify(peer, {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLRDNORM }}});
      return bytes.length;
    },

    // Receive up to `len` bytes; null on EOF.
    recv(sock, len, peek) {
      if (!sock.rxBytes) {
        if (sock.eof || sock.state != 'connected') return null;
        throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
      }
      var out = new Uint8Array(Math.min(len, sock.rxBytes));
      var off = 0, i = 0;
      while (off < out.length) {
        var chunk = sock.rx[i];
        var n = Math.min(chunk.length, out.length - off);
        out.set(chunk.subarray(0, n), off);
        off += n;
        if (peek) { i++; continue; }
        if (n == chunk.length) sock.rx.shift();
        else sock.rx[0] = chunk.subarray(n);
      }
      if (!peek) sock.rxBytes -= out.length;
      return out;
    },

    // Deliver data from outside (the relay hook) into a socket.
    deliver(sock, bytes) {
      if (bytes === null) sock.eof = true;
      else { sock.rx.push(bytes); sock.rxBytes += bytes.length; }
      SHIRONET.notify(sock, SHIRONET.pollMask(sock));
    },

    shutdownWrite(sock) {
      if (sock.wrShut) return;
      sock.wrShut = true;
      var peer = sock.peer;
      if (peer) {
        if (peer.remote) peer.remote.shutdown?.();
        peer.eof = true;
        SHIRONET.notify(peer, {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLRDHUP }}});
      }
    },

    close(sock) {
      if (sock.state == 'listening') {
        SHIRONET.listeners.delete(SHIRONET.key(sock.family, sock.sport, sock.spath));
        for (var pending of sock.backlog) SHIRONET.close(pending);
        sock.backlog = [];
      }
      SHIRONET.shutdownWrite(sock);
      var peer = sock.peer;
      if (peer) {
        if (peer.remote) peer.remote.close?.();
        peer.peer = null;
        SHIRONET.notify(peer, {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLHUP }}} | {{{ cDefs.POLLRDHUP }}});
      }
      sock.peer = null;
      sock.state = 'closed';
    },

    stream_ops: {
      getattr(stream) {
        return { dev: 1, ino: stream.node.id, mode: {{{ cDefs.S_IFSOCK }}} | 0o777, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0,
          atime: new Date(0), mtime: new Date(0), ctime: new Date(0), blksize: 4096, blocks: 0 };
      },
      poll(stream) { return SHIRONET.pollMask(stream.node.sock); },
      ioctl(stream, request, argp) {
        if (request == {{{ cDefs.FIONREAD }}}) {
          {{{ makeSetValue('argp', 0, 'stream.node.sock.rxBytes', 'i32') }}};
          return 0;
        }
        return -{{{ cDefs.ENOTTY }}};
      },
      read(stream, buffer, offset, length) {
        var msg = SHIRONET.recv(stream.node.sock, length);
        if (!msg) return 0;
        buffer.set(msg, offset);
        return msg.length;
      },
      write(stream, buffer, offset, length) {
        return SHIRONET.send(stream.node.sock, buffer.subarray(offset, offset + length));
      },
      close(stream) {
        SHIRONET.close(stream.node.sock);
      },
    },

    get(fd) {
      var stream = FS.getStream(fd);
      if (!stream) throw new FS.ErrnoError({{{ cDefs.EBADF }}});
      if (!stream.node.sock) throw new FS.ErrnoError({{{ cDefs.ENOTSOCK }}});
      return stream.node.sock;
    },

    readAddr(sa, salen) {
      var family = HEAPU8[sa] | (HEAPU8[sa + 1] << 8);
      var port = (HEAPU8[sa + 2] << 8) | HEAPU8[sa + 3];
      if (family == {{{ cDefs.AF_INET }}}) {
        return { family, port, addr: [HEAPU8[sa + 4], HEAPU8[sa + 5], HEAPU8[sa + 6], HEAPU8[sa + 7]].join('.') };
      }
      if (family == {{{ cDefs.AF_INET6 }}}) {
        var parts = [];
        for (var i = 0; i < 8; i++) parts.push(((HEAPU8[sa + 8 + 2 * i] << 8) | HEAPU8[sa + 9 + 2 * i]).toString(16));
        var addr = parts.join(':');
        if (addr == '0:0:0:0:0:0:0:1') addr = '::1';
        else if (addr == '0:0:0:0:0:0:0:0') addr = '::';
        else if (/^0:0:0:0:0:ffff:/.test(addr)) {
          addr = '::ffff:' + [HEAPU8[sa + 20], HEAPU8[sa + 21], HEAPU8[sa + 22], HEAPU8[sa + 23]].join('.');
        }
        return { family, port, addr };
      }
      if (family == {{{ cDefs.AF_UNIX }}}) {
        var path = '';
        for (var j = sa + 2; j < sa + salen && HEAPU8[j]; j++) path += String.fromCharCode(HEAPU8[j]);
        if (salen > 2 && !HEAPU8[sa + 2]) {
          path = '\0';
          for (var k = sa + 3; k < sa + salen; k++) path += String.fromCharCode(HEAPU8[k]);
        }
        return { family, port: 0, addr: '', path };
      }
      throw new FS.ErrnoError({{{ cDefs.EAFNOSUPPORT }}});
    },

    writeAddr(sa, lenp, family, addr, port, path) {
      if (!sa) return;
      var buf = new Uint8Array(110);
      buf[0] = family & 255; buf[1] = family >> 8;
      var n;
      if (family == {{{ cDefs.AF_UNIX }}}) {
        path = path || '';
        for (var i = 0; i < path.length; i++) buf[2 + i] = path.charCodeAt(i) & 255;
        n = 2 + path.length + (path && path[0] != '\0' ? 1 : 0);
      } else {
        buf[2] = (port >> 8) & 255; buf[3] = port & 255;
        if (family == {{{ cDefs.AF_INET }}}) {
          var v4 = (addr && /^\d+\.\d+\.\d+\.\d+$/.test(addr) ? addr : '0.0.0.0').split('.');
          for (var j = 0; j < 4; j++) buf[4 + j] = +v4[j];
          n = 16;
        } else {
          var a = addr || '::';
          if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) a = '::ffff:' + a;
          var m = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
          if (m) { buf[18] = buf[19] = 255; for (var k = 0; k < 4; k++) buf[20 + k] = +m[k + 1]; }
          else if (a == '::1') buf[23] = 1;
          n = 28;
        }
      }
      var cap = {{{ makeGetValue('lenp', 0, 'i32') }}};
      for (var x = 0; x < Math.min(cap, n); x++) HEAPU8[sa + x] = buf[x];
      {{{ makeSetValue('lenp', 0, 'n', 'i32') }}};
    },
  },

  __syscall_socket__deps: ['$SHIRONET'],
  __syscall_socket: (domain, type, protocol, u1, u2, u3) => {
    // Block bodies only: wrapSyscallFunction() re-wraps the body and drops
    // the implicit return of a concise arrow.
    return SHIRONET.create(domain, type, protocol).stream.fd;
  },

  __syscall_bind__deps: ['$SHIRONET'],
  __syscall_bind: (fd, addr, len, u1, u2, u3) => {
    var sock = SHIRONET.get(fd);
    var info = SHIRONET.readAddr(addr, len);
    SHIRONET.bind(sock, info.addr, info.port, info.path);
    return 0;
  },

  __syscall_listen__deps: ['$SHIRONET'],
  __syscall_listen: (fd, backlog, u1, u2, u3, u4) => {
    SHIRONET.listen(SHIRONET.get(fd));
    return 0;
  },

  __syscall_connect__deps: ['$SHIRONET'],
  __syscall_connect__async: 'auto',
  __syscall_connect: (fd, addr, len, u1, u2, u3) => {
    var sock = SHIRONET.get(fd);
    var info = SHIRONET.readAddr(addr, len);
    var r = SHIRONET.connect(sock, info.addr, info.port, info.path);
    return r === undefined ? 0 : r;
  },

  __syscall_accept4__deps: ['$SHIRONET'],
  __syscall_accept4__async: 'auto',
  __syscall_accept4: (fd, addr, len, flags, u1, u2) => {
    var listener = SHIRONET.get(fd);
    return SHIRONET.block(listener, () => listener.backlog.length > 0 || listener.state != 'listening', () => {
      var sock = SHIRONET.accept(listener, flags);
      if (addr) SHIRONET.writeAddr(addr, len, sock.family, sock.daddr, sock.dport, sock.dpath);
      return sock.stream.fd;
    });
  },

  __syscall_getsockname__deps: ['$SHIRONET'],
  __syscall_getsockname: (fd, addr, len, u1, u2, u3) => {
    var sock = SHIRONET.get(fd);
    SHIRONET.writeAddr(addr, len, sock.family, sock.saddr, sock.sport, sock.spath);
    return 0;
  },

  __syscall_getpeername__deps: ['$SHIRONET'],
  __syscall_getpeername: (fd, addr, len, u1, u2, u3) => {
    var sock = SHIRONET.get(fd);
    if (sock.state != 'connected') return -{{{ cDefs.ENOTCONN }}};
    SHIRONET.writeAddr(addr, len, sock.family, sock.daddr, sock.dport, sock.dpath);
    return 0;
  },

  __syscall_shutdown__deps: ['$SHIRONET'],
  __syscall_shutdown: (fd, how, u1, u2, u3, u4) => {
    var sock = SHIRONET.get(fd);
    if (sock.state != 'connected') return -{{{ cDefs.ENOTCONN }}};
    if (how != 0) SHIRONET.shutdownWrite(sock);           // SHUT_WR / SHUT_RDWR
    return 0;
  },

  __syscall_setsockopt__deps: ['$SHIRONET'],
  __syscall_setsockopt: (fd, level, optname, optval, optlen, unused) => {
    var sock = SHIRONET.get(fd);
    sock.opts[level + ':' + optname] = optlen >= 4 ? {{{ makeGetValue('optval', 0, 'i32') }}} : 0;
    return 0;
  },

  __syscall_getsockopt__deps: ['$SHIRONET'],
  __syscall_getsockopt: (fd, level, optname, optval, optlen, unused) => {
    var sock = SHIRONET.get(fd);
    var v = sock.opts[level + ':' + optname] || 0;
    if (level == {{{ cDefs.SOL_SOCKET }}}) {
      if (optname == {{{ cDefs.SO_ERROR }}}) { v = sock.error; sock.error = 0; }
      else if (optname == 3 /* SO_TYPE */) v = sock.type;
      else if (optname == 7 /* SO_SNDBUF */ || optname == 8 /* SO_RCVBUF */) v = v || 212992;
    }
    {{{ makeSetValue('optval', 0, 'v', 'i32') }}};
    {{{ makeSetValue('optlen', 0, 4, 'i32') }}};
    return 0;
  },

  __syscall_sendto__deps: ['$SHIRONET'],
  __syscall_sendto: (fd, buf, len, flags, addr, alen) => {
    var sock = SHIRONET.get(fd);
    return SHIRONET.send(sock, HEAPU8.subarray(buf, buf + len));
  },

  __syscall_recvfrom__deps: ['$SHIRONET'],
  __syscall_recvfrom__async: 'auto',
  __syscall_recvfrom: (fd, buf, len, flags, addr, alen) => {
    var sock = SHIRONET.get(fd);
    var peek = !!(flags & 2 /* MSG_PEEK */);
    var nonblock = !!(flags & 0x40 /* MSG_DONTWAIT */);
    var ready = () => sock.rxBytes > 0 || sock.eof || sock.state != 'connected';
    var done = () => {
      var msg = SHIRONET.recv(sock, len, peek);
      if (!msg) return 0;
      HEAPU8.set(msg, buf);
      if (addr) SHIRONET.writeAddr(addr, alen, sock.family, sock.daddr, sock.dport, sock.dpath);
      return msg.length;
    };
    if (nonblock && !ready()) return -{{{ cDefs.EAGAIN }}};
    return SHIRONET.block(sock, ready, done);
  },

  __syscall_sendmsg__deps: ['$SHIRONET'],
  __syscall_sendmsg: (fd, message, flags, u1, u2, u3) => {
    var sock = SHIRONET.get(fd);
    var iov = {{{ makeGetValue('message', 8, '*') }}};
    var num = {{{ makeGetValue('message', 12, 'i32') }}};
    var total = 0;
    for (var i = 0; i < num; i++) {
      var base = {{{ makeGetValue('iov', '8 * i', '*') }}};
      var n = {{{ makeGetValue('iov', '8 * i + 4', 'i32') }}};
      total += SHIRONET.send(sock, HEAPU8.subarray(base, base + n));
    }
    return total;
  },

  __syscall_recvmsg__deps: ['$SHIRONET'],
  __syscall_recvmsg__async: 'auto',
  __syscall_recvmsg: (fd, message, flags, u1, u2, u3) => {
    var sock = SHIRONET.get(fd);
    var iov = {{{ makeGetValue('message', 8, '*') }}};
    var num = {{{ makeGetValue('message', 12, 'i32') }}};
    var want = 0;
    for (var i = 0; i < num; i++) want += {{{ makeGetValue('iov', '8 * i + 4', 'i32') }}};
    var ready = () => sock.rxBytes > 0 || sock.eof || sock.state != 'connected';
    var done = () => {
      var msg = SHIRONET.recv(sock, want, false);
      if (!msg) return 0;
      var off = 0;
      for (var j = 0; j < num && off < msg.length; j++) {
        var base = {{{ makeGetValue('iov', '8 * j', '*') }}};
        var n = Math.min({{{ makeGetValue('iov', '8 * j + 4', 'i32') }}}, msg.length - off);
        HEAPU8.set(msg.subarray(off, off + n), base);
        off += n;
      }
      {{{ makeSetValue('message', 20, 0, 'i32') }}}; // msg_controllen
      {{{ makeSetValue('message', 24, 0, 'i32') }}}; // msg_flags
      return msg.length;
    };
    if ((flags & 0x40) && !ready()) return -{{{ cDefs.EAGAIN }}};
    return SHIRONET.block(sock, ready, done);
  },
};

for (const name of Object.keys(ShiroNetLibrary)) {
  if (name.startsWith('__syscall_')) wrapSyscallFunction(name, ShiroNetLibrary, false);
}

addToLibrary(ShiroNetLibrary);
