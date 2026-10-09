/**
 * Popular Unix tools in Shiro (docs/COMPAT.md): one smoke test per scoreboard
 * entry. Each installs the real package with `pkg install` (files served
 * from public/pkg like shiro.computer does; other downloads cached in
 * tests/.pkg-cache) and runs it from the shell as a kernel process, on a
 * terminal pty for the interactive ones: raw mode, alternate screen,
 * resize, Ctrl-C/Ctrl-Z.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import { setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import { TtySession } from '@shiro/kernel/pty';
import { createTestShell } from './helpers';
import { jobsCmd, fgCmd, bgCmd, waitCmd } from '@shiro/commands/jobs';
import { installPathShims } from '@shiro/path-shims';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

const REPO = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/\/$/, '');
const CACHE = `${REPO}/tests/.pkg-cache`;
const realFetch = globalThis.fetch;

/** "/pkg/..." from public/pkg; https downloads once, then from tests/.pkg-cache. */
async function fakeFetch(input: any): Promise<Response> {
  const url = String(input);
  const m = url.match(/^https?:\/\/[^/]+(\/pkg\/.*)$/);
  if (m) {
    const file = `${REPO}/public${m[1]}`;
    return existsSync(file) ? new Response(readFileSync(file)) : new Response('not found', { status: 404 });
  }
  if (url.startsWith('https://')) {
    const file = `${CACHE}/${url.replace(/^https:\/\//, '').replace(/[^A-Za-z0-9._-]/g, '_')}`;
    if (!existsSync(file)) {
      const resp = await realFetch(url);
      if (!resp.ok) return resp;
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(file, new Uint8Array(await resp.arrayBuffer()));
    }
    return new Response(readFileSync(file));
  }
  return new Response('no route', { status: 404 });
}

/** A terminal with a pty session; `screen` is everything the programs wrote to it. */
function fakeTerminal(rows = 24, cols = 80) {
  const tty = new TtySession();
  tty.resize(rows, cols);
  let screen = '';
  tty.pty.onOutput((b) => {
    const s = new TextDecoder().decode(b);
    screen += s;
    // answer what xterm.js answers: cursor position (fzf --height), device attributes (tmux)
    if (s.includes('\x1b[6n')) queueMicrotask(() => tty.pty.input(`\x1b[${tty.pty.winsize.rows};1R`));
    if (/\x1b\[0?c/.test(s)) queueMicrotask(() => tty.pty.input('\x1b[?1;2c'));
    if (/\x1b\[>0?c/.test(s)) queueMicrotask(() => tty.pty.input('\x1b[>0;276;0c'));
    if (s.includes('\x1b[>q')) queueMicrotask(() => tty.pty.input('\x1bP>|xterm.js(5.5.0)\x1b\\'));
    if (s.includes('\x1b[?2026$p')) queueMicrotask(() => tty.pty.input('\x1b[?2026;2$y'));
    if (s.includes('\x1b]10;?')) queueMicrotask(() => tty.pty.input('\x1b]10;rgb:ffff/ffff/ffff\x1b\\'));
    if (s.includes('\x1b]11;?')) queueMicrotask(() => tty.pty.input('\x1b]11;rgb:0000/0000/0000\x1b\\'));
  });
  return {
    tty,
    get screen() { return screen; },
    clear() { screen = ''; },
    type(s: string) { tty.pty.input(s); },
    writeOutput: (s: string) => { screen += s; },
    enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {},
    isRawMode: () => false, onResize: () => () => {},
    getSize: () => ({ rows: tty.pty.winsize.rows, cols: tty.pty.winsize.cols }),
    term: null,
  };
}
type Term = ReturnType<typeof fakeTerminal>;
let lastScreen: (() => string) | undefined;

async function until(cond: () => boolean, what: string, ms = 90_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}` + (process.env.SCREEN ? ': ' + JSON.stringify(lastScreen?.()) : ''));
    await new Promise((r) => setTimeout(r, 10));
  }
}

let shell: Shell;
let fs: FileSystem;

async function sh(cmd: string) {
  let out = '';
  let err = '';
  const exitCode = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), exitCode };
}

/** Start `cmd` in the foreground of a fresh terminal; resolves when it exits. */
function onTerminal(cmd: string, term: Term = fakeTerminal()) {
  lastScreen = () => term.screen.slice(-3000);
  const done = shell.execute(cmd, (s) => term.writeOutput(s), (s) => term.writeOutput(s), false, term as any);
  return { term, done };
}

async function install(...names: string[]) {
  const r = await sh(`pkg install ${names.join(' ')}`);
  expect(r.err).toBe('');
  expect(r.exitCode).toBe(0);
}

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  for (const c of [jobsCmd, fgCmd, bgCmd, waitCmd]) shell.commands.register(c);
  await installPathShims(fs); // as main.ts does at boot
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  await fs.mkdir('/home/user/w', { recursive: true });
  await shell.execute('cd /home/user/w', () => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('less', () => {
  it('pages a file on the tty, searches, jumps to the end, quits', async () => {
    await install('less');
    await fs.writeFile('/home/user/w/f.txt', Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const { term, done } = onTerminal('less f.txt');
    await until(() => term.screen.includes('line 23'), 'first page');
    expect(term.screen).toContain('\x1b[?1049h'); // alternate screen
    expect(term.screen).not.toContain('line 30');
    term.type('/line 150\r');
    await until(() => term.screen.includes('line 160'), 'search result');
    term.type('G');
    await until(() => term.screen.includes('line 200'), 'end of file');
    term.type('q');
    expect(await done).toBe(0);
  }, 180_000);

  it('reads a pipe while keys come from /dev/tty', async () => {
    await install('less');
    const { term, done } = onTerminal('seq 1 500 | less');
    await until(() => term.screen.includes('\n23'), 'first page');
    term.type(' ');
    await until(() => term.screen.includes('46'), 'second page');
    term.type('q');
    expect(await done).toBe(0);
  }, 180_000);

  it('is not a terminal program when its output is piped', async () => {
    await install('less');
    await fs.writeFile('/home/user/w/g.txt', 'alpha\nbeta\n');
    expect((await sh('less g.txt | cat')).out).toBe('alpha\nbeta\n');
    expect((await sh('less --version')).out).toMatch(/^less 710/);
  }, 180_000);
});

describe('vim', () => {
  it('edits and writes a file on the tty', async () => {
    await install('vim');
    await fs.writeFile('/home/user/w/a.txt', 'one\ntwo\n');
    const { term, done } = onTerminal('vim a.txt');
    await until(() => term.screen.includes('"a.txt" 2L'), 'file loaded');
    expect(term.screen).toContain('\x1b[?1049h');
    term.type('Gothree\x1b:wq\r');
    expect(await done).toBe(0);
    expect(await fs.readFile('/home/user/w/a.txt', 'utf8')).toBe('one\ntwo\nthree\n');
  }, 180_000);

  it('highlights syntax from its runtime and reads :help', async () => {
    await install('vim');
    await fs.writeFile('/home/user/w/m.c', '#include <stdio.h>\nint main(void) { return 0; }\n');
    const { term, done } = onTerminal('vim m.c');
    await until(() => term.screen.includes('"m.c" 2L'), 'file loaded');
    await until(() => /\x1b\[(38;5;\d+|3\d|9\d)m(#include|int|return)/.test(term.screen), 'syntax colours');
    term.clear();
    term.type(':help usr_01\r');
    await until(() => term.screen.includes('About the manuals'), 'help text');
    term.type(':qa!\r');
    expect(await done).toBe(0);
  }, 180_000);

  it('follows a resize (SIGWINCH) and survives Ctrl-Z / fg', async () => {
    await install('vim');
    const term = fakeTerminal(24, 80);
    const { done } = onTerminal((process.env.VDEBUG ? 'TABCOMPUTER_BLINK_DEBUG=1 ' : '') + 'vim -u NONE', term);
    await until(() => term.screen.includes('~'), 'empty buffer');
    term.tty.resize(30, 100);
    term.clear();
    term.type(':echo &columns . "x" . &lines\r');
    await until(() => term.screen.includes('100x30'), 'new size');
    term.type('\x1a'); // Ctrl-Z: vim restores the screen and stops itself
    expect(await done).toBe(148);
    const fg = onTerminal('fg', term);
    await until(() => term.tty.jobInForeground, 'resumed');
    term.clear();
    term.type(':q!\r');
    await until(() => term.screen.includes('\x1b[?1049l'), 'vim exits');
    expect(await fg.done).toBe(0);
  }, 180_000);

  it('runs ex commands non-interactively', async () => {
    await install('vim');
    await fs.writeFile('/home/user/w/b.txt', 'hello\n');
    const r = await sh(`vim -es -c '%s/hello/bye/' -c 'wq' b.txt`);
    expect(r.exitCode).toBe(0);
    expect(await fs.readFile('/home/user/w/b.txt', 'utf8')).toBe('bye\n');
    expect((await sh('vim --version | head -1')).out).toMatch(/^VIM - Vi IMproved 9\.2/);
  }, 180_000);
});

describe('nano', () => {
  it('edits, saves with ^O and quits with ^X; highlights C', async () => {
    await install('nano');
    await fs.writeFile('/home/user/w/n.c', 'int x;\n');
    const { term, done } = onTerminal('nano n.c');
    await until(() => term.screen.includes('GNU nano 9.2'), 'title bar');
    await until(() => /\x1b\[[0-9;]*m(int)/.test(term.screen), 'syntax colours');
    term.type('\x1b\\'); // M-\ : top of file
    term.type('// hi\r');
    term.type('\x0f'); // ^O
    await until(() => term.screen.includes("Write to File"), "write prompt");
    term.type('\r');
    await until(() => /Wrote 2 lines/.test(term.screen), 'saved');
    term.type('\x18'); // ^X
    expect(await done).toBe(0);
    expect(await fs.readFile('/home/user/w/n.c', 'utf8')).toBe('// hi\nint x;\n');
  }, 180_000);
});

describe('diffutils + patch', () => {
  it('diff -u, cmp, and patch applies the diff', async () => {
    await install('diffutils', 'patch');
    await fs.writeFile('/home/user/w/a', 'one\ntwo\nthree\n');
    await fs.writeFile('/home/user/w/b', 'one\n2\nthree\nfour\n');
    const d = await sh('diff -u a b > ab.diff; echo $?; cat ab.diff');
    expect(d.out).toMatch(/^1\n--- a\t/);
    expect(d.out).toContain('-two\n+2\n three\n+four\n');
    expect((await sh('cmp a b; echo $?')).out).toMatch(/a b differ: (byte|char) 5, line 2\n1\n/);
    expect((await sh('diff a a; echo $?')).out).toBe('0\n');
    expect((await sh('patch a < ab.diff && cat a')).out).toContain('one\n2\nthree\nfour\n');
    expect((await sh('diff a b && echo same')).out).toBe('same\n');
  }, 180_000);
});

describe('gawk, sed, grep, findutils', () => {
  it('gawk: fields, arrays, printf, regex', async () => {
    await install('gawk');
    await fs.writeFile('/home/user/w/t.txt', 'alice 3\nbob 5\nalice 4\n');
    const r = await sh(`awk '{s[$1]+=$2} END {n=asorti(s,k); for(i=1;i<=n;i++) printf "%s=%d\\n", k[i], s[k[i]]}' t.txt`);
    expect(r.out).toBe('alice=7\nbob=5\n');
    expect((await sh(`gawk 'BEGIN { print toupper("x") gensub(/(a)(b)/, "\\\\2\\\\1", "g", "abab") }'`)).out).toBe('Xbaba\n');
    expect((await sh('awk --version | head -1')).out).toMatch(/^GNU Awk 5\.4\.1/);
  }, 180_000);

  it('sed: substitute, -n p, -i, -E', async () => {
    await install('sed');
    await fs.writeFile('/home/user/w/s.txt', 'foo bar\nbaz foo\n');
    expect((await sh(`sed 's/foo/X/g' s.txt`)).out).toBe('X bar\nbaz X\n');
    expect((await sh(`sed -n '2p' s.txt`)).out).toBe('baz foo\n');
    expect((await sh(`sed -E 's/(\\w+) (\\w+)/\\2 \\1/' s.txt`)).out).toBe('bar foo\nfoo baz\n');
    await sh(`sed -i '1d' s.txt`);
    expect(await fs.readFile('/home/user/w/s.txt', 'utf8')).toBe('baz foo\n');
    expect((await sh('sed --version | head -1')).out).toContain('GNU sed) 4.10');
  }, 180_000);

  it('grep: -r over directories, -n, -c, -i, -v, -E, egrep', async () => {
    await install('grep');
    await fs.mkdir('/home/user/w/src/sub', { recursive: true });
    await fs.writeFile('/home/user/w/src/a.c', 'int main() { return 0; }\n// TODO fix\n');
    await fs.writeFile('/home/user/w/src/sub/b.c', 'todo: nothing\nreturn 1;\n');
    expect((await sh('grep -rn return src | sort')).out).toBe('src/a.c:1:int main() { return 0; }\nsrc/sub/b.c:2:return 1;\n');
    expect((await sh('grep -ric todo src | sort')).out).toBe('src/a.c:1\nsrc/sub/b.c:1\n');
    expect((await sh('grep -v return src/sub/b.c')).out).toBe('todo: nothing\n');
    expect((await sh(`egrep -o '[0-9]+' src/sub/b.c`)).out).toBe('1\n');
    expect((await sh('grep nomatch src/a.c; echo $?')).out).toBe('1\n');
  }, 180_000);

  it('find and xargs', async () => {
    await install('findutils');
    await fs.mkdir('/home/user/w/d/e', { recursive: true });
    for (const f of ['d/x.txt', 'd/e/y.txt', 'd/e/z.md']) await fs.writeFile(`/home/user/w/${f}`, f + '\n');
    expect((await sh(`find d -name '*.txt' | sort`)).out).toBe('d/e/y.txt\nd/x.txt\n');
    expect((await sh('find d -type d | sort')).out).toBe('d\nd/e\n');
    expect((await sh(`find d -name '*.md' -exec cat {} \\;`)).out).toBe('d/e/z.md\n');
    expect((await sh(`find d -type f -print0 | sort -z | xargs -0 -n1 echo got | sort`)).out).toBe('got d/e/y.txt\ngot d/e/z.md\ngot d/x.txt\n');
  }, 180_000);
});

describe('bc', () => {
  it('arbitrary precision with the math library, and dc', async () => {
    await install('bc');
    expect((await sh(`echo 'scale=20; 4*a(1)' | bc -l`)).out).toBe('3.14159265358979323844\n');
    expect((await sh(`echo '2^100' | bc`)).out).toBe('1267650600228229401496703205376\n');
    expect((await sh(`echo '3 4 * p' | dc`)).out).toBe('12\n');
  }, 180_000);
});

describe('tar + gzip', () => {
  it('gzip round trip; tar czf runs gzip as a child process; extract and list', async () => {
    await install('tar', 'gzip');
    await fs.mkdir('/home/user/w/proj/sub', { recursive: true });
    await fs.writeFile('/home/user/w/proj/a.txt', 'alpha\n'.repeat(100));
    await fs.writeFile('/home/user/w/proj/sub/b.txt', 'beta\n');
    expect((await sh('gzip -k proj/a.txt && zcat proj/a.txt.gz | wc -l')).out.trim()).toBe('100');
    expect((await sh('gunzip -c proj/a.txt.gz | head -1')).out).toBe('alpha\n');
    // a program that execs a package command by path gets its arguments too (zcat = gzip -dc)
    await install('findutils');
    expect((await sh("find proj -name a.txt.gz -exec zcat {} \\; | wc -l")).out.trim()).toBe('100');
    expect((await sh('rm proj/a.txt.gz && tar czf p.tgz proj && tar tzf p.tgz | sort')).out)
      .toBe('proj/\nproj/a.txt\nproj/sub/\nproj/sub/b.txt\n');
    expect((await sh('mkdir x && tar xzf p.tgz -C x && cat x/proj/sub/b.txt')).out).toBe('beta\n');
    expect((await sh('tar --version | head -1')).out).toBe('tar (GNU tar) 1.35\n');
  }, 180_000);
});

describe('tree', () => {
  it('draws a directory tree with counts', async () => {
    await install('tree');
    await fs.mkdir('/home/user/w/t/a/b', { recursive: true });
    await fs.writeFile('/home/user/w/t/a/b/f.txt', 'x');
    await fs.writeFile('/home/user/w/t/top.md', 'y');
    const r = await sh('tree t');
    // tree 2 indents with no-break spaces in a UTF-8 locale
    expect(r.out.replace(/\u00a0/g, ' ')).toBe('t\n├── a\n│   └── b\n│       └── f.txt\n└── top.md\n\n3 directories, 2 files\n');
    expect((await sh('tree -d --noreport t')).out.replace(/\u00a0/g, ' ')).toBe('t\n└── a\n    └── b\n');
  }, 180_000);
});

describe('file', () => {
  it('identifies files with its magic database', async () => {
    await install('file', 'gzip');
    await fs.writeFile('/home/user/w/s.sh', '#!/bin/sh\necho hi\n');
    await fs.writeFile('/home/user/w/d.json', '{"a": [1, 2]}\n');
    await fs.writeFile('/home/user/w/p.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16, 0, 0, 0, 8, 8, 6, 0, 0, 0]));
    const r = await sh('gzip -k s.sh && file s.sh d.json p.png s.sh.gz /usr/lib/pkg/file/bin/file');
    expect(r.out).toContain('s.sh:');
    expect(r.out).toMatch(/s\.sh: +POSIX shell script, ASCII text executable/);
    expect(r.out).toMatch(/d\.json: +JSON (text )?data/);
    expect(r.out).toMatch(/p\.png: +PNG image data, 16 x 8, 8-bit\/color RGBA/);
    expect(r.out).toMatch(/s\.sh\.gz: +gzip compressed data/);
    expect(r.out).toMatch(/file: +ELF 64-bit LSB executable, x86-64, .*statically linked/);
    expect((await sh('file -b --mime-type d.json')).out).toBe('application/json\n');
  }, 180_000);
});

describe('xz, zstd', () => {
  it('compress and decompress, and tar uses them for -J and --zstd', async () => {
    await install('xz', 'zstd', 'tar');
    await fs.mkdir('/home/user/w/data', { recursive: true });
    await fs.writeFile('/home/user/w/data/big.txt', 'shiro '.repeat(5000));
    expect((await sh('xz -k data/big.txt && xz -l data/big.txt.xz | tail -1')).out).toMatch(/1 +1 +[\d.]+ (KiB|B) +29\.\d KiB/);
    expect((await sh('xzcat data/big.txt.xz | wc -c')).out.trim()).toBe('30000');
    expect((await sh('zstd -q -19 data/big.txt -o big.zst && zstdcat big.zst | wc -c')).out.trim()).toBe('30000');
    expect((await sh('rm data/big.txt.xz && tar cJf d.tar.xz data && tar tJf d.tar.xz')).out).toBe('data/\ndata/big.txt\n');
    expect((await sh('tar --zstd -cf d.tar.zst data && tar --zstd -tf d.tar.zst')).out).toBe('data/\ndata/big.txt\n');
  }, 180_000);
});

describe('zip, unzip', () => {
  it('zip -r, list, test and extract', async () => {
    await install('zip', 'unzip');
    await fs.mkdir('/home/user/w/z/sub', { recursive: true });
    await fs.writeFile('/home/user/w/z/a.txt', 'alpha\n');
    await fs.writeFile('/home/user/w/z/sub/b.txt', 'beta\n'.repeat(50));
    expect((await sh('zip -qr z.zip z && unzip -l z.zip')).out).toMatch(/z\/sub\/b\.txt\n[ -]+\n +\d+ +4 files\n$/);
    expect((await sh('unzip -tq z.zip')).out).toContain('No errors detected');
    expect((await sh('mkdir zout && unzip -q z.zip -d zout && cat zout/z/a.txt')).out).toBe('alpha\n');
    expect((await sh('zipinfo -1 z.zip | sort')).out).toBe('z/\nz/a.txt\nz/sub/\nz/sub/b.txt\n');
  }, 180_000);
});

describe('git', () => {
  it('init, add, commit, log, diff, branch, merge, status, tag; clone over the local transport', async () => {
    await install('git');
    const g = async (cmd: string) => {
      const r = await sh(cmd);
      if (r.exitCode !== 0) throw new Error(`${cmd} -> ${r.exitCode}\n${r.out}${r.err}`);
      return r.out;
    };
    expect(await g('git --version')).toBe('git version 2.56.0\n');
    await g('git config --global user.name "Shiro Tester" && git config --global user.email t@shiro.computer && git config --global init.defaultBranch main');
    await g('mkdir repo && cd repo && git init -q && echo one > a.txt && git add a.txt && git commit -qm first');
    await sh('cd /home/user/w/repo');
    await g('echo two >> a.txt && git commit -qam second && git checkout -qb feature && echo f > f.txt && git add f.txt && git commit -qm feature');
    expect(await g('git log --format=%s')).toBe('feature\nsecond\nfirst\n');
    await g('git checkout -q main && echo three >> a.txt && git commit -qam third');
    expect(await g('git merge -q --no-edit feature && git log --format=%s -1')).toBe("Merge branch 'feature'\n");
    expect(await g('ls')).toContain('f.txt');
    await g('echo four >> a.txt');
    expect(await g('git status --short')).toBe(' M a.txt\n');
    expect(await g('git diff')).toContain('@@ -1,3 +1,4 @@\n one\n two\n three\n+four\n');
    await g('git stash -q && git tag v1');
    expect(await g('git status --porcelain')).toBe('');
    expect(await g('git describe --tags')).toBe('v1\n');
    await sh('cd /home/user/w');
    await g('git clone -q repo copy');
    expect((await g('cd copy && git log --oneline | wc -l')).trim()).toBe('5');
    expect(await g('git branch -a')).toContain('remotes/origin/feature');
  }, 300_000);
});

describe('openssl', () => {
  it('hashes, encrypts, makes an Ed25519 key and a self-signed certificate', async () => {
    await install('openssl');
    await fs.writeFile('/home/user/w/m.txt', 'abc');
    expect((await sh('openssl dgst -sha256 m.txt')).out).toBe('SHA2-256(m.txt)= ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n');
    expect((await sh('openssl enc -aes-256-cbc -pbkdf2 -k pw -in m.txt -out m.enc && openssl enc -d -aes-256-cbc -pbkdf2 -k pw -in m.enc')).out).toBe('abc');
    expect((await sh('openssl rand -hex 8')).out).toMatch(/^[0-9a-f]{16}\n$/);
    const r = await sh('openssl genpkey -algorithm ed25519 -out k.pem && openssl req -new -x509 -key k.pem -subj /CN=shiro.test -days 1 -out c.pem && openssl x509 -in c.pem -noout -subject');
    expect(r.out).toBe('subject=CN=shiro.test\n');
    expect((await sh('openssl version')).out).toMatch(/^OpenSSL 3\.5\.9 /);
  }, 180_000);
});

describe('curl', () => {
  it('fetches from a loopback HTTP server through kernel sockets', async () => {
    await install('curl');
    const { netStack } = await import('@shiro/kernel/net');
    const { AF_INET, SOCK_STREAM } = await import('@shiro/kernel/abi');
    const l = netStack.socket(AF_INET, SOCK_STREAM, 0) as any;
    expect(l.bind({ family: AF_INET, address: '127.0.0.1', port: 18080 })).toBe(0);
    expect(l.listen(4)).toBe(0);
    const served = (async () => {
      const c = await l.accept();
      const buf = new Uint8Array(4096);
      let req = '';
      while (!req.includes('\r\n\r\n')) {
        const n = await c.read(buf);
        if (n <= 0) break;
        req += new TextDecoder().decode(buf.subarray(0, n));
      }
      const body = '{"ok":true}';
      await c.write(new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`));
      await c.close();
      return req;
    })();
    const r = await sh('curl -s -H "X-Test: 1" http://127.0.0.1:18080/hello');
    expect(r.out).toBe('{"ok":true}');
    const req = await served;
    expect(req).toMatch(/^GET \/hello HTTP\/1\.1\r\n/);
    expect(req).toContain('X-Test: 1');
    await l.close();
    expect((await sh('curl --version | head -1')).out).toMatch(/^curl 8\.22\.0 .*OpenSSL\/3\.5\.9/);
    expect((await sh('curl -s http://127.0.0.1:18081/; echo "rc=$?"')).out).toBe('rc=7\n'); // connection refused
  }, 180_000);
});

describe('fd', () => {
  it('finds files by extension, type and pattern, honouring .gitignore', async () => {
    await install('fd');
    await fs.mkdir('/home/user/w/fdproj/src/sub', { recursive: true });
    await fs.mkdir('/home/user/w/fdproj/.git', { recursive: true });
    await fs.writeFile('/home/user/w/fdproj/src/main.rs', 'fn main() {}\n');
    await fs.writeFile('/home/user/w/fdproj/src/sub/a.py', 'x = 1\n');
    await fs.writeFile('/home/user/w/fdproj/build.log', 'log\n');
    await fs.writeFile('/home/user/w/fdproj/.gitignore', '*.log\n');
    const r = await sh('cd fdproj && fd -e rs && fd -t d && fd -u log && fd log; echo rc=$?');
    expect(r.err).toBe(''); // no jemalloc MADV_DONTNEED warning
    expect(r.out).toBe('src/main.rs\nsrc/\nsrc/sub/\nbuild.log\nrc=0\n');
  }, 180_000);
});

describe('fzf', () => {
  it('filters non-interactively and picks a line in its TUI', async () => {
    await install('fzf');
    expect((await sh("printf 'apple\\nbanana\\ncherry\\n' | fzf -f an")).out).toBe('banana\n');
    await fs.writeFile('/home/user/w/fruit.txt', 'apple\nbanana\ncherry\n');
    const { term, done } = onTerminal('fzf --height=10 < fruit.txt > picked.txt');
    await until(() => term.screen.includes('3/3'), 'the item list');
    term.type('chr');
    await until(() => term.screen.includes('1/3'), 'the filtered list');
    term.type('\r');
    expect(await done).toBe(0);
    expect(await fs.readFile('/home/user/w/picked.txt', 'utf8')).toBe('cherry\n');
  }, 180_000);
});

describe('yq', () => {
  it('queries and converts YAML', async () => {
    await install('yq');
    await fs.writeFile('/home/user/w/t.yaml', 'a: 1\nb: [x, y]\n');
    expect((await sh("yq '.b[1]' t.yaml")).out).toBe('y\n');
    expect((await sh('yq -o json -I0 t.yaml')).out).toBe('{"a":1,"b":["x","y"]}\n');
    expect((await sh("yq -i '.a = 2' t.yaml && cat t.yaml")).out).toBe('a: 2\nb: [x, y]\n');
  }, 180_000);
});

describe('bat', () => {
  it('highlights syntax with its built-in themes, numbers lines, and is plain when piped', async () => {
    await install('bat');
    await fs.writeFile('/home/user/w/hello.rs', 'fn main() {\n    println!("hi");\n}\n');
    const c = await sh('bat --color=always --paging=never -p hello.rs');
    expect(c.err).toBe('');
    expect(c.out).toMatch(/\x1b\[38;[25];[\d;]+mfn\x1b\[0m/); // `fn` coloured by the default theme
    expect((await sh('bat --color=always --paging=never --theme=GitHub -p hello.rs')).out).toContain('println');
    expect((await sh('bat -n --color=never --paging=never hello.rs')).out).toMatch(/^ +1 fn main\(\) \{\n +2 +println/);
    expect((await sh('bat hello.rs | cat')).out).toBe('fn main() {\n    println!("hi");\n}\n');
    expect((await sh('bat --list-languages | grep -c "^Rust:"')).out).toBe('1\n');
  }, 180_000);
});

/**
 * WASM packages (pkg-index "abi": wasi/wasix): guests run in Node worker
 * threads as kernel processes, as the page runs them in Web Workers.
 */
describe('WASM packages', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(`${process.env.TMPDIR || '/tmp'}/shiro-compat-tools-`);
    writeFileSync(`${tmp}/entry.ts`, `
      import { parentPort } from 'node:worker_threads';
      import { guestMain } from ${JSON.stringify(`${REPO}/src/wasi/guest-worker.ts`)};
      const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
      parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
      guestMain(port);
    `);
    await build({ entryPoints: [`${tmp}/entry.ts`], bundle: true, platform: 'node', format: 'esm', outfile: `${tmp}/guest-worker.mjs`, logLevel: 'error' });
    setGuestWorkerFactory((): GuestWorker => {
      const w = new Worker(`${tmp}/guest-worker.mjs`);
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

  it('jq: filters, raw output, slurp, exit status', async () => {
    await install('jq');
    await fs.writeFile('/home/user/w/d.json', '{"items":[{"n":"a","v":2},{"n":"b","v":5}]}\n');
    expect((await sh("jq '[.items[].v] | add' d.json")).out).toBe('7\n');
    expect((await sh("jq -r '.items[] | select(.v > 3) | .n' d.json")).out).toBe('b\n');
    expect((await sh("printf '1 2 3' | jq -s -c 'map(. * 2)'")).out).toBe('[2,4,6]\n');
    expect((await sh("echo '{\"a\":\"x1y2\"}' | jq -r '.a | gsub(\"[0-9]\"; \"#\")'")).out).toBe('x#y#\n');
    expect((await sh('jq -e .missing d.json; echo rc=$?')).out).toBe('null\nrc=1\n');
  }, 180_000);

  it('ripgrep: recursive search, globs, types, .gitignore, counts', async () => {
    await install('ripgrep');
    await fs.mkdir('/home/user/w/rgp/src', { recursive: true });
    await fs.mkdir('/home/user/w/rgp/.git', { recursive: true });
    await fs.writeFile('/home/user/w/rgp/src/a.rs', 'fn alpha() {}\nfn beta() {}\n');
    await fs.writeFile('/home/user/w/rgp/src/b.py', 'def alpha(): pass\n');
    await fs.writeFile('/home/user/w/rgp/skip.log', 'alpha\n');
    await fs.writeFile('/home/user/w/rgp/.gitignore', '*.log\n');
    // the package is /usr/bin/rg; `rg` stays Shiro's builtin (its "shadow": false)
    const r = await sh('cd rgp && /usr/bin/rg --sort path -n alpha');
    expect(r.out).toBe('src/a.rs:1:fn alpha() {}\nsrc/b.py:1:def alpha(): pass\n');
    expect((await sh('/usr/bin/rg -t py -l alpha')).out).toBe('src/b.py\n');
    expect((await sh("/usr/bin/rg -g '*.rs' -c fn")).out).toBe('src/a.rs:2\n');
    expect((await sh('/usr/bin/rg --version | head -1; /usr/bin/rg nothing-here; echo rc=$?')).out).toBe('ripgrep 15.2.0 (rev b05740ceb6)\nrc=1\n');
  }, 180_000);

  it('sqlite3: creates a database file, queries it, and reads SQL from stdin', async () => {
    await install('sqlite');
    expect((await sh("sqlite3 t.db 'create table t(a, b); insert into t values (1, \"x\"), (2, \"y\");'")).exitCode).toBe(0);
    expect((await sh("sqlite3 t.db 'select sum(a), group_concat(b) from t'")).out).toBe('3|x,y\n');
    expect((await sh("echo 'select count(*) from t;' | sqlite3 t.db")).out).toBe('2\n');
    expect((await sh("sqlite3 -json t.db 'select a from t order by a'")).out).toBe('[{"a":1},\n{"a":2}]\n');
  }, 180_000);

  it('coreutils (uutils): the multi-call binary and its /usr/bin names', async () => {
    await install('coreutils');
    await fs.writeFile('/home/user/w/abc.txt', 'abc');
    expect((await sh('coreutils sha256sum abc.txt')).out).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  abc.txt\n');
    expect((await sh('/usr/bin/factor 84')).out).toBe('84: 2 2 3 7\n');
    expect((await sh("printf '3\\n1\\n2\\n' | /usr/bin/sort -n | /usr/bin/tr '\\n' ,")).out).toBe('1,2,3,');
    expect((await sh('/usr/bin/numfmt --to=iec 1048576')).out).toBe('1.0M\n');
    expect((await sh('/usr/bin/seq -s: 3')).out).toBe('1:2:3\n');
  }, 180_000);
});

describe('tmux', () => {
  it('runs a session on the tty: shell pane, split, detach and re-attach; scripted control', async () => {
    await install('tmux');
    expect((await sh('tmux -V')).out).toBe('tmux 3.8\n');
    // Interactive: the status line, a shell in the pane, a split, detach with C-b d
    const { term, done } = onTerminal('tmux new-session -s main');
    await until(() => term.screen.includes('[main]'), 'the status line');
    await until(() => term.screen.includes('user@tabcomputer:~/w$'), 'the pane shell prompt');
    term.type('echo pane-$((6*7))\r');
    await until(() => term.screen.includes('pane-42'), 'command output in the pane');
    term.type('\x02%'); // C-b %: split left/right
    await until(() => (term.screen.match(/user@tabcomputer:~\/w\$/g) ?? []).length >= 3, 'a second pane');
    term.type('\x02d');
    expect(await done).toBe(0);
    expect(term.screen).toContain('[detached (from session main)]');
    // Scripted: the server kept running
    expect((await sh("tmux list-panes -t main -F '#{pane_index}'")).out).toBe('0\n1\n');
    // uname's nodename is the kernel's hostname (Blink patch 0026), not emscripten's
    expect((await sh("tmux display -p -t main '#{host}'")).out).toBe('tabcomputer\n');
    await sh("tmux send-keys -t main.0 'echo scripted > /home/user/w/from-tmux.txt' Enter");
    for (let i = 0; i < 200 && !(await fs.exists('/home/user/w/from-tmux.txt')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await fs.readFile('/home/user/w/from-tmux.txt', 'utf8')).toBe('scripted\n');
    // Re-attach on a new terminal; ending the session from outside detaches it
    const again = onTerminal('tmux attach -t main', fakeTerminal(30, 100));
    await until(() => again.term.screen.includes('pane-42') && again.term.screen.includes('scripted'), 'the re-attached session');
    await until(() => again.term.screen.includes('[main]'), 'the status line, without a key press');
    expect((await sh('tmux kill-session -t main')).exitCode).toBe(0);
    expect(await again.done).toBe(0);
    expect(again.term.screen).toContain('[exited]');
    expect((await sh('tmux ls 2>&1; echo rc=$?')).out).toMatch(/no server running.*\nrc=1\n$/);
  }, 300_000);
});

describe('screen', () => {
  it('runs a session on the tty: shell window, new window, detach, -ls, -X stuff, re-attach, quit', async () => {
    await install('screen');
    expect((await sh('screen -v')).out).toMatch(/^Screen version 5\.0\.2 /);
    const { term, done } = onTerminal('screen -S work');
    await until(() => term.screen.includes('user@tabcomputer:~/w$'), 'the window shell prompt');
    term.type('echo window-$((6*7))\r');
    await until(() => term.screen.includes('window-42'), 'command output');
    term.type('\x01c'); // C-a c: a second window
    await until(() => (term.screen.match(/user@tabcomputer:~\/w\$/g) ?? []).length >= 3, 'a second window');
    term.type('\x01d');
    expect(await done).toBe(0);
    expect(term.screen).toMatch(/\[detached from \d+\.work\]/);
    expect((await sh('screen -ls')).out).toMatch(/\d+\.work\s+\(Detached\)/);
    await sh("screen -S work -p 0 -X stuff 'echo stuffed > /home/user/w/from-screen.txt\\n'");
    for (let i = 0; i < 200 && !(await fs.exists('/home/user/w/from-screen.txt')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await fs.readFile('/home/user/w/from-screen.txt', 'utf8')).toBe('stuffed\n');
    const again = onTerminal('screen -r work');
    await until(() => again.term.screen.includes('user@tabcomputer:~/w$'), 'the re-attached session');
    expect((await sh('screen -S work -X quit')).exitCode).toBe(0);
    await again.done;
    expect(again.term.screen).toContain('[screen is terminating]');
    expect((await sh('screen -ls; echo rc=$?')).out).toMatch(/No Sockets found/);
  }, 300_000);
});

describe('procps (ps, top, free, uptime, vmstat, pgrep/pkill, watch)', () => {
  it('reads the kernel /proc', async () => {
    await install('procps');
    expect((await sh('ps -o pid,ppid,comm')).out).toMatch(/^ +PID +PPID COMMAND\n +1 +0 init\n[^]* ps\n$/);
    expect((await sh('ps -ef')).out).toMatch(/^UID +PID +PPID +C STIME TTY +TIME CMD\nuser +1 +0 +0 \d\d:\d\d \? +00:00:00 init\n/);
    expect((await sh('free -m')).out).toMatch(/^ +total +used +free +shared +buff\/cache +available\nMem: +\d+/);
    expect((await sh('uptime')).out).toMatch(/^ \d\d:\d\d:\d\d up +\d+ min, +0 users, +load average: \d+\.\d\d, \d+\.\d\d, \d+\.\d\d\n$/);
    expect((await sh('vmstat')).out).toMatch(/\n r +b +swpd +free[^\n]*\n +\d+ +\d+ +0 +\d+/);
    // top refreshes by rewinding /proc/stat: two iterations
    const top = (await sh('top -b -n 2 -d 0.2')).out;
    expect(top.match(/^top - \d\d:\d\d:\d\d up/gm)?.length).toBe(2);
    expect(top).toMatch(/Tasks: +\d+ total/);
    expect(top).toMatch(/ +PID USER +PR +NI[^\n]*COMMAND\n +1 user/);
    // pgrep/pkill a running program
    const bg = sh('vmstat 1 > /dev/null');
    for (let i = 0; i < 100 && !/vmstat/.test((await sh('pgrep -l vmstat')).out); i++) await new Promise((r) => setTimeout(r, 50));
    expect((await sh('pgrep -l vmstat')).out).toMatch(/^\d+ vmstat\n$/);
    expect((await sh('pkill vmstat; echo rc=$?')).out).toBe('rc=0\n');
    expect((await bg).exitCode).toBe(143); // SIGTERM
  }, 180_000);
});

describe('htop', () => {
  it('shows meters and the process list on the tty, and quits with q', async () => {
    await install('htop');
    const { term, done } = onTerminal('htop');
    await until(() => term.screen.includes('Load average') && term.screen.includes('Uptime'), 'the meters');
    await until(() => /PID USER +PRI/.test(term.screen) && term.screen.includes('htop') && term.screen.includes('init'), 'the process list');
    term.type('q');
    expect(await done).toBe(0);
  }, 180_000);
});

describe('wget', () => {
  it('downloads from a loopback HTTP server to a file and to stdout', async () => {
    await install('wget');
    const { netStack } = await import('@shiro/kernel/net');
    const { AF_INET, SOCK_STREAM } = await import('@shiro/kernel/abi');
    const l = netStack.socket(AF_INET, SOCK_STREAM, 0) as any;
    expect(l.bind({ family: AF_INET, address: '127.0.0.1', port: 18090 })).toBe(0);
    expect(l.listen(4)).toBe(0);
    const serve = async (body: string) => {
      const c = await l.accept();
      const buf = new Uint8Array(4096);
      let req = '';
      while (!req.includes('\r\n\r\n')) {
        const n = await c.read(buf);
        if (n <= 0) break;
        req += new TextDecoder().decode(buf.subarray(0, n));
      }
      await c.write(new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
      await c.close();
      return req;
    };
    let served = serve('file body\n');
    expect((await sh('wget -q http://127.0.0.1:18090/wget-f.txt && cat wget-f.txt')).out).toBe('file body\n');
    expect(await served).toMatch(/^GET \/wget-f\.txt HTTP\/1\.1\r\n[^]*User-Agent: Wget\/1\.25\.0/);
    served = serve('to stdout');
    expect((await sh('wget -qO- http://127.0.0.1:18090/x')).out).toBe('to stdout');
    await served;
    await l.close();
    expect((await sh('wget -q --tries=1 http://127.0.0.1:18091/; echo rc=$?')).out).toBe('rc=4\n'); // network failure
  }, 180_000);
});

describe('rsync', () => {
  it('copies trees, updates only what changed, deletes, and dry-runs', async () => {
    await install('rsync');
    await fs.mkdir('/home/user/w/rs/src/sub', { recursive: true });
    await fs.writeFile('/home/user/w/rs/src/a.txt', 'one\n');
    await fs.writeFile('/home/user/w/rs/src/sub/b.txt', 'two\n');
    expect((await sh('cd rs && rsync -a src/ dst/ && find dst -type f | sort')).out).toBe('dst/a.txt\ndst/sub/b.txt\n');
    await fs.writeFile('/home/user/w/rs/src/a.txt', 'changed\n');
    await fs.writeFile('/home/user/w/rs/dst/extra.txt', 'x');
    const r = await sh('rsync -ai --delete src/ dst/');
    expect(r.out).toMatch(/^\*deleting +extra\.txt\n>f[.a-zA-Z+]{9,10} a\.txt\n$/);
    expect(await fs.readFile('/home/user/w/rs/dst/a.txt', 'utf8')).toBe('changed\n');
    expect((await sh('rsync -ain src/ dst/')).out).toBe('');
    expect((await sh('rsync --version | head -1')).out).toMatch(/^rsync +version 3\.5\.1 /);
  }, 180_000);
});

describe('man (mandoc)', () => {
  it('formats manual pages, finds them with -w, and indexes them with makewhatis for apropos', async () => {
    await install('mandoc');
    expect((await sh('man -w man')).out).toBe('/usr/share/man/man1/man.1\n/usr/share/man/man7/man.7\n');
    const page = await sh('MANWIDTH=70 man -T ascii mandoc');
    expect(page.err).toBe('');
    expect(page.out.replace(/.\x08/g, '')).toMatch(/^MANDOC\(1\) +General Commands Manual +MANDOC\(1\)\n\nNAME\n +mandoc - format manual pages\n/);
    expect((await sh('apropos mandoc 2>&1; echo rc=$?')).out).toMatch(/rc=[1-9]\n$/); // no database yet
    expect((await sh('makewhatis /usr/share/man && whatis mandoc')).out).toMatch(/^mandoc\(1\) - format manual pages\n/m);
    expect((await sh('apropos -s 7 roff')).out).toMatch(/roff\(7\) - roff language reference/);
    // other packages bring their pages; aliases are .so redirects
    await install('xz', 'procps');
    expect((await sh('man -w xz vmstat')).out).toBe('/usr/share/man/man1/xz.1\n/usr/share/man/man8/vmstat.8\n');
    expect((await sh('MANWIDTH=70 man -T ascii xzcat')).out.replace(/.\x08/g, '')).toMatch(/^XZ\(1\) +XZ Utils +XZ\(1\)\n/);
    expect((await sh('makewhatis /usr/share/man && whatis ps')).out).toMatch(/^ps\(1\) - report a snapshot of the current processes/m);
  }, 180_000);
});

describe('openssh (client)', () => {
  it('makes and reads keys, prints its config, and reaches a server (banner exchange)', async () => {
    await install('openssh');
    expect((await sh('ssh -V 2>&1')).out).toMatch(/^OpenSSH_10\.6p1, OpenSSL 3\.5\.9 /);
    await fs.mkdir('/home/user/.ssh', { recursive: true });
    expect((await sh("ssh-keygen -q -t ed25519 -N '' -C t@shiro -f /home/user/.ssh/id_ed25519; echo rc=$?")).out).toBe('rc=0\n');
    // the private key is 0600 (ssh-keygen's umask 077 reaches the kernel); ls shows it
    expect((await sh('ls -l /home/user/.ssh/id_ed25519')).out).toMatch(/^-rw------- /);
    expect((await sh('ssh-keygen -l -f /home/user/.ssh/id_ed25519.pub')).out).toMatch(/^256 SHA256:[A-Za-z0-9+/]{43} t@shiro \(ED25519\)\n$/);
    const pub = await fs.readFile('/home/user/.ssh/id_ed25519.pub', 'utf8');
    expect((await sh('ssh-keygen -y -f /home/user/.ssh/id_ed25519')).out.trim()).toBe((pub as string).trim());
    // ssh-agent daemonizes (fork, setsid, setrlimit(RLIMIT_CORE)) on an AF_UNIX socket; ssh-add talks to it
    expect((await sh('ssh-agent -s > /tmp/agent.env; cat /tmp/agent.env')).out).toMatch(/^SSH_AUTH_SOCK=\S+; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=\d+; export SSH_AGENT_PID;\necho Agent pid \d+;\n$/);
    const agent = await sh('. /tmp/agent.env >/dev/null; ssh-add /home/user/.ssh/id_ed25519 2>&1; ssh-add -l; ssh-agent -k >/dev/null; echo rc=$?');
    expect(agent.out).toMatch(/^Identity added: \/home\/user\/\.ssh\/id_ed25519 \(t@shiro\)\n256 SHA256:\S+ t@shiro \(ED25519\)\nrc=0\n$/);
    expect((await sh('ssh -G -p 2200 bob@example.com | grep -E "^(hostname|port|user) "')).out).toBe('user bob\nhostname example.com\nport 2200\n');
    // a server on a kernel socket: ssh sends its identification and reads the server's
    const { netStack } = await import('@shiro/kernel/net');
    const { AF_INET, SOCK_STREAM } = await import('@shiro/kernel/abi');
    const l = netStack.socket(AF_INET, SOCK_STREAM, 0) as any;
    expect(l.bind({ family: AF_INET, address: '127.0.0.1', port: 18022 })).toBe(0);
    expect(l.listen(1)).toBe(0);
    const server = (async () => {
      const c = await l.accept();
      await c.write(new TextEncoder().encode('SSH-2.0-ShiroTest\r\n'));
      const buf = new Uint8Array(256);
      const n = await c.read(buf);
      await c.close();
      return new TextDecoder().decode(buf.subarray(0, n));
    })();
    const r = await sh('ssh -o BatchMode=yes -o StrictHostKeyChecking=no -p 18022 127.0.0.1 true 2>&1; echo rc=$?');
    expect(await server).toMatch(/^SSH-2\.0-OpenSSH_10\.6\r\n/);
    expect(r.out).toMatch(/rc=255\n$/);
    await l.close();
    expect((await sh('ssh -o ConnectTimeout=3 -p 18023 127.0.0.1 true 2>&1')).out).toMatch(/Connection refused/);
  }, 180_000);
});

describe('gnupg', () => {
  it('makes a key, signs, verifies, encrypts and decrypts; asks for the passphrase with pinentry on the tty', async () => {
    await install('gnupg');
    expect((await sh('gpg --version')).out).toMatch(/^gpg \(GnuPG\) 2\.5\.24\nlibgcrypt 1\.12\.4\n/);
    const batch = 'gpg -q --batch --pinentry-mode loopback --passphrase pw';
    // no "insecure memory" warning: mlock succeeds (Blink patch 0025)
    expect((await sh(`${batch} --quick-gen-key 'Test User <t@shiro>' default default never 2>&1 | grep -c insecure`)).out).toBe('0\n');
    expect((await sh("gpg -k --with-colons t@shiro | cut -d: -f1,4,12 | grep -E '^(pub|sub)'")).out).toBe('pub:22:scESC\nsub:18:e\n');
    await fs.writeFile('/home/user/w/m.txt', 'hello gpg\n');
    expect((await sh(`${batch} --armor --detach-sign m.txt; gpg --verify m.txt.asc m.txt 2>&1`)).out).toMatch(/Good signature from "Test User <t@shiro>" \[ultimate\]/);
    expect((await sh('gpg --export t@shiro > pub.gpg; gpgv --keyring ./pub.gpg m.txt.asc m.txt 2>&1; echo rc=$?')).out).toMatch(/Good signature[^]*rc=0\n$/);
    await fs.writeFile('/home/user/w/m.txt', 'hello gpg, changed\n');
    expect((await sh('gpg --verify m.txt.asc m.txt 2>&1; echo rc=$?')).out).toMatch(/BAD signature[^]*rc=1\n$/);
    expect((await sh('gpg -q --batch -r t@shiro --armor -e -o m.gpg m.txt; head -1 m.gpg')).out).toBe('-----BEGIN PGP MESSAGE-----\n');
    expect((await sh(`${batch} -d m.gpg`)).out).toBe('hello gpg, changed\n');
    expect((await sh('gpg -q --batch --passphrase s3 -c -o s.gpg m.txt && gpg -q --batch --passphrase s3 -d s.gpg')).out).toBe('hello gpg, changed\n');
    expect((await sh("gpg-connect-agent 'getinfo version' /bye")).out).toBe('D 2.5.24\nOK\n');
    // The agent forgets the passphrase; decrypting on the terminal runs pinentry-curses there
    expect((await sh('gpgconf --reload gpg-agent; echo rc=$?')).out).toBe('rc=0\n');
    const { term, done } = onTerminal('gpg -q -d m.gpg');
    await until(() => term.screen.includes('Passphrase:'), 'the pinentry dialog');
    term.type('pw\r');
    expect(await done).toBe(0);
    expect(term.screen).toContain('hello gpg, changed');
    expect((await sh('gpgconf --kill gpg-agent; echo rc=$?')).out).toBe('rc=0\n');
  }, 180_000);
});

describe('neovim', () => {
  it('runs headless Lua and treesitter (parsers linked in)', async () => {
    await install('neovim');
    expect((await sh('nvim --version')).out).toMatch(/^NVIM v0\.12\.5\n[^]*Lua 5\.1\n/);
    await fs.writeFile('/home/user/w/n.txt', 'hello\nworld\n');
    expect((await sh("nvim --headless -c '%s/world/there/' -c wq n.txt >/dev/null 2>&1; cat n.txt")).out).toBe('hello\nthere\n');
    const ts = 'lua local p=vim.treesitter.get_string_parser("local x = 1","lua"); io.stdout:write(p:parse()[1]:root():sexpr().."\\n")';
    expect((await sh(`nvim --headless -c '${ts}' -c q`)).out).toMatch(/^\(chunk local_declaration: \(variable_declaration/);
    const help = 'lua io.stdout:write(vim.bo.filetype.." "..tostring(vim.treesitter.highlighter.active[vim.api.nvim_get_current_buf()] ~= nil).."\\n")';
    expect((await sh(`nvim --headless -c help -c '${help}' -c qa 2>&1`)).out).toBe('help true\n');
  }, 180_000);

  it('edits a file on the tty, and runs a shell in :terminal', async () => {
    await install('neovim');
    await fs.writeFile('/home/user/w/a.txt', 'one\ntwo\n');
    const { term, done } = onTerminal('nvim a.txt');
    await until(() => term.screen.includes('two'), 'the file on screen');
    term.type('Gothree\x1b');
    await until(() => term.screen.includes('three'), 'inserted text');
    term.clear();
    term.type(':terminal\r');
    await until(() => term.screen.includes('$'), 'the shell prompt in :terminal');
    term.type('iecho term-$((6*7))\r');
    await until(() => term.screen.includes('term-42'), 'command output in :terminal');
    term.clear();
    term.type('exit\r'); // a :terminal shell that exits 0 closes its buffer: back to a.txt
    await until(() => term.screen.includes('a.txt [+]'), 'the edited buffer again');
    term.type(':wq\r');
    expect(await done).toBe(0);
    expect(await fs.readFile('/home/user/w/a.txt', 'utf8')).toBe('one\ntwo\nthree\n');
  }, 180_000);
});

describe('emacs', () => {
  it('evaluates Lisp in batch mode (dump, byte-compiled Lisp, org)', async () => {
    await install('emacs');
    expect((await sh('emacs --version')).out).toMatch(/^GNU Emacs 31\.1\n/);
    expect((await sh(`emacs --batch --eval '(princ (format "%s %d\\n" emacs-version (+ 40 2)))'`)).out).toBe('31.1 42\n');
    await fs.writeFile('/home/user/w/e.txt', 'hello\n');
    expect((await sh(`emacs --batch e.txt --eval '(progn (goto-char (point-max)) (insert "more\\n") (save-buffer))' 2>&1; cat e.txt`)).out).toMatch(/hello\nmore\n$/);
    expect((await sh(`emacs --batch --eval '(progn (require (quote org)) (princ (org-version)))' 2>/dev/null`)).out).toMatch(/^\d+\.\d+/);
  }, 180_000);

  it('edits and saves a file with emacs -nw on the tty, and runs M-x shell', async () => {
    await install('emacs');
    await fs.writeFile('/home/user/w/b.txt', 'one\n');
    const { term, done } = onTerminal('emacs -nw b.txt');
    await until(() => term.screen.includes('b.txt') && term.screen.includes('one'), 'the file in its buffer');
    term.type('\x1b>two\x18\x13'); // M-> two C-x C-s
    await until(() => term.screen.includes('Wrote '), 'the save message');
    expect(await fs.readFile('/home/user/w/b.txt', 'utf8')).toBe('one\ntwo\n'); // text-mode requires a final newline
    term.clear();
    term.type('\x1bxshell\r');
    await until(() => term.screen.includes('user@tabcomputer'), 'a shell prompt in *shell*');
    term.type('echo sh-$((6*7))\r');
    await until(() => term.screen.includes('sh-42'), 'command output in *shell*');
    term.type('exit\r');
    await until(() => term.screen.includes('finished'), 'the shell process finishing');
    term.type('\x18\x03'); // C-x C-c
    expect(await done).toBe(0);
  }, 180_000);
});
