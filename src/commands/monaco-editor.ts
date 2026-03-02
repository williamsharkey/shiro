/**
 * monaco - VS Code editor powered by Monaco Editor
 *
 *   monaco file.ts          # Open a file
 *   monaco src/             # Open directory with file tree
 *   monaco                  # Open editor in cwd
 */

import { Command, CommandContext } from './index';
import { createServerWindow } from '../server-window';

const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';

function getLanguageForFile(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    py: 'python', python: 'python',
    c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', jsonc: 'json',
    md: 'markdown', markdown: 'markdown',
    xml: 'xml', svg: 'xml',
    sql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    rs: 'rust',
    go: 'go',
    java: 'java',
    yaml: 'yaml', yml: 'yaml',
    rb: 'ruby',
    php: 'php',
    txt: 'plaintext',
  };
  return map[ext] || 'plaintext';
}

function buildMonacoHtml(files: { path: string; content: string; language: string }[], cwd: string): string {
  const filesJson = JSON.stringify(files);
  const cwdJson = JSON.stringify(cwd);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { display: flex; height: 100vh; background: #1e1e1e; color: #cccccc; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; }

  /* File tree sidebar */
  #sidebar { width: 200px; background: #252526; border-right: 1px solid #3c3c3c; overflow-y: auto; flex-shrink: 0; font-size: 13px; }
  #sidebar.hidden { display: none; }
  .tree-item { padding: 4px 8px 4px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #bbbbbb; }
  .tree-item:hover { background: #2a2d2e; }
  .tree-item.active { background: #37373d; color: #ffffff; }
  .tree-item.dir { color: #75beff; }
  .tree-dir-label { padding: 4px 8px; font-weight: 600; color: #888888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }

  /* Tab bar */
  #tabs { display: flex; background: #252526; border-bottom: 1px solid #3c3c3c; overflow-x: auto; flex-shrink: 0; }
  .tab { padding: 6px 12px; font-size: 12px; cursor: pointer; border-right: 1px solid #3c3c3c; color: #969696; display: flex; align-items: center; gap: 6px; white-space: nowrap; background: #2d2d2d; }
  .tab:hover { background: #2a2d2e; }
  .tab.active { background: #1e1e1e; color: #ffffff; border-bottom: none; }
  .tab .dot { width: 6px; height: 6px; border-radius: 50%; background: #e8ab53; display: none; }
  .tab.modified .dot { display: block; }
  .tab .close { font-size: 14px; color: #666666; margin-left: 4px; }
  .tab .close:hover { color: #e06c75; }

  /* Editor area */
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #editor-container { flex: 1; overflow: hidden; }

  /* Status bar */
  #status { height: 22px; background: #007acc; display: flex; align-items: center; padding: 0 12px; font-size: 11px; color: #ffffff; gap: 16px; }
  #status .saved { color: #73c991; font-weight: bold; }

  /* Toggle sidebar button */
  #toggle-sidebar { background: none; border: none; color: #ffffff; font-size: 14px; cursor: pointer; padding: 2px 6px; opacity: 0.8; }
  #toggle-sidebar:hover { opacity: 1; }

  /* Loading state */
  #loading { display: flex; align-items: center; justify-content: center; height: 100%; color: #888; font-size: 14px; }
</style>
</head>
<body>
<div id="sidebar"></div>
<div id="main">
  <div id="tabs"></div>
  <div id="editor-container"><div id="loading">Loading Monaco Editor...</div></div>
  <div id="status">
    <button id="toggle-sidebar" title="Toggle sidebar">&#9776;</button>
    <span id="status-file"></span>
    <span id="status-pos"></span>
    <span id="status-msg"></span>
  </div>
</div>

<script>
const MONACO_CDN = ${JSON.stringify(MONACO_CDN)};
const FILES = ${filesJson};
const CWD = ${cwdJson};

/* State */
const models = new Map();       /* path -> monaco.editor.ITextModel */
const viewStates = new Map();   /* path -> editor.saveViewState() */
const modified = new Set();     /* paths with unsaved changes */
const originals = new Map();    /* path -> original content */
let activeFile = null;
let editor = null;

const sidebar = document.getElementById('sidebar');
const tabsEl = document.getElementById('tabs');
const editorContainer = document.getElementById('editor-container');
const statusFile = document.getElementById('status-file');
const statusPos = document.getElementById('status-pos');
const statusMsg = document.getElementById('status-msg');

/* Load Monaco via AMD loader */
const loaderScript = document.createElement('script');
loaderScript.src = MONACO_CDN + '/vs/loader.js';
loaderScript.onload = function() {
  require.config({ paths: { vs: MONACO_CDN + '/vs' } });
  require(['vs/editor/editor.main'], function() {
    document.getElementById('loading')?.remove();
    initEditor();
  });
};
document.head.appendChild(loaderScript);

function initEditor() {
  /* Create the single editor instance */
  editor = monaco.editor.create(editorContainer, {
    theme: 'vs-dark',
    fontSize: 14,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    padding: { top: 4 },
  });

  /* Cmd/Ctrl+S save */
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function() {
    saveFile(activeFile);
  });

  /* Cursor position tracking */
  editor.onDidChangeCursorPosition(function(e) {
    statusPos.textContent = 'Ln ' + e.position.lineNumber + ', Col ' + e.position.column;
  });

  /* Build sidebar + open first file */
  renderSidebar();
  if (FILES.length > 0) openFile(FILES[0].path);
}

/* Sidebar */
function renderSidebar() {
  sidebar.innerHTML = '';
  const dirs = new Map();
  for (const f of FILES) {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  for (const [dir, files] of dirs) {
    if (dirs.size > 1) {
      const label = document.createElement('div');
      label.className = 'tree-dir-label';
      label.textContent = dir;
      sidebar.appendChild(label);
    }
    for (const f of files) {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.textContent = f.path.split('/').pop();
      item.title = f.path;
      item.onclick = function() { openFile(f.path); };
      item.dataset.path = f.path;
      sidebar.appendChild(item);
    }
  }
}

/* Tabs */
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const path of models.keys()) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === activeFile ? ' active' : '') + (modified.has(path) ? ' modified' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.textContent = path.split('/').pop();
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '\\u00d7';
    close.onclick = function(e) { e.stopPropagation(); closeFile(path); };
    tab.appendChild(dot);
    tab.appendChild(name);
    tab.appendChild(close);
    tab.onclick = function() { switchTo(path); };
    tabsEl.appendChild(tab);
  }
}

function openFile(path) {
  if (!models.has(path)) {
    const f = FILES.find(function(f) { return f.path === path; });
    if (!f) return;
    const uri = monaco.Uri.parse('file:///' + path);
    const model = monaco.editor.createModel(f.content, f.language, uri);
    models.set(path, model);
    originals.set(path, f.content);

    model.onDidChangeContent(function() {
      const current = model.getValue();
      if (current !== originals.get(path)) {
        modified.add(path);
      } else {
        modified.delete(path);
      }
      renderTabs();
    });
  }
  switchTo(path);
}

function switchTo(path) {
  if (!models.has(path)) return;

  /* Save view state of current file */
  if (activeFile && editor) {
    viewStates.set(activeFile, editor.saveViewState());
  }

  activeFile = path;
  const model = models.get(path);
  editor.setModel(model);

  /* Restore view state if we had one */
  const vs = viewStates.get(path);
  if (vs) editor.restoreViewState(vs);

  editor.focus();
  statusFile.textContent = path;
  renderTabs();

  /* Highlight sidebar */
  sidebar.querySelectorAll('.tree-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.path === path);
  });
}

function closeFile(path) {
  const model = models.get(path);
  if (model) model.dispose();
  models.delete(path);
  viewStates.delete(path);
  modified.delete(path);
  originals.delete(path);

  if (activeFile === path) {
    const remaining = Array.from(models.keys());
    if (remaining.length > 0) {
      switchTo(remaining[remaining.length - 1]);
    } else {
      activeFile = null;
      editor.setModel(null);
      statusFile.textContent = '';
    }
  }
  renderTabs();
}

function saveFile(path) {
  if (!path) return;
  const model = models.get(path);
  if (!model) return;

  const content = model.getValue();

  window.parent.postMessage({
    type: 'shiro-editor-save',
    path: path,
    content: content,
  }, '*');

  originals.set(path, content);
  modified.delete(path);
  renderTabs();

  statusMsg.innerHTML = '<span class="saved">Saved</span>';
  setTimeout(function() { statusMsg.textContent = ''; }, 2000);
}

/* Toggle sidebar */
document.getElementById('toggle-sidebar').onclick = function() {
  sidebar.classList.toggle('hidden');
};
</script>
</body>
</html>`;
}

export const monacoEditorCmd: Command = {
  name: 'monaco',
  description: 'VS Code editor (Monaco)',
  async exec(ctx: CommandContext): Promise<number> {
    const target = ctx.args[0] || '.';
    const resolved = ctx.fs.resolvePath(target, ctx.cwd);

    const files: { path: string; content: string; language: string }[] = [];

    try {
      const s = await ctx.fs.stat(resolved);
      if (s.type === 'dir') {
        const entries = await ctx.fs.readdir(resolved);
        const fileEntries: string[] = [];
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const entryPath = resolved === '/' ? `/${entry}` : `${resolved}/${entry}`;
          try {
            const es = await ctx.fs.stat(entryPath);
            if (es.type === 'file') fileEntries.push(entry);
          } catch {}
        }
        fileEntries.sort();
        for (const entry of fileEntries.slice(0, 50)) {
          const entryPath = resolved === '/' ? `/${entry}` : `${resolved}/${entry}`;
          try {
            const data = await ctx.fs.readFile(entryPath, 'utf8');
            const content = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
            if (content.includes('\0')) continue;
            const relPath = target === '.' ? entry : `${target}/${entry}`;
            files.push({ path: relPath, content, language: getLanguageForFile(entry) });
          } catch {}
        }
      } else {
        const data = await ctx.fs.readFile(resolved, 'utf8');
        const content = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
        const displayPath = ctx.args[0] || resolved.split('/').pop() || 'untitled';
        files.push({ path: displayPath, content, language: getLanguageForFile(resolved) });
      }
    } catch (e: any) {
      ctx.stderr = `monaco: ${e.message}\n`;
      return 1;
    }

    if (files.length === 0) {
      files.push({ path: 'untitled.ts', content: '', language: 'typescript' });
    }

    const html = buildMonacoHtml(files, ctx.cwd);

    const win = createServerWindow({
      mode: 'iframe',
      title: target === '.' ? ctx.cwd.split('/').pop() || 'monaco' : target,
      width: '56em',
      height: '34em',
    });
    win.updateIframe(html);

    // Listen for save messages from the editor iframe
    const handler = async (e: MessageEvent) => {
      if (e.data?.type !== 'shiro-editor-save') return;
      const { path, content } = e.data;
      let savePath: string;
      try {
        const s = await ctx.fs.stat(resolved);
        if (s.type === 'dir') {
          const cleanPath = path.startsWith(target + '/') ? path.slice(target.length + 1) : path;
          savePath = resolved === '/' ? `/${cleanPath}` : `${resolved}/${cleanPath}`;
        } else {
          savePath = resolved;
        }
      } catch {
        savePath = resolved;
      }
      try {
        await ctx.fs.writeFile(savePath, content);
      } catch (err: any) {
        console.error(`monaco: save error: ${err.message}`);
      }
    };
    window.addEventListener('message', handler);

    const origClose = win.close;
    win.close = () => {
      window.removeEventListener('message', handler);
      origClose();
    };

    return 0;
  },
};
