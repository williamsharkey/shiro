/**
 * /dom (src/dom-fs.ts): the live page as files, through the shell (builtins
 * see the FileSystem provider) and the kernel (open/read/write syscalls,
 * blocking event-stream devices). The desktop's windows come from a real
 * WindowManager (src/desktop/wm.ts) on linkedom.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { installDomFs, type DomProvider } from '@shiro/dom-fs';
import { Kernel } from '@shiro/kernel/kernel';
import * as A from '@shiro/kernel/abi';
import type { OpenFile } from '@shiro/kernel/fd';
import { WindowManager } from '@shiro/desktop/wm';

let fs: FileSystem;
let shell: Shell;
let kernel: Kernel;
let dom: DomProvider;
let wm: WindowManager;

async function run(cmd: string): Promise<{ out: string; err: string; code: number }> {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  kernel = new Kernel({ shell });
  document.body.innerHTML = `<div id="app"><h1 class="title">Hello</h1><p class="note">one</p><p class="note">two</p>
    <input id="name" value="ada"><button id="go" data-x="1">Go</button></div>`;
  const root = document.createElement('div');
  document.body.appendChild(root);
  wm = new WindowManager(root, { workArea: () => ({ x: 0, y: 30, width: 1200, height: 700 }) });
  dom = installDomFs(fs, kernel, () => wm);
});

afterAll(() => { dom.dispose(); kernel.dispose(); });

describe('/dom through the shell', () => {
  it('is listed at / and lists ctl, events, windows and element ids', async () => {
    expect((await fs.readdir('/'))).toContain('dom');
    const ls = (await run('ls /dom')).out.split(/\s+/);
    for (const n of ['ctl', 'events', 'windows', 'body', 'app', 'name', 'go']) expect(ls).toContain(n);
  });

  it('reads and writes element text, html, attributes, values and styles', async () => {
    expect((await run('cat /dom/app/children/0/text')).out).toBe('Hello\n');
    expect((await run("cat '/dom/.note/count'; cat '/dom/.note/1/text'")).out).toBe('2\ntwo\n');
    expect((await run("echo Bonjour > '/dom/h1.title/text'")).code).toBe(0);
    expect(document.querySelector('h1')!.textContent).toBe('Bonjour');
    expect((await run('cat /dom/go/attr/data-x')).out).toBe('1\n');
    await run('echo 2 > /dom/go/attr/data-x; echo yes > /dom/go/attr/aria-pressed');
    expect(document.getElementById('go')!.getAttribute('data-x')).toBe('2');
    expect(document.getElementById('go')!.getAttribute('aria-pressed')).toBe('yes');
    expect((await run('ls /dom/go/attr')).out.split(/\s+/)).toEqual(expect.arrayContaining(['id', 'data-x', 'aria-pressed']));
    expect((await run('cat /dom/name/value')).out).toBe('ada\n');
    await run('echo grace > /dom/name/value');
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('grace');
    await run('echo red > /dom/go/style/color');
    expect((document.getElementById('go') as HTMLElement).style.getPropertyValue('color')).toBe('red');
    expect((await run('cat /dom/go/tag')).out).toBe('button\n');
    expect((await run("grep -c Go /dom/app/html")).out).toBe('1\n');
  });

  it('clicks, and records events for /dom/events/<type>', async () => {
    let clicks = 0;
    document.getElementById('go')!.addEventListener('click', () => clicks++);
    expect((await run('cat /dom/events/click')).out).toBe(''); // starts recording
    await run('echo 1 > /dom/go/click');
    expect(clicks).toBe(1);
    const rec = (await run('cat /dom/events/click')).out;
    expect(rec).toMatch(/^click t=\d+ target=button#go/m);
  });

  it('evaluates JavaScript through /dom/ctl and reports errors as EIO', async () => {
    expect((await run("echo '6 * 7' > /dom/ctl; cat /dom/ctl")).out).toBe('42\n');
    expect((await run("echo '({a: [1, 2]})' > /dom/ctl; cat /dom/ctl")).out).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}\n');
    const bad = await run("echo 'throw new Error(\"boom\")' > /dom/ctl");
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/EIO.*boom/);
    expect((await run('cat /dom/ctl')).out).toBe('error: boom\n');
  });

  it('missing elements and read-only files are errors', async () => {
    expect((await run('cat /dom/nosuchthing/text')).code).not.toBe(0);
    expect((await run('test -e /dom/go/attr/nope && echo y || echo n')).out).toBe('n\n');
    const ro = await run('echo 1 > /dom/go/rect');
    expect(ro.code).not.toBe(0);
    expect(ro.err).toMatch(/EACCES/);
  });

  it('controls desktop windows: title, geometry, ctl commands, open', async () => {
    const w = wm.createWindow({ id: 'demo', appId: 'demo', title: 'Demo', x: 10, y: 20, width: 300, height: 200 });
    expect((await run('ls /dom/windows')).out.split(/\s+/)).toEqual(expect.arrayContaining(['ctl', 'demo']));
    expect((await run('cat /dom/windows/demo/title /dom/windows/demo/geometry /dom/windows/demo/state')).out)
      .toBe('Demo\n10 20 300 200\nnormal\n');
    await run('echo "move 40 50" > /dom/windows/demo/ctl; echo "resize 320 210" > /dom/windows/demo/ctl');
    expect(w.geometry()).toEqual({ x: 40, y: 50, width: 320, height: 210 });
    await run('echo "0 0 500 300" > /dom/windows/demo/geometry; echo Renamed > /dom/windows/demo/title');
    expect(w.geometry()).toEqual({ x: 0, y: 0, width: 500, height: 300 });
    expect(w.title).toBe('Renamed');
    await run('echo maximize > /dom/windows/demo/ctl');
    expect(w.state).toBe('maximized');
    await run('echo restore > /dom/windows/demo/ctl');
    expect(w.state).toBe('normal');
    expect((await run('echo "fly away" > /dom/windows/demo/ctl')).err).toMatch(/EINVAL/);
    let opened = 0;
    wm.registerApp({ id: 'hello', name: 'Hello', launch: () => { opened++; return null; } });
    await run('echo open hello > /dom/windows/ctl');
    expect(opened).toBe(1);
    expect((await run('echo open nope > /dom/windows/ctl')).err).toMatch(/ENOENT|No such/);
    await run('echo close > /dom/windows/demo/ctl');
    expect(w.state).toBe('closed');
    expect((await run('test -d /dom/windows/demo && echo y || echo n')).out).toBe('n\n');
  });
});

describe('/dom through the kernel', () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const holder = () => kernel.spawn({ path: 'holder', cwd: '/', run: () => new Promise<number>(() => {}) });

  it('open/read/write of element files', async () => {
    const proc = holder();
    const f = (await kernel.open(proc, '/dom/app/children/0/text', A.O_RDONLY)) as OpenFile;
    expect(typeof f).toBe('object');
    const buf = new Uint8Array(64);
    expect(dec.decode(buf.subarray(0, await f.read(buf)))).toBe('Bonjour\n');
    await f.close();
    const g = (await kernel.open(proc, '/dom/app/children/0/text', A.O_WRONLY | A.O_TRUNC)) as OpenFile;
    await g.write(enc.encode('From the kernel\n'));
    await g.close();
    expect(document.querySelector('h1')!.textContent).toBe('From the kernel');
    expect(await kernel.open(proc, '/dom/missing/text', A.O_RDONLY)).toBe(-A.ENOENT);
  });

  it('/dom/events/<type> is a blocking stream device', async () => {
    const proc = holder();
    const f = (await kernel.open(proc, '/dom/events/keydown', A.O_RDONLY)) as OpenFile;
    const buf = new Uint8Array(512);
    const pending = f.read(buf);
    let done = false;
    void pending.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // blocks until an event comes
    const ev = new (window as any).Event('keydown', { bubbles: true });
    Object.assign(ev, { key: 'q', code: 'KeyQ' });
    document.getElementById('name')!.dispatchEvent(ev);
    const n = await pending;
    expect(dec.decode(buf.subarray(0, n))).toMatch(/^keydown t=\d+ target=input#name key="q" code=KeyQ\n$/);
    await f.close();
  });
});
