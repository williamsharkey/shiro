/**
 * Guest program for kernel-core.test.ts. Bundled with esbuild and run in a
 * Node worker thread; every I/O goes through blocking syscalls on the SAB
 * channel. argv[1] picks the scenario.
 */
import { parentPort } from 'node:worker_threads';
import { connectGuest, isStartMessage, type GuestSys } from '../../../../src/kernel/channel';
import * as A from '../../../../src/kernel/abi';

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
    default:
      sys.write(2, enc.encode(`unknown scenario ${argv[1]}\n`));
      return 64;
  }
}

parentPort!.once('message', m => {
  if (!isStartMessage(m)) return;
  const sys = connectGuest(m, x => parentPort!.postMessage(x));
  sys.exit(main(sys, m.argv));
});
