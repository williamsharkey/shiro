/**
 * Guest program for kernel-core.test.ts. Bundled with esbuild and run in a
 * Node worker thread; every I/O goes through blocking syscalls on the SAB
 * channel. argv[1] picks the scenario.
 */
import { parentPort } from 'node:worker_threads';
import { connectGuest, isStartMessage, type GuestSys } from '../../../../src/kernel/channel';
import * as A from '../../../../src/kernel/abi';

// Browsers throw on TextDecoder.decode of shared memory; Node doesn't. Make
// this worker behave like a browser so the guest library is held to it.
const realDecode = TextDecoder.prototype.decode;
TextDecoder.prototype.decode = function (input?: AllowSharedBufferSource, opts?: TextDecodeOptions) {
  const buf = input && ArrayBuffer.isView(input) ? input.buffer : input;
  if (buf instanceof SharedArrayBuffer) throw new TypeError('decode: SharedArrayBuffer-backed input (browsers reject this)');
  return realDecode.call(this, input, opts);
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function main(sys: GuestSys, argv: string[]): number {
  switch (argv[1]) {
    case 'upper': {
      const input = sys.readAll(0);
      if (typeof input === 'number') return 2;
      sys.write(1, dec.decode(input).toUpperCase());
      return 0;
    }
    case 'exit': {
      return Number(argv[2]);
    }
    case 'info': {
      const info = sys.procInfo();
      sys.write(1, JSON.stringify({ pid: sys.getpid(), ppid: sys.getppid(), cwd: sys.getcwd(), argv: info.argv, home: info.env.HOME }) + '\n');
      return 0;
    }
    case 'pipe': {
      const p = sys.pipe();
      if (typeof p === 'number') return 3;
      const [r, w] = p;
      sys.write(w, 'through the pipe');
      sys.close(w);
      const got = sys.readAll(r);
      if (typeof got === 'number') return 4;
      sys.write(1, dec.decode(got) + '\n');
      return 0;
    }
    case 'files': {
      const fd = sys.open('/tmp/kguest.txt', A.O_CREAT | A.O_WRONLY | A.O_TRUNC, 0o644);
      if (fd < 0) return 10;
      sys.write(fd, 'hello kernel');
      sys.close(fd);
      const rfd = sys.open('/tmp/kguest.txt', A.O_RDONLY);
      const st = sys.fstat(rfd);
      if (typeof st === 'number') return 11;
      const pos = sys.lseek(rfd, 6, A.SEEK_SET);
      const buf = new Uint8Array(64);
      const n = sys.read(rfd, buf);
      sys.close(rfd);
      const missing = sys.open('/tmp/does-not-exist', A.O_RDONLY);
      sys.write(1, JSON.stringify({ size: st.size, isReg: (st.mode & A.S_IFMT) === A.S_IFREG, pos, tail: dec.decode(buf.subarray(0, n)), missing }) + '\n');
      return 0;
    }
    case 'spawn': {
      // posix_spawn(argv[2..]) with stdout on a pipe; read it all, then wait
      const p = sys.pipe(A.O_CLOEXEC);
      if (typeof p === 'number') return 20;
      const [r, w] = p;
      const pid = sys.spawn(argv[2], argv.slice(2), { fds: [[0, 0], [1, w], [2, 2]] });
      if (pid < 0) { sys.write(1, `spawn failed ${pid}\n`); return 21; }
      sys.close(w);
      const out = sys.readAll(r);
      const st = sys.waitpid(pid);
      sys.write(1, JSON.stringify({ pid: st.pid === pid, exited: A.WIFEXITED(st.status), code: A.WEXITSTATUS(st.status), out: typeof out === 'number' ? out : dec.decode(out) }) + '\n');
      return 0;
    }
    case 'block': {
      // Blocks forever reading stdin (an open pipe); the test kills us.
      sys.write(1, 'blocking\n');
      const buf = new Uint8Array(16);
      sys.read(0, buf);
      return 0;
    }
    case 'big': {
      // More bytes than the channel's data area: the guest library splits the write.
      const size = Number(argv[2]);
      const chunk = new Uint8Array(size);
      for (let i = 0; i < size; i++) chunk[i] = i & 0xff;
      const n = sys.write(1, chunk);
      return n === size ? 0 : 1;
    }
    case 'poll': {
      // Poll stdin with a timeout, then wait for it to become readable.
      const a = sys.poll([{ fd: 0, events: A.POLLIN }], 20);
      sys.write(1, `first ${a.ready}\n`);
      const b = sys.poll([{ fd: 0, events: A.POLLIN }], -1);
      const buf = new Uint8Array(64);
      const n = sys.read(0, buf);
      sys.write(1, `second ${b.ready} ${b.revents[0] & A.POLLIN ? 'in' : '-'} ${dec.decode(buf.subarray(0, n))}\n`);
      return 0;
    }
    case 'sleep': {
      const t = Date.now();
      sys.sleep(Number(argv[2]));
      sys.write(1, `${Date.now() - t}\n`);
      return 0;
    }
    case 'at': {
      // *at syscalls relative to a directory fd, symlinks, rename, utimensat, pread/pwrite
      const out: Record<string, unknown> = {};
      sys.mkdir('/tmp/kat');
      const dfd = sys.open('/tmp/kat', A.O_RDONLY | A.O_DIRECTORY);
      out.mkdirat = sys.mkdirat(dfd, 'sub');
      const fd = sys.openat(dfd, 'sub/f.txt', A.O_CREAT | A.O_RDWR | A.O_TRUNC, 0o600);
      sys.pwrite(fd, enc.encode('0123456789'), 0);
      sys.pwrite(fd, enc.encode('AB'), 4);
      const buf = new Uint8Array(4);
      const n = sys.pread(fd, buf, 3);
      out.pread = dec.decode(buf.subarray(0, n));
      out.posAfterPread = sys.lseek(fd, 0, A.SEEK_CUR);
      sys.close(fd);
      const st = sys.fstatat(dfd, 'sub/f.txt');
      out.size = typeof st === 'number' ? st : st.size;
      out.mode = typeof st === 'number' ? st : st.mode & 0o777;
      out.symlink = sys.symlinkat('sub/f.txt', dfd, 'link');
      out.readlink = sys.readlinkat(dfd, 'link');
      const lst = sys.fstatat(dfd, 'link', A.AT_SYMLINK_NOFOLLOW);
      out.isLink = typeof lst !== 'number' && (lst.mode & A.S_IFMT) === A.S_IFLNK;
      out.rename = sys.renameat(dfd, 'sub/f.txt', dfd, 'g.txt');
      out.noreplace = sys.renameat(dfd, 'g.txt', dfd, 'link', A.RENAME_NOREPLACE);
      out.utime = sys.utimensat(dfd, 'g.txt', 1_000_000_000_000, 1_000_000_000_000);
      const gst = sys.fstatat(dfd, 'g.txt');
      out.mtime = typeof gst === 'number' ? gst : gst.mtimeMs;
      sys.close(sys.openat(dfd, 'sub/keep', A.O_CREAT | A.O_WRONLY));
      out.rmdirNotEmpty = sys.unlinkat(dfd, 'sub', A.AT_REMOVEDIR);
      out.unlinkDir = sys.unlinkat(dfd, 'sub', 0);
      out.unlink = sys.unlinkat(dfd, 'link', 0);
      out.link = sys.linkat(dfd, 'g.txt', dfd, 'h.txt');
      out.linkExists = sys.linkat(dfd, 'g.txt', dfd, 'g.txt');
      const hst = sys.fstatat(dfd, 'h.txt');
      out.linked = typeof hst === 'number' ? hst : hst.size; // link() copies: the new name has the bytes
      sys.write(1, JSON.stringify(out) + '\n');
      return 0;
    }
    case 'signals': {
      const log: string[] = [];
      sys.ch.onSignal = sig => {
        const mask = sys.sigprocmask(A.SIG_BLOCK);
        log.push(`handler ${sig} masked=${Array.isArray(mask) && mask.includes(sig)}`);
      };
      const old = sys.sigaction(A.SIGUSR1, { handler: 7 });
      log.push(`old ${typeof old === 'number' ? old : old.handler}`);
      sys.kill(sys.getpid(), A.SIGUSR1);
      const after = sys.sigprocmask(A.SIG_BLOCK);
      log.push(`after masked=${Array.isArray(after) && after.includes(A.SIGUSR1)}`);
      // A blocked signal stays pending until unblocked
      sys.sigaction(A.SIGUSR2, { handler: 8 });
      sys.sigprocmask(A.SIG_BLOCK, [A.SIGUSR2]);
      sys.kill(sys.getpid(), A.SIGUSR2);
      log.push(`pending ${sys.sigpending().join(',')}`);
      sys.sigprocmask(A.SIG_UNBLOCK, [A.SIGUSR2]);
      log.push('unblocked');
      sys.getpid(); // the handler runs after this reply at the latest
      // SIG_IGN: delivered signals vanish; SIGKILL can't be caught
      sys.sigaction(A.SIGTERM, { handler: A.SIG_IGN });
      sys.kill(sys.getpid(), A.SIGTERM);
      log.push(`kill-handler ${sys.sigaction(A.SIGKILL, { handler: 9 })}`);
      // EINTR: a signal interrupts a blocked read
      const p = sys.pipe();
      if (typeof p === 'number') return 30;
      sys.write(1, JSON.stringify(log) + '\n');
      const r = sys.read(p[0], new Uint8Array(4));
      sys.write(1, `read ${r}\n`);
      return 0;
    }
    case 'epoll': {
      const out: Record<string, unknown> = {};
      const p = sys.pipe();
      if (typeof p === 'number') return 40;
      const [r, w] = p;
      const ep = sys.epollCreate(A.EPOLL_CLOEXEC);
      out.ctl = sys.epollCtl(ep, A.EPOLL_CTL_ADD, r, A.EPOLLIN | A.EPOLLET, 1234);
      out.dup = sys.epollCtl(ep, A.EPOLL_CTL_ADD, r, A.EPOLLIN);
      out.empty = sys.epollWait(ep, 8, 10);
      sys.write(w, 'x');
      out.ready = sys.epollWait(ep, 8, -1);
      out.edgeConsumed = sys.epollWait(ep, 8, 0);
      sys.write(w, 'y');
      out.edgeAgain = (sys.epollWait(ep, 8, 0) as { data: number }[]).length;
      out.mod = sys.epollCtl(ep, A.EPOLL_CTL_MOD, r, A.EPOLLIN, 99);
      out.level1 = (sys.epollWait(ep, 8, 0) as unknown[]).length;
      out.level2 = (sys.epollWait(ep, 8, 0) as unknown[]).length;
      const file = sys.open('/tmp/kguest-epoll', A.O_CREAT | A.O_RDWR);
      out.regular = sys.epollCtl(ep, A.EPOLL_CTL_ADD, file, A.EPOLLIN);
      const sel = sys.select(8, [r], [w], [], 0);
      out.select = typeof sel === 'number' ? sel : { n: sel.n, read: sel.read, write: sel.write };
      sys.read(r, new Uint8Array(8));
      const sel2 = sys.select(8, [r], [], [], 20);
      out.selectTimeout = typeof sel2 === 'number' ? sel2 : sel2.n;
      out.selectBad = sys.select(30, [25]);
      out.del = sys.epollCtl(ep, A.EPOLL_CTL_DEL, r);
      out.delAgain = sys.epollCtl(ep, A.EPOLL_CTL_DEL, r);
      sys.write(1, JSON.stringify(out) + '\n');
      return 0;
    }
    case 'spawn-inherit': {
      // posix_spawn without an fd map: the child inherits non-cloexec fds (here, stdout)
      const pid = sys.spawn('echo', ['echo', 'inherited']);
      const st = sys.waitpid(pid);
      return A.WEXITSTATUS(st.status);
    }
    case 'paths': {
      // Long, non-ASCII paths go through the kernel's decoder (must copy shared memory)
      const name = '/tmp/ünïcødé-' + 'x'.repeat(50) + '.txt';
      const fd = sys.open(name, A.O_CREAT | A.O_WRONLY);
      sys.write(fd, 'ok');
      sys.close(fd);
      const st = sys.stat(name);
      sys.write(1, `${fd >= 0} ${typeof st === 'number' ? st : st.size} ${sys.getcwd()}\n`);
      return 0;
    }
    default:
      sys.write(2, enc.encode(`unknown scenario ${argv[1]}\n`));
      return 64;
  }
}

parentPort!.once('message', m => {
  if (!isStartMessage(m)) return;
  const sys = connectGuest(m, x => parentPort!.postMessage(x));
  if (m.tid !== undefined) {
    // An extra thread (attachThread): report ids, then end just this thread
    sys.write(1, `thread tid=${sys.gettid()} pid=${sys.getpid()} start=${m.tid}\n`);
    sys.exitThread(0);
  }
  sys.exit(main(sys, m.argv));
});
