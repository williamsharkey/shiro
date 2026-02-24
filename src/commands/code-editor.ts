/**
 * code - Rich code editor powered by CodeMirror 6
 *
 *   code file.js           # Open a file
 *   code src/              # Open directory with file tree
 *   code                   # Open editor in cwd
 */

import { Command, CommandContext } from './index';
import { createServerWindow } from '../server-window';

const CM_CDN = 'https://esm.sh';

function getLanguageForFile(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'javascript', tsx: 'javascript', jsx: 'javascript',
    py: 'python', python: 'python',
    c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    html: 'html', htm: 'html', xml: 'html', svg: 'html',
    css: 'css', scss: 'css', less: 'css',
    json: 'json',
    md: 'markdown', markdown: 'markdown',
    sql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    rs: 'rust',
    go: 'go',
    java: 'java',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
  };
  return map[ext] || 'javascript';
}

function buildEditorHtml(files: { path: string; content: string; language: string }[], cwd: string): string {
  const filesJson = JSON.stringify(files);
  const cwdJson = JSON.stringify(cwd);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { display: flex; height: 100vh; background: #1e1e2e; color: #cdd6f4; font-family: system-ui, -apple-system, sans-serif; }

  /* File tree sidebar */
  #sidebar { width: 200px; background: #181825; border-right: 1px solid #313244; overflow-y: auto; flex-shrink: 0; font-size: 13px; }
  #sidebar.hidden { display: none; }
  .tree-item { padding: 4px 8px 4px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #a6adc8; }
  .tree-item:hover { background: #313244; }
  .tree-item.active { background: #45475a; color: #cdd6f4; }
  .tree-item.dir { color: #89b4fa; }
  .tree-dir-label { padding: 4px 8px; font-weight: 600; color: #585b70; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }

  /* Tab bar */
  #tabs { display: flex; background: #181825; border-bottom: 1px solid #313244; overflow-x: auto; flex-shrink: 0; }
  .tab { padding: 6px 12px; font-size: 12px; cursor: pointer; border-right: 1px solid #313244; color: #a6adc8; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .tab:hover { background: #313244; }
  .tab.active { background: #1e1e2e; color: #cdd6f4; border-bottom: 2px solid #89b4fa; }
  .tab .dot { width: 6px; height: 6px; border-radius: 50%; background: #f9e2af; display: none; }
  .tab.modified .dot { display: block; }
  .tab .close { font-size: 14px; color: #585b70; margin-left: 4px; }
  .tab .close:hover { color: #f38ba8; }

  /* Editor area */
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #editor-container { flex: 1; overflow: hidden; }

  /* Status bar */
  #status { height: 24px; background: #181825; border-top: 1px solid #313244; display: flex; align-items: center; padding: 0 12px; font-size: 11px; color: #585b70; gap: 16px; }
  #status .saved { color: #a6e3a1; }

  /* Toggle sidebar button */
  #toggle-sidebar { background: none; border: none; color: #585b70; font-size: 16px; cursor: pointer; padding: 2px 6px; }
  #toggle-sidebar:hover { color: #cdd6f4; }

  /* CodeMirror theme overrides */
  .cm-editor { height: 100%; font-size: 14px; }
  .cm-editor .cm-scroller { overflow: auto; }
  .cm-editor.cm-focused { outline: none; }
</style>
</head>
<body>
<div id="sidebar"></div>
<div id="main">
  <div id="tabs"></div>
  <div id="editor-container"></div>
  <div id="status">
    <button id="toggle-sidebar" title="Toggle sidebar">&#9776;</button>
    <span id="status-file"></span>
    <span id="status-pos"></span>
    <span id="status-msg"></span>
  </div>
</div>

<script type="module">
const CDN = ${JSON.stringify(CM_CDN)};
const FILES = ${filesJson};
const CWD = ${cwdJson};

// Dynamic import from CDN
const [
  { EditorState },
  { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine, rectangularSelection, crosshairCursor },
  { defaultKeymap, history, historyKeymap, indentWithTab },
  { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap },
  { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap },
  { searchKeymap, highlightSelectionMatches },
  { javascript },
  { oneDark },
] = await Promise.all([
  import(CDN + '/@codemirror/state@6'),
  import(CDN + '/@codemirror/view@6'),
  import(CDN + '/@codemirror/commands@6'),
  import(CDN + '/@codemirror/language@6'),
  import(CDN + '/@codemirror/autocomplete@6'),
  import(CDN + '/@codemirror/search@6'),
  import(CDN + '/@codemirror/lang-javascript@6'),
  import(CDN + '/@codemirror/theme-one-dark@6'),
]);

// Additional language modules (loaded on demand)
const langModules = {};
async function getLang(name) {
  if (name === 'javascript') return javascript();
  if (langModules[name]) return langModules[name];
  try {
    const m = await import(CDN + '/@codemirror/lang-' + name + '@6');
    const fn = m[name] || m[Object.keys(m).find(k => typeof m[k] === 'function')];
    if (fn) { langModules[name] = fn(); return langModules[name]; }
  } catch {}
  return javascript(); // fallback
}

// State
const openFiles = new Map(); // path -> { content, view, modified, original }
let activeFile = null;
let view = null;

const sidebar = document.getElementById('sidebar');
const tabsEl = document.getElementById('tabs');
const editorContainer = document.getElementById('editor-container');
const statusFile = document.getElementById('status-file');
const statusPos = document.getElementById('status-pos');
const statusMsg = document.getElementById('status-msg');

// Build sidebar
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
      item.onclick = () => openFile(f.path);
      item.dataset.path = f.path;
      sidebar.appendChild(item);
    }
  }
}

// Tabs
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const [path, state] of openFiles) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === activeFile ? ' active' : '') + (state.modified ? ' modified' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.textContent = path.split('/').pop();
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '\\u00d7';
    close.onclick = (e) => { e.stopPropagation(); closeFile(path); };
    tab.appendChild(dot);
    tab.appendChild(name);
    tab.appendChild(close);
    tab.onclick = () => switchTo(path);
    tabsEl.appendChild(tab);
  }
}

async function openFile(path) {
  if (!openFiles.has(path)) {
    const f = FILES.find(f => f.path === path);
    if (!f) return;
    const lang = await getLang(f.language);
    const state = EditorState.create({
      doc: f.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        lang,
        oneDark,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
          { key: 'Mod-s', run: () => { saveFile(activeFile); return true; } },
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && activeFile) {
            const state = openFiles.get(activeFile);
            if (state) {
              state.content = update.state.doc.toString();
              state.modified = state.content !== state.original;
              renderTabs();
            }
          }
          if (update.selectionSet) {
            const pos = update.state.selection.main.head;
            const line = update.state.doc.lineAt(pos);
            statusPos.textContent = 'Ln ' + line.number + ', Col ' + (pos - line.from + 1);
          }
        }),
      ],
    });
    openFiles.set(path, { content: f.content, original: f.content, editorState: state, modified: false });
  }
  switchTo(path);
}

function switchTo(path) {
  // Save current view state
  if (activeFile && view) {
    openFiles.get(activeFile).editorState = view.state;
  }
  activeFile = path;

  const state = openFiles.get(path);
  if (!state) return;

  // Replace editor
  editorContainer.innerHTML = '';
  view = new EditorView({
    state: state.editorState,
    parent: editorContainer,
  });
  view.focus();

  statusFile.textContent = path;
  renderTabs();

  // Highlight sidebar
  sidebar.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === path);
  });
}

function closeFile(path) {
  openFiles.delete(path);
  if (activeFile === path) {
    const remaining = [...openFiles.keys()];
    if (remaining.length > 0) {
      switchTo(remaining[remaining.length - 1]);
    } else {
      activeFile = null;
      editorContainer.innerHTML = '';
      statusFile.textContent = '';
    }
  }
  renderTabs();
}

async function saveFile(path) {
  if (!path) return;
  const state = openFiles.get(path);
  if (!state) return;

  // Save current editor content
  if (view) state.content = view.state.doc.toString();

  // Send save message to parent
  window.parent.postMessage({
    type: 'shiro-editor-save',
    path: path,
    content: state.content,
  }, '*');

  state.original = state.content;
  state.modified = false;
  renderTabs();

  statusMsg.innerHTML = '<span class="saved">Saved</span>';
  setTimeout(() => { statusMsg.textContent = ''; }, 2000);
}

// Toggle sidebar
document.getElementById('toggle-sidebar').onclick = () => {
  sidebar.classList.toggle('hidden');
};

// Init
renderSidebar();
if (FILES.length > 0) openFile(FILES[0].path);
</script>
</body>
</html>`;
}

export const codeEditorCmd: Command = {
  name: 'code',
  description: 'Rich code editor (CodeMirror)',
  async exec(ctx: CommandContext): Promise<number> {
    const target = ctx.args[0] || '.';
    const resolved = ctx.fs.resolvePath(target, ctx.cwd);

    // Collect files to open
    const files: { path: string; content: string; language: string }[] = [];

    try {
      const s = await ctx.fs.stat(resolved);
      if (s.type === 'dir') {
        // Open directory — list files (non-recursive, skip hidden)
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
        // Sort and limit to 50 files
        fileEntries.sort();
        for (const entry of fileEntries.slice(0, 50)) {
          const entryPath = resolved === '/' ? `/${entry}` : `${resolved}/${entry}`;
          try {
            const data = await ctx.fs.readFile(entryPath, 'utf8');
            const content = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
            // Skip binary files
            if (content.includes('\0')) continue;
            const relPath = target === '.' ? entry : `${target}/${entry}`;
            files.push({ path: relPath, content, language: getLanguageForFile(entry) });
          } catch {}
        }
      } else {
        // Single file
        const data = await ctx.fs.readFile(resolved, 'utf8');
        const content = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
        const displayPath = ctx.args[0] || resolved.split('/').pop() || 'untitled';
        files.push({ path: displayPath, content, language: getLanguageForFile(resolved) });
      }
    } catch (e: any) {
      ctx.stderr = `code: ${e.message}\n`;
      return 1;
    }

    if (files.length === 0) {
      // Open empty editor
      files.push({ path: 'untitled.js', content: '', language: 'javascript' });
    }

    const html = buildEditorHtml(files, ctx.cwd);

    const win = createServerWindow({
      mode: 'iframe',
      title: target === '.' ? ctx.cwd.split('/').pop() || 'code' : target,
      width: '52em',
      height: '32em',
    });
    win.updateIframe(html);

    // Listen for save messages from the editor iframe
    const handler = async (e: MessageEvent) => {
      if (e.data?.type !== 'shiro-editor-save') return;
      const { path, content } = e.data;
      // Resolve relative to the opened target
      let savePath: string;
      try {
        const s = await ctx.fs.stat(resolved);
        if (s.type === 'dir') {
          // Strip leading target prefix if present
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
        console.error(`code: save error: ${err.message}`);
      }
    };
    window.addEventListener('message', handler);

    // Clean up listener when window is closed
    const origClose = win.close;
    win.close = () => {
      window.removeEventListener('message', handler);
      origClose();
    };

    return 0;
  },
};
