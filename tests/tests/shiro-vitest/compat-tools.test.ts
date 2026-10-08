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

async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
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
  }, 120_000);

  it('reads a pipe while keys come from /dev/tty', async () => {
    await install('less');
    const { term, done } = onTerminal('seq 1 500 | less');
    await until(() => term.screen.includes('\n23'), 'first page');
    term.type(' ');
    await until(() => term.screen.includes('46'), 'second page');
    term.type('q');
    expect(await done).toBe(0);
  }, 120_000);

  it('is not a terminal program when its output is piped', async () => {
    await install('less');
    await fs.writeFile('/home/user/w/g.txt', 'alpha\nbeta\n');
    expect((await sh('less g.txt | cat')).out).toBe('alpha\nbeta\n');
    expect((await sh('less --version')).out).toMatch(/^less 710/);
  }, 120_000);
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
  }, 120_000);

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
  }, 120_000);

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
  }, 120_000);

  it('runs ex commands non-interactively', async () => {
    await install('vim');
    await fs.writeFile('/home/user/w/b.txt', 'hello\n');
    const r = await sh(`vim -es -c '%s/hello/bye/' -c 'wq' b.txt`);
    expect(r.exitCode).toBe(0);
    expect(await fs.readFile('/home/user/w/b.txt', 'utf8')).toBe('bye\n');
    expect((await sh('vim --version | head -1')).out).toMatch(/^VIM - Vi IMproved 9\.2/);
  }, 120_000);
});
