/**
 * Popular Unix tools in Shiro (docs/COMPAT.md): one smoke test per scoreboard
 * entry. Each installs the real package with `pkg install` (files served
 * from public/pkg like shiro.computer does; other downloads cached in
 * tests/.pkg-cache) and runs it from the shell as a kernel process, on a
 * terminal pty for the interactive ones: raw mode, alternate screen,
 * resize, Ctrl-C/Ctrl-Z.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
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
    const { done } = onTerminal((process.env.VDEBUG ? 'SHIRO_BLINK_DEBUG=1 ' : '') + 'vim -u NONE', term);
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

describe('make', () => {
  it('builds targets in dependency order through /bin/sh, with variables, patterns and -j', async () => {
    await install('make');
    await fs.writeFile('/home/user/w/Makefile', [
      'NAME := world',
      'all: out/hello.txt out/count.txt',
      'out:',
      '\tmkdir -p out',
      'out/hello.txt: | out',
      '\techo "hello $(NAME)" > $@',
      'out/count.txt: out/hello.txt',
      '\twc -c < $< > $@',
      '%.up: %.txt',
      '\ttr a-z A-Z < $< > $@',
      '.PHONY: all clean',
      'clean:',
      '\trm -rf out',
      '',
    ].join('\n'));
    let r = await sh('make');
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('echo "hello world" > out/hello.txt');
    expect(await fs.readFile('/home/user/w/out/hello.txt', 'utf8')).toBe('hello world\n');
    expect((await fs.readFile('/home/user/w/out/count.txt', 'utf8')).trim()).toBe('12');
    expect((await sh('make')).out).toContain("Nothing to be done for 'all'");
    expect((await sh('make out/hello.up && cat out/hello.up')).out).toContain('HELLO WORLD');
    r = await sh('make clean && make -j2 NAME=shiro && cat out/hello.txt');
    expect(r.out).toContain('hello shiro');
    r = await sh('make nosuchtarget');
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain('No rule to make target');
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
    expect((await sh('rm proj/a.txt.gz && tar czf p.tgz proj && tar tzf p.tgz | sort')).out)
      .toBe('proj/\nproj/a.txt\nproj/sub/\nproj/sub/b.txt\n');
    expect((await sh('mkdir x && tar xzf p.tgz -C x && cat x/proj/sub/b.txt')).out).toBe('beta\n');
    expect((await sh('tar --version | head -1')).out).toBe('tar (GNU tar) 1.35\n');
  }, 180_000);
});
