# Networking (phase 4)

Browsers have no TCP. Shiro gets real TCP from a WebSocket-to-TCP relay in
`server.mjs` and puts kernel sockets on top of it (`src/kernel/net.ts`).

```
guest (x86 / WASM / node net)                         server.mjs                     internet
  socket() connect() read() write()  ── WebSocket ──▶  /tcp relay  ── TCP ──▶  example.com:443
        src/kernel/net.ts KSocket       one WS per          egress policy,
                                        TCP connection      limits, logging
```

## Kernel side (`src/kernel/net.ts`)

- `netStack.socket(AF_INET | AF_INET6, SOCK_STREAM | SOCK_DGRAM [| SOCK_NONBLOCK])`
  returns a `KSocket` / `KDatagramSocket`, which implement the `OpenFile`
  surface from [KERNEL_ABI.md](KERNEL_ABI.md) (`read`, `write`, `poll`,
  `onReady`, `ioctl(FIONREAD)`, `stat`, `close`) plus the socket calls
  (`connect`, `bind`, `listen`, `accept`, `shutdown`, `send`/`recv` with
  `MSG_PEEK`/`MSG_DONTWAIT`/`MSG_WAITALL`, `getsockopt`/`setsockopt`,
  `getsockname`/`getpeername`). Errors are negative Linux errno values.
- Nonblocking connect returns `-EINPROGRESS`; completion shows up as `POLLOUT`
  (or `POLLERR` with the error in `SO_ERROR`), like Linux.
- Loopback (`127.0.0.0/8`, `::1`, `localhost`) never leaves the page: it
  reaches a socket listening in the same kernel. `socketpair()` gives two
  connected ends.
- `listen()` also publishes the port on Shiro's virtual-server table
  (`iframeServer.serve`, the table `http.createServer` uses). Each virtual HTTP
  request (preview pane, `iframeServer.fetch`) becomes an accepted connection
  carrying a raw HTTP/1.1 request with `Connection: close`; the guest's
  response is parsed back (Content-Length, chunked, or close-delimited). A
  guest HTTP server on port N is therefore reachable like any Shiro server.
- DNS: `netStack.resolve(host)` uses the relay's `resolve` op (which returns
  only addresses the relay would connect to), falling back to DNS-over-HTTPS.
  UDP datagrams to port 53 are answered by DoH (`application/dns-message`), so
  a guest libc's `getaddrinfo()` works unchanged. Other UDP gets `-ENETUNREACH`.
- Config: `netStack.configure({ relayUrl, tokenUrl, dohUrl, ... })`. Defaults
  are `wss://<page host>/tcp`, `https://<page host>/tcp/token`, and Cloudflare's
  DoH endpoint. `window.__shiroNet` is the stack in the page.
- Wired consumers: the x86 emulator (`src/x86/syscalls.ts`: socket, connect,
  accept/accept4, send/recv[from|msg], shutdown, bind, listen, get*name,
  socketpair, get/setsockopt, poll/ppoll, read/write/readv/writev, fcntl and
  FIONBIO for O_NONBLOCK, fstat S_IFSOCK) and node-compat `net`
  (`net.connect`, `net.Socket`, `net.createServer`), and WASM processes
  (preview1 `sock_*` and the WASIX socket calls plus `resolve`, through
  `netStackOf(kernel)`; curl runs HTTP/HTTPS this way). With no relay configured,
  x86 port-80 connects fall back to the old fetch-based HTTP emulation.
- `tls` in the Node shim stays inert: there is no userspace TLS there, and
  sending plaintext to a TLS port would be worse. Guests that bring their own
  TLS (OpenSSL/rustls/Go in x86 or WASM) get end-to-end TLS through the relay.

## Kernel syscalls (channel ABI)

`netSyscall(proc, nr, args, data, onSigpipe?)` in `net.ts` implements the
socket syscalls in the SAB-channel form of [KERNEL_ABI.md](KERNEL_ABI.md)
and returns `undefined` for numbers it doesn't own, so `kernel.syscall` can
forward its `default:` case to it. Sockets live in the process's `FdTable`
like any `OpenFile`; `read`/`write`/`poll`/`fstat`/`ioctl(FIONREAD)`/`fcntl`
already work through the generic paths, and blocked calls end with `-EINTR`
when `proc.syscallSignal` aborts.

| syscall | args | data in → out | result |
|---|---|---|---|
| socket (41) | domain, type (SOCK_NONBLOCK/SOCK_CLOEXEC ok), protocol | | fd |
| socketpair (53) | AF_UNIX, type | → int32 sv[2] | 0 |
| connect (42) / bind (49) | fd, addrLen | sockaddr | 0, -EINPROGRESS |
| listen (50) | fd, backlog | | 0 |
| accept (43) / accept4 (288) | fd (, flags) | → peer sockaddr | fd |
| getsockname (51) / getpeername (52) | fd | → sockaddr | sockaddr length |
| sendto (44) | fd, len, flags, addrLen | bytes, then sockaddr at offset len | n |
| recvfrom (45) | fd, len, flags | → bytes, sender sockaddr at offset len (28 bytes reserved) | n, 0 = EOF |
| shutdown (48) | fd, how | | 0 |
| setsockopt (54) | fd, level, name, value (int; SO_RCVTIMEO/SO_SNDTIMEO in ms) | | 0 |
| getsockopt (55) | fd, level, name | | value ≥ 0 or -errno |

sendmsg/recvmsg are left to the guest library (gather/scatter around
sendto/recvfrom); the x86 emulator implements them itself.

## Relay protocol (`/tcp`)

1. `POST /tcp/token` from an allowed Origin → `{ "token": "...", "expires": ms }`.
   The token is an HMAC over the expiry and the client IP.
2. WebSocket `GET /tcp?t=<token>` (Origin must be allowed).
3. First frame, text JSON:
   - `{"op":"connect","host":"example.com","port":443}` →
     `{"op":"connected","remoteAddress":"…","remotePort":443,"family":4}`
   - `{"op":"resolve","host":"example.com"}` →
     `{"op":"resolved","addresses":[{"address":"…","family":4}]}`, then close.
   - failures: `{"op":"error","code":"EACCES|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EDQUOT|…","message":"…"}`, then close.
4. After `connected`: binary frames carry the byte stream both ways (≤ 256 KiB
   per frame). Text control frames: client `{"op":"shutdown"}` (half-close,
   `SHUT_WR`) and `{"op":"ack","n":N}`; server `{"op":"eof"}` (peer FIN) and
   `{"op":"error",…}`. WebSocket close = TCP close.
5. Flow control: the relay stops reading from TCP while more than 512 KiB it
   sent is unacknowledged; the kernel acks every 64 KiB the application
   consumes. Client→server backpressure uses TCP `drain` and pauses the
   WebSocket.

## Security model

The egress policy is the security boundary; everything else limits abuse.

- **Address policy, after DNS.** Every address a name resolves to is checked;
  blocked: `0/8, 10/8, 100.64/10, 127/8, 169.254/16 (cloud metadata),
  172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15,
  198.51.100/24, 203.0.113/24, 224/4, 240/4`, and IPv6 `::/96, ::ffff:0:0/96,
  64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 2001::/23, 2001:db8::/32, 2002::/16,
  fc00::/7 (incl. fd00:ec2::254), fe80::/10, fec0::/10, ff00::/8`. Forms that
  embed IPv4 (mapped, NAT64, 6to4, Teredo) are blocked outright rather than
  decoded. `SHIRO_TCP_DENY_CIDRS` adds ranges (e.g. the host's own public
  address); `SHIRO_TCP_ALLOW_CIDRS` punches holes (tests, dev).
- **No DNS rebinding window.** The relay resolves once, checks, and dials the
  vetted IP literal; the connected peer address is checked again. Every
  connection resolves afresh, so a later rebind to a private address is caught.
- **Port allowlist.** Default `22, 80, 443, 9418` (ssh/git-over-ssh,
  http/https, git://). SMTP (25/465/587) and database ports stay closed: an
  open relay to mail ports is a spam cannon, and databases have no business
  being reached through a browser. Override with `SHIRO_TCP_PORTS`.
- **Caller checks.** Origin must match `SHIRO_TCP_ORIGINS` (default
  `https://shiro.computer,https://*.shiro.computer`), on both the token request
  and the WebSocket handshake, and the token must be valid, unexpired and
  issued to the same client IP. This keeps other websites' pages out; it does
  not stop a non-browser client that fakes an Origin, which is why the egress
  policy and limits are what actually bound the relay.
- **Limits** (env, defaults): concurrent connections per IP
  (`SHIRO_TCP_MAX_CONNS_PER_IP`, 16) and total (`SHIRO_TCP_MAX_CONNS`, 512),
  connection attempts per IP per minute (`SHIRO_TCP_CONNECTS_PER_MIN`, 60,
  resolves included), per-IP bandwidth (`SHIRO_TCP_BYTES_PER_SEC`, 4 MiB/s,
  burst `SHIRO_TCP_BYTE_BURST` 16 MiB; excess is throttled, not dropped),
  per-IP hourly bytes (`SHIRO_TCP_BYTES_PER_HOUR`, 4 GiB), per-connection
  bytes (`SHIRO_TCP_MAX_BYTES_PER_CONN`, 1 GiB), WebSocket frame size 256 KiB.
- **Timeouts:** request frame 10 s, TCP connect 15 s, idle 5 min
  (`SHIRO_TCP_IDLE_TIMEOUT_MS`), lifetime 4 h (`SHIRO_TCP_MAX_LIFETIME_MS`).
- **Client IP.** `X-Forwarded-For` is trusted only from a loopback peer
  (nginx on the same host; `SHIRO_TRUST_PROXY=loopback`, or `always`/`never`),
  and the rightmost entry is used, i.e. the address nginx saw.
- **Logging.** One line per connect, refusal and close: client IP, target
  host/IP:port, byte counts, duration, close reason. Never payloads.
- **Token secret.** Random per process unless `SHIRO_TCP_SECRET` is set (set
  it if several server processes sit behind one balancer).

## Enabling it

The relay is off unless `SHIRO_TCP_RELAY=1`. When off, `/tcp` and
`/tcp/token` return 404 and kernel sockets report `ENETUNREACH`.

systemd (`/etc/systemd/system/shiro.service`):

```ini
[Service]
Environment=SHIRO_TCP_RELAY=1
# Environment=SHIRO_TCP_DENY_CIDRS=<droplet public IPv4>/32,<droplet IPv6>/128
```

nginx needs the WebSocket upgrade for `/tcp` (and long timeouts, since a TCP
connection can idle up to the relay's own idle timeout):

```nginx
location = /tcp {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_buffering off;
}
location = /tcp/token {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

The `/channel/` peer relay needs the same `Upgrade`/`Connection` headers. (Its
handshakes used to fail: `ws`'s `path` option only matches exact strings, so
the regex never matched. Upgrades are now routed by path in `server.mjs`.)

## Tests

`tests/tests/shiro-vitest/kernel-net.test.ts` starts
`fixtures/tcp-relay-harness.mjs` in plain Node (a TCP echo server, relays from
`createTcpRelay`, and `server.mjs` itself configured only through env) and
drives kernel sockets, the x86 syscalls and node `net` against them: stream
round trips (1 MiB with flow control), nonblocking connect + poll, byte cap,
per-IP connection cap and connect rate, Origin/token checks, refusal of
private/loopback/link-local/metadata targets including names that resolve
into them, loopback listen/accept, and the iframeServer HTTP bridge.

## Kernel integration

- `installNet(kernel)` (called in `main.ts`) registers `netSyscall` for
  `SOCKET_SYSCALLS` via `kernel.registerSyscalls`; a send that fails with
  `EPIPE` without `MSG_NOSIGNAL` raises `SIGPIPE`. sendmsg/recvmsg fall through
  to `-ENOSYS` (guest libraries wrap sendto/recvfrom).
- Socket constants come from `abi.ts`; `net.ts` re-exports them.
- Sockets fire `onReady` on every readiness change (data, FIN, error, accept
  backlog, send-buffer drain), so `poll`, `select` and `epoll` (including
  `EPOLLET`) in `src/kernel/epoll.ts` work on them.
- The x86 emulator has `epoll_create`/`epoll_create1`/`epoll_ctl`/
  `epoll_wait`/`epoll_pwait` over socket and epoll fds using the kernel's
  `EpollFile`; its own files and pipes aren't kernel files, so adding them
  returns `EPERM`. Its socket/epoll fds hold kernel references
  (`retain`/`release`), so dup'd fds keep a description alive.

## Not done yet

- `SIGPIPE` in the x86 emulator (it has no signal delivery; sends return `-EPIPE`).
- AF_UNIX path sockets (only `socketpair`).
- UDP beyond DNS.
- `net.connect` to a port served by `http.createServer` (that server is not a
  kernel socket).
