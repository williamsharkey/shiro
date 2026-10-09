/**
 * A shell running as a kernel process (`sh -c SCRIPT` spawned by a program,
 * a script started by the kernel) uses its fds 0-2 as its stdio
 * (src/shell-stdio.ts): kernel programs in the script get the fds, builtins
 * read fd 0 only when they need it (`read` one record at a time), and output
 * goes out as each command finishes. Before, the shell read stdin to EOF
 * first and wrote its output at exit, so a script talking to its peer over
 * pipes (git clone ↔ git-upload-pack) deadlocked.
 *
 * WASM guests run in Node worker_threads (as in kernel-shell.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import type { Kernel } from '@shiro/kernel/kernel';
import type { OpenFile } from '@shiro/kernel/fd';
import { Process } from '@shiro/kernel/process';
import { BufferFile } from '@shiro/kernel/fd';
import { createPipe } from '@shiro/kernel/pipe';
import { O_RDONLY } from '@shiro/kernel/abi';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import { setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import type { CommandContext } from '@shiro/commands/index';

const here = __dirname;
const fixtures = path.join(here, 'fixtures', 'wasi');
const srcWasi = path.resolve(here, '../../../src/wasi');
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-shstdio-'));
  const entry = path.join(tmp, 'entry.ts');
  writeFileSync(entry, `
    import { parentPort } from 'node:worker_threads';
    import { guestMain } from ${JSON.stringify(path.join(srcWasi, 'guest-worker.ts'))};
    const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
    parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
    guestMain(port);
  `);
  const workerFile = path.join(tmp, 'guest-worker.mjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: workerFile, logLevel: 'error' });
  setGuestWorkerFactory((): GuestWorker => {
    const w = new Worker(workerFile);
    return {
      postMessage: (m) => w.postMessage(m),
      terminate: () => w.terminate(),
      onMessage: (cb) => { w.on('message', cb); },
      onError: (cb) => { w.on('error', cb); },
    };
  });
  forceWasmProcessMode('sab');
}, 120_000);

afterAll(() => {
  setGuestWorkerFactory(null);
  forceWasmProcessMode(null);
  rmSync(tmp, { recursive: true, force: true });
});

let shell: Shell;
let fs: FileSystem;
let kernel: Kernel;

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  await fs.mkdir('/usr/local/bin', { recursive: true });
  await fs.mkdir('/tmp', { recursive: true });
  for (const p of ['ping', 'readloop', 'upper', 'fdwrite']) {
    await fs.writeFile(`/usr/local/bin/${p}`, new Uint8Array(readFileSync(path.join(fixtures, `${p}.wasm`))));
  }
  kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
});

/** posix_spawn as a guest would: find the program for `argv[0]`, spawn it with `fds` */
async function spawn(argv: string[], fds: Record<number, OpenFile>): Promise<Process> {
  const env = { ...shell.env, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const probe = new Process({ pid: -1, ppid: 1, path: argv[0], argv, env, cwd: '/tmp' });
  const run = await kernel.findProgram(argv[0], probe);
  if (!run) throw new Error(`${argv[0]}: not found`);
  return kernel.spawn({ path: argv[0], argv, env, cwd: '/tmp', fds, run });
}

/** Run argv with `input` on stdin; collect stdout and stderr */
async function run(argv: string[], input: string, ms = 20_000) {
  let out = '';
  let err = '';
  const p = await spawn(argv, {
    0: new BufferFile(input, O_RDONLY),
    1: new SinkFile((t) => { out += t; }),
    2: new SinkFile((t) => { err += t; }),
  });
  const status = await withTimeout(p.wait(), ms);
  return { out, err, status };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms (deadlock?)`)), ms))]);
}

describe('sh as a kernel process uses its fds', () => {
  it('talks to an interactive peer through `sh -c` (read, echo, a kernel program, cat)', async () => {
    // ping writes a line and waits for the reply before writing the next:
    // the script must answer the first before it has seen the rest
    const [toShR, toShW] = createPipe();
    const [toPingR, toPingW] = createPipe();
    let log = '';
    const ping = await spawn(['ping', '3'], { 0: toPingR, 1: toShW, 2: new SinkFile((t) => { log += t; }) });
    let err = '';
    const sh = await spawn(['sh', '-c', 'read first; echo "sh read: $first"; readloop; cat'],
      { 0: toShR, 1: toPingW, 2: new SinkFile((t) => { err += t; }) });
    const [pingStatus] = await withTimeout(Promise.all([ping.wait(), sh.wait()]), 20_000);
    expect(err).toBe('');
    expect(log).toBe('sh read: ping 1\ngot: ping 2\ngot: ping 3\nlines: 2\n');
    expect(pingStatus).toBe(0);
  }, 30_000);

  it('read takes one record at a time and leaves the rest', async () => {
    const r = await run(['sh', '-c', 'read a; read b; echo "$b-$a"; cat'], '1\n2\n3\n4\n');
    expect(r.err).toBe('');
    expect(r.out).toBe('2-1\n3\n4\n');
  });

  it('read -r, -d and -n read only what they need', async () => {
    const r = await run(['sh', '-c', 'read -r a; read -d : b; read -n 2 c; echo "[$a][$b][$c]"; cat'], 'x\\y\nfoo:barbaz\n');
    expect(r.out).toBe('[x\\y][foo][ba]\nrbaz\n');
  });

  it('a while-read loop reads line by line', async () => {
    const r = await run(['sh', '-c', 'while read l; do echo "<$l>"; done; echo end'], 'a\nb\n');
    expect(r.out).toBe('<a>\n<b>\nend\n');
  });

  it('kernel programs in the script get fd 0/1/2, in order with builtin output', async () => {
    const r = await run(['sh', '-c', 'echo before; mkdir -p /tmp/sx; upper; echo after'], 'mid\n');
    expect(r.out).toBe('before\nMID\nafter\n');
    expect(r.err).toBe('bytes: 4\n');
  });

  it('builtins that read stdin get fd 0; others leave it alone', async () => {
    let r = await run(['sh', '-c', 'cat | upper'], 'abc\n');
    expect(r.out).toBe('ABC\n');
    r = await run(['sh', '-c', 'echo x > /tmp/sx/f; cat /tmp/sx/f; wc -l'], '1\n2\n');
    expect(r.out).toBe('x\n2\n');
    r = await run(['sh', '-c', 'grep b; echo rc=$?'], 'a\nb\nc\n');
    expect(r.out).toBe('b\nrc=0\n');
  });

  it('a pipeline or redirect inside the script still gets strings', async () => {
    let r = await run(['sh', '-c', 'echo hi | upper; upper < /tmp/sx/f; x=$(upper); echo "[$x]"'], 'sub\n');
    expect(r.out).toBe('HI\nX\n[SUB]\n');
    // The piped subshell's stdin is the pipe, even for its later commands
    r = await run(['sh', '-c', 'printf "q\\n" | (cat; cat); echo done; cat'], 'outer\n');
    // (the in-page shell gives each command of the subshell the string; fd 0 stays untouched)
    expect(r.out).toMatch(/^(q\n)+done\nouter\n$/);
  });

  it('sh with no script reads it from stdin; bash -c works the same', async () => {
    let r = await run(['sh'], 'echo from-stdin\necho two\n');
    expect(r.out).toBe('from-stdin\ntwo\n');
    r = await run(['bash', '-c', 'read a; echo "a=$a"; upper'], 'one\ntwo\n');
    expect(r.out).toBe('a=one\nTWO\n');
  });

  it('a nested sh -c reads the same fd 0', async () => {
    const r = await run(['sh', '-c', 'read a; sh -c "read b; echo \\"b=\\$b\\""; read c; echo "a=$a c=$c"'], '1\n2\n3\n');
    expect(r.out).toBe('b=2\na=1 c=3\n');
  });

  it('a shell script started by the kernel reads its stdin as it goes', async () => {
    await fs.writeFile('/usr/local/bin/s.sh', '#!/bin/sh\nread a\necho "got $a"\nupper\n');
    await fs.chmod?.('/usr/local/bin/s.sh', 0o755);
    const r = await run(['/usr/local/bin/s.sh'], '1\nrest\n');
    expect(r.out).toBe('got 1\nREST\n');
  });
});

describe('fds 3-9 are inherited as they are', () => {
  it('a shell run by the kernel writes to its inherited fd 3, and so do programs it starts', async () => {
    let three = '';
    let out = '';
    const p = await spawn(['sh', '-c', 'echo a >&3; fdwrite 3 b; echo out'], {
      0: new BufferFile('', O_RDONLY), 1: new SinkFile((t) => { out += t; }), 2: new SinkFile(() => {}),
      3: new SinkFile((t) => { three += t; }),
    });
    await withTimeout(p.wait(), 20_000);
    expect(three).toBe('a\nb\n');
    expect(out).toBe('out\n');
  });

  it('exec 3>file and exec 4>&1 1>/dev/null reach programs the shell starts', async () => {
    let out = '';
    const st = await shell.execute('exec 3>/tmp/fd3.txt; fdwrite 3 c; fdwrite 3 d; cat /tmp/fd3.txt; exec 4>&1 1>/dev/null; fdwrite 4 e; echo hidden; exec 1>&4 3>&- 4>&-',
      (t) => { out += t; }, () => {});
    expect(out.replace(/\r\n/g, '\n')).toBe('c\nd\ne\n');
    expect(st).toBe(0);
  });
});

describe('the debconf confmodule protocol through a kernel-run sh', () => {
  it('exec 3>&1 1>&2, then commands on fd 3 and replies read from stdin', async () => {
    // What /usr/share/debconf/confmodule does; the frontend (here: this test)
    // reads commands from the script's fd 3 and answers on its stdin
    const script = [
      'exec 3>&1',
      'exec 1>&2',
      '_db_cmd () { printf "%s\\n" "$*" >&3; read -r line; RET="${line#[! \t][ \t]}"; return ${line%%[ \t]*}; }',
      'db_get () { _db_cmd "GET $@"; }',
      'db_input () { _db_cmd "INPUT $@"; }',
      'db_get adduser/homedir-permission; echo "stderr: $RET"',
      'db_input low adduser/x || true',
      'printf "%s\\n" "result $RET" >&3',
    ].join('\n');
    const [toShR, toShW] = createPipe();
    const [fromShR, fromShW] = createPipe();
    let err = '';
    const sh = await spawn(['sh', '-c', script], { 0: toShR, 1: fromShW, 2: new SinkFile((t) => { err += t; }) });
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const buf = new Uint8Array(256);
    const commands: string[] = [];
    let pending = '';
    const readLine = async (): Promise<string | null> => {
      for (;;) {
        const nl = pending.indexOf('\n');
        if (nl >= 0) { const l = pending.slice(0, nl); pending = pending.slice(nl + 1); return l; }
        const n = await fromShR.read(buf);
        if (n <= 0) return null;
        pending += dec.decode(buf.subarray(0, n));
      }
    };
    const frontend = (async () => {
      for (let l = await readLine(); l !== null; l = await readLine()) {
        commands.push(l);
        if (l.startsWith('GET')) await toShW.write(enc.encode('0 true\n'));
        else if (l.startsWith('INPUT')) await toShW.write(enc.encode('30 question skipped\n'));
      }
    })();
    await withTimeout(sh.wait(), 20_000);
    await toShW.close();
    await withTimeout(frontend, 5_000);
    expect(commands).toEqual(['GET adduser/homedir-permission', 'INPUT low adduser/x', 'result 30 question skipped']);
    expect(err).toBe('stderr: true\n');
  }, 30_000);
});

describe('named pipes opened with exec', () => {
  it('exec 3>fifo in a background subshell: a child sh and a kernel program write through it; the reader sees EOF', async () => {
    let out = '';
    const st = await withTimeout(shell.execute(
      "mkdir -p /tmp/fifo3 && cd /tmp/fifo3 && mkfifo p\n(exec 3>p; sh -c 'echo x >&3'; fdwrite 3 kern; echo y >&3) &\ncat < p",
      (t) => { out += t; }, () => {}), 20_000);
    expect(out.replace(/\r\n/g, '\n').replace(/^\[\d+\] \d+\n/gm, '')).toBe('x\nkern\ny\n');
    expect(st).toBe(0);
  }, 30_000);
});

describe('scripts that do nothing do not wait on stdin', () => {
  // dpkg-preconfigure runs ucf's empty config script with stdin on a pipe it keeps open
  it('an empty file without #!, `sh FILE` and `sh -c ""` exit without reading a live stdin', async () => {
    await fs.writeFile('/tmp/empty.cfg', '');
    await fs.chmod?.('/tmp/empty.cfg', 0o755);
    for (const argv of [['/tmp/empty.cfg', 'configure', ''], ['sh', '/tmp/empty.cfg'], ['sh', '-c', ''], ['sh', '-c', 'true']]) {
      const [r] = createPipe(); // the write end is never closed
      const p = await spawn(argv, { 0: r, 1: new SinkFile(() => {}), 2: new SinkFile(() => {}) });
      expect(await withTimeout(p.wait(), 5_000)).toBe(0);
    }
  }, 30_000);
});
