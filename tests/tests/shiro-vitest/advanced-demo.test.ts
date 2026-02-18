import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { grepCmd } from '@shiro/commands/grep';
import { hcCmd } from '@shiro/commands/hc';
import { pageCmd } from '@shiro/commands/page';
import { parseHTML } from 'linkedom';

/**
 * Advanced Demo Tests — covers all commands used in the "Advanced" about page demo:
 * multi-file project scaffolding, hc DOM inspection, grep -rn code search,
 * page interaction (input, click, text, eval), and git workflow.
 */

describe('Advanced demo — CLI IDE workflow', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    shell.commands.register(grepCmd);
    shell.commands.register(hcCmd);
    shell.commands.register(pageCmd);
  });

  // ─── A. Project scaffolding ───

  describe('project scaffolding', () => {
    it('mkdir -p creates todo project directory', async () => {
      await run(shell, 'mkdir -p /tmp/todo');
      const stat = await fs.stat('/tmp/todo');
      expect(stat.isDirectory()).toBe(true);
    });

    it('heredoc writes index.html with link and script refs', async () => {
      await run(shell, 'mkdir -p /tmp/todo');
      const { exitCode } = await run(shell, `cat > /tmp/todo/index.html << 'EOF'
<!DOCTYPE html>
<html><head><title>Todo</title>
<link rel="stylesheet" href="style.css">
</head><body>
<h1>Todo App</h1>
<input id="inp" placeholder="Add todo...">
<button id="add" onclick="addTodo()">Add</button>
<ul id="list"></ul>
<p id="count">0 items</p>
<script src="app.js"></script>
</body></html>
EOF`);
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/todo/index.html', 'utf8');
      expect(content).toContain('<input id="inp"');
      expect(content).toContain('<button id="add"');
      expect(content).toContain('style.css');
      expect(content).toContain('app.js');
    });

    it('heredoc writes style.css with dark theme', async () => {
      await run(shell, 'mkdir -p /tmp/todo');
      const { exitCode } = await run(shell, `cat > /tmp/todo/style.css << 'EOF'
body { background: #0f0f23; color: #eee; font-family: system-ui; padding: 20px; }
input { padding: 8px; border-radius: 4px; border: 1px solid #333; background: #1a1a2e; color: #eee; }
button { padding: 8px 16px; background: #6c63ff; color: white; border: none; border-radius: 4px; cursor: pointer; }
ul { list-style: none; padding: 0; }
li { padding: 8px; border-bottom: 1px solid #222; display: flex; gap: 8px; align-items: center; }
.check { cursor: pointer; }
.done { text-decoration: line-through; color: #666; }
EOF`);
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/todo/style.css', 'utf8');
      expect(content).toContain('#0f0f23');
      expect(content).toContain('.done');
    });

    it('heredoc writes app.js with todo logic', async () => {
      await run(shell, 'mkdir -p /tmp/todo');
      const { exitCode } = await run(shell, `cat > /tmp/todo/app.js << 'EOF'
const todos = [];
function addTodo() {
  const inp = document.getElementById('inp');
  if (!inp.value.trim()) return;
  todos.push({ text: inp.value.trim(), done: false });
  inp.value = '';
  render();
}
function toggle(i) {
  todos[i].done = !todos[i].done;
  render();
}
function render() {
  const list = document.getElementById('list');
  list.innerHTML = todos.map((t, i) =>
    '<li><span class="check" onclick="toggle(' + i + ')">' + (t.done ? '✓' : '○') + '</span>' +
    '<span class="' + (t.done ? 'done' : '') + '">' + t.text + '</span></li>'
  ).join('');
  const active = todos.filter(t => !t.done).length;
  document.getElementById('count').textContent = active + ' items';
}
EOF`);
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/todo/app.js', 'utf8');
      expect(content).toContain('function addTodo()');
      expect(content).toContain('function toggle(');
      expect(content).toContain('function render()');
    });

    it('ls shows all 3 project files', async () => {
      await run(shell, 'mkdir -p /tmp/todo');
      await fs.writeFile('/tmp/todo/index.html', '<h1>Todo</h1>');
      await fs.writeFile('/tmp/todo/style.css', 'body {}');
      await fs.writeFile('/tmp/todo/app.js', 'const todos = [];');

      const { output } = await run(shell, 'ls /tmp/todo');
      expect(output).toContain('index.html');
      expect(output).toContain('style.css');
      expect(output).toContain('app.js');
    });
  });

  // ─── B. hc DOM inspection ───

  describe('hc DOM inspection', () => {
    beforeEach(async () => {
      await fs.writeFile('/tmp/hc-test.html', `<!DOCTYPE html>
<html><body>
<h1>Todo App</h1>
<input id="inp" placeholder="Add todo...">
<button id="add">Add</button>
<ul id="list"></ul>
<p id="count">0 items</p>
<a href="/about">About</a>
</body></html>`);
    });

    it('hc open loads HTML file and reports size', async () => {
      const { output, exitCode } = await run(shell, 'hc open /tmp/hc-test.html');
      expect(exitCode).toBe(0);
      expect(output).toContain('opened');
      expect(output).toContain('/tmp/hc-test.html');
    });

    it('hc q finds form elements', async () => {
      await run(shell, 'hc open /tmp/hc-test.html');
      const { output, exitCode } = await run(shell, 'hc q input');
      expect(exitCode).toBe(0);
      expect(output).toContain('[0]');
    });

    it('hc q button finds the Add button', async () => {
      await run(shell, 'hc open /tmp/hc-test.html');
      const { output } = await run(shell, 'hc q button');
      expect(output).toContain('Add');
    });

    it('hc look lists interactive elements', async () => {
      await run(shell, 'hc open /tmp/hc-test.html');
      const { output, exitCode } = await run(shell, 'hc look');
      expect(exitCode).toBe(0);
      expect(output).toContain('elements');
      // Should find the input, button, and link
      expect(output).toContain('<button>');
      expect(output).toContain('<a>');
    });

    it('hc t reads text content', async () => {
      await run(shell, 'hc open /tmp/hc-test.html');
      const { output } = await run(shell, 'hc t');
      expect(output).toContain('Todo App');
      expect(output).toContain('0 items');
    });

    it('hc q1 selects and reads specific element', async () => {
      await run(shell, 'hc open /tmp/hc-test.html');
      const { output } = await run(shell, 'hc q1 #count');
      expect(output).toContain('0 items');
    });

    it('hc close clears the session', async () => {
      await run(shell, 'hc open /tmp/hc-test.html');
      await run(shell, 'hc close');
      const { exitCode } = await run(shell, 'hc t');
      expect(exitCode).toBe(1); // no session
    });

    it('hc with no session returns error', async () => {
      const { exitCode, output } = await run(shell, 'hc t');
      expect(exitCode).toBe(1);
      expect(output).toContain('no session');
    });

    it('hc open on non-existent file returns error', async () => {
      const { exitCode } = await run(shell, 'hc open /tmp/nonexistent.html');
      expect(exitCode).toBe(1);
    });
  });

  // ─── C. grep code search ───

  describe('grep code search', () => {
    beforeEach(async () => {
      await run(shell, 'mkdir -p /tmp/todo');
      await fs.writeFile('/tmp/todo/app.js', [
        'const todos = [];',
        'function addTodo() {',
        '  const inp = document.getElementById("inp");',
        '  todos.push({ text: inp.value.trim(), done: false });',
        '  render();',
        '}',
        'function toggle(i) {',
        '  todos[i].done = !todos[i].done;',
        '  render();',
        '}',
        'function render() {',
        '  const list = document.getElementById("list");',
        '  list.innerHTML = "";',
        '}',
      ].join('\n'));
      await fs.writeFile('/tmp/todo/index.html', '<h1>Todo</h1><script src="app.js"></script>');
      await fs.writeFile('/tmp/todo/style.css', 'body { color: white; }');
    });

    it('grep -rn "function" finds all functions with line numbers', async () => {
      const { output, exitCode } = await run(shell, 'grep -rn "function" /tmp/todo/app.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('2:function addTodo');
      expect(output).toContain('7:function toggle');
      expect(output).toContain('11:function render');
    });

    it('grep -r searches recursively across files', async () => {
      const { output, exitCode } = await run(shell, 'grep -r "function" /tmp/todo');
      expect(exitCode).toBe(0);
      expect(output).toContain('app.js');
      expect(output).toContain('addTodo');
    });

    it('grep -rn with multiple matches shows correct line numbers', async () => {
      const { output } = await run(shell, 'grep -n "render" /tmp/todo/app.js');
      // render() is called on lines 5, 9, and defined on line 11
      expect(output).toContain('render');
      const lines = output.trim().split('\n');
      expect(lines.length).toBe(3);
    });

    it('grep -c counts matches', async () => {
      const { output } = await run(shell, 'grep -c "function" /tmp/todo/app.js');
      expect(output.trim()).toBe('3');
    });

    it('grep -i case-insensitive search', async () => {
      await fs.writeFile('/tmp/todo/README.md', 'TODO Application\ntodo list manager\n');
      const { output } = await run(shell, 'grep -i "todo" /tmp/todo/README.md');
      expect(output).toContain('TODO Application');
      expect(output).toContain('todo list manager');
    });

    it('grep returns exit code 1 when no match', async () => {
      const { exitCode } = await run(shell, 'grep "nonexistent" /tmp/todo/app.js');
      expect(exitCode).toBe(1);
    });
  });

  // ─── D. page interaction ───

  describe('page interaction', () => {
    const iframes: HTMLIFrameElement[] = [];

    function addIframe(port: number, html: string) {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('data-virtual-port', String(port));
      document.body.appendChild(iframe);

      const { document: doc } = parseHTML(html);
      Object.defineProperty(iframe, 'contentDocument', {
        value: doc, writable: true, configurable: true,
      });
      Object.defineProperty(iframe, 'contentWindow', {
        value: {
          eval: (code: string) => {
            const fn = new Function('document', 'todos', 'return ' + code);
            return fn(doc, [{ text: 'Buy groceries', done: false }, { text: 'Write tests', done: false }, { text: 'Deploy app', done: false }]);
          },
        },
        writable: true, configurable: true,
      });
      iframes.push(iframe);
      return iframe;
    }

    afterEach(() => {
      for (const iframe of iframes) iframe.remove();
      iframes.length = 0;
      document.querySelectorAll('[data-virtual-port]').forEach(el => el.remove());
    });

    it('page input sets value on input element', async () => {
      addIframe(6000, `<html><body>
        <input id="inp" value="">
        <button id="add">Add</button>
        <p id="count">0 items</p>
      </body></html>`);
      const iframe = document.querySelector('[data-virtual-port="6000"]') as HTMLIFrameElement;
      const r = await run(shell, 'page :6000 input "#inp" Buy groceries');
      expect(r.exitCode).toBe(0);
      const input = iframe.contentDocument?.getElementById('inp') as HTMLInputElement;
      expect(input.value).toBe('Buy groceries');
    });

    it('page click triggers button click', async () => {
      addIframe(6000, `<html><body>
        <button id="add">Add</button>
      </body></html>`);
      const iframe = document.querySelector('[data-virtual-port="6000"]') as HTMLIFrameElement;
      let clicked = false;
      iframe.contentDocument?.getElementById('add')?.addEventListener('click', () => { clicked = true; });
      const r = await run(shell, 'page :6000 click "#add"');
      expect(r.exitCode).toBe(0);
      expect(clicked).toBe(true);
    });

    it('page text reads element text content', async () => {
      addIframe(6000, `<html><body>
        <p id="count">3 items</p>
      </body></html>`);
      const r = await run(shell, 'page :6000 text "#count"');
      expect(r.exitCode).toBe(0);
      expect(r.output.trim()).toBe('3 items');
    });

    it('page eval runs JS in iframe context', async () => {
      addIframe(6000, `<html><body><div id="n">0</div></body></html>`);
      const r = await run(shell, 'page :6000 eval todos.length');
      expect(r.exitCode).toBe(0);
      expect(r.output.trim()).toBe('3');
    });

    it('page click on .check works with class selector', async () => {
      addIframe(6000, `<html><body>
        <span class="check">○</span>
      </body></html>`);
      const iframe = document.querySelector('[data-virtual-port="6000"]') as HTMLIFrameElement;
      let clicked = false;
      iframe.contentDocument?.querySelector('.check')?.addEventListener('click', () => { clicked = true; });
      const r = await run(shell, 'page :6000 click .check');
      expect(r.exitCode).toBe(0);
      expect(clicked).toBe(true);
    });

    it('page errors on missing element', async () => {
      addIframe(6000, '<html><body></body></html>');
      const r = await run(shell, 'page :6000 click "#nonexistent"');
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('element not found');
    });
  });

  // ─── E. git workflow ───

  describe('git workflow', () => {
    beforeEach(async () => {
      await run(shell, 'mkdir -p /tmp/todo');
      await fs.writeFile('/tmp/todo/index.html', '<h1>Todo</h1>');
      await fs.writeFile('/tmp/todo/style.css', 'body {}');
      await fs.writeFile('/tmp/todo/app.js', 'function addTodo() {}');
    });

    it('git init + add + commit succeeds', async () => {
      const { output: initOut } = await run(shell, 'cd /tmp/todo && git init');
      expect(initOut).toContain('Initialized');

      await run(shell, 'cd /tmp/todo && git add .');
      const { output: commitOut, exitCode } = await run(shell, 'cd /tmp/todo && git commit -m "todo app"');
      expect(exitCode).toBe(0);
      expect(commitOut).toContain('todo app');
    });

    it('git log --oneline shows commit', async () => {
      await run(shell, 'cd /tmp/todo && git init && git add . && git commit -m "todo app"');
      const { output } = await run(shell, 'cd /tmp/todo && git log --oneline');
      expect(output).toContain('todo app');
    });

    it('git status is clean after commit', async () => {
      await run(shell, 'cd /tmp/todo && git init && git add . && git commit -m "init"');
      const { output } = await run(shell, 'cd /tmp/todo && git status');
      // After commit, status should be clean or show "nothing to commit"
      expect(output.toLowerCase()).toMatch(/clean|nothing to commit/);
    });

    it('editing file shows changes in git diff', async () => {
      await run(shell, 'cd /tmp/todo && git init && git add . && git commit -m "init"');
      await fs.writeFile('/tmp/todo/app.js', 'function addTodo() { /* updated */ }');
      const { output } = await run(shell, 'cd /tmp/todo && git diff');
      expect(output).toContain('updated');
    });
  });
});
