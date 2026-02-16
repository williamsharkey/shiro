// ide-html.ts — Generates the complete IDE HTML interface
// Single inline HTML with CSS + JS, loaded via CodeMirror 6 from esm.sh CDN

export function generateIdeHtml(projectDir: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shiro IDE</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0a0a1a;
  --surface: #1a1a2e;
  --surface2: #16213e;
  --border: #2a2a4a;
  --text: #e0e0e0;
  --text-dim: #888;
  --accent: #6c63ff;
  --accent-dim: #4a44b3;
  --red: #ff6b6b;
  --green: #51cf66;
  --yellow: #ffd43b;
  --cyan: #66d9ef;
  --orange: #ff922b;
  --font: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
html, body { height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: var(--font-ui); font-size: 13px; }

/* Grid layout */
#ide-root {
  display: grid;
  grid-template-rows: 28px 24px 1fr auto;
  grid-template-columns: 220px 1fr;
  height: 100vh;
  overflow: hidden;
}

/* Menu bar */
#menu-bar {
  grid-column: 1 / -1;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 8px;
  gap: 2px;
  user-select: none;
  z-index: 100;
}
.menu-item {
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-dim);
  position: relative;
}
.menu-item:hover, .menu-item.active { background: var(--accent); color: #fff; }
.menu-item .hotkey { color: var(--accent); margin-left: 2px; font-size: 10px; }
.menu-item:hover .hotkey, .menu-item.active .hotkey { color: #fff; }
#menu-bar .logo { font-weight: 700; color: var(--accent); margin-right: 12px; font-size: 13px; letter-spacing: 1px; }

/* Dropdown menu */
.dropdown-menu {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 200px;
  padding: 4px 0;
  z-index: 200;
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
}
.dropdown-menu.visible { display: block; }
.dropdown-item {
  padding: 6px 16px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.dropdown-item:hover { background: var(--accent); color: #fff; }
.dropdown-item .shortcut { color: var(--text-dim); font-size: 11px; }
.dropdown-item:hover .shortcut { color: rgba(255,255,255,.7); }
.dropdown-sep { height: 1px; background: var(--border); margin: 4px 0; }

/* Suggestions bar */
#suggestions-bar {
  grid-column: 1 / -1;
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 8px;
  overflow-x: auto;
  font-size: 11px;
}
.suggestion-pill {
  background: var(--border);
  color: var(--text);
  padding: 2px 10px;
  border-radius: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background .15s;
}
.suggestion-pill:hover { background: var(--accent); color: #fff; }
.suggestion-pill.warn { border: 1px solid var(--yellow); }

/* File tree */
#file-tree {
  grid-row: 3 / 5;
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
  font-size: 12px;
  user-select: none;
}
#file-tree.hidden { display: none; }
#ide-root.sidebar-hidden { grid-template-columns: 0px 1fr; }
#ide-root.sidebar-hidden #file-tree { display: none; }
.tree-item {
  padding: 3px 8px;
  padding-left: calc(8px + var(--depth, 0) * 16px);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.tree-item:hover { background: var(--border); }
.tree-item.selected { background: var(--accent-dim); color: #fff; }
.tree-item .icon { width: 16px; text-align: center; font-size: 12px; flex-shrink: 0; }
.tree-item .name { overflow: hidden; text-overflow: ellipsis; flex: 1; }
.tree-item .git-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.tree-item .git-dot.modified { background: var(--yellow); }
.tree-item .git-dot.untracked { background: var(--cyan); }
.tree-item .git-dot.added { background: var(--green); }
.tree-header {
  padding: 8px 12px 4px;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-dim);
  letter-spacing: 1px;
}

/* Editor area */
#editor-area {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

/* Tab bar */
#tab-bar {
  display: flex;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  flex-shrink: 0;
  height: 32px;
}
.tab {
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 6px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  color: var(--text-dim);
  min-width: 0;
  position: relative;
}
.tab:hover { background: var(--border); }
.tab.active { background: var(--bg); color: var(--text); border-bottom: 2px solid var(--accent); }
.tab .modified-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.tab .close-btn { opacity: 0; font-size: 14px; line-height: 1; cursor: pointer; color: var(--text-dim); }
.tab:hover .close-btn { opacity: 1; }
.tab .close-btn:hover { color: var(--red); }

/* Editor container */
#editor-container {
  flex: 1;
  overflow: hidden;
  position: relative;
  display: flex;
}
#editor-pane {
  flex: 1;
  overflow: hidden;
  position: relative;
}
#editor-pane .cm-editor { height: 100%; }
#editor-pane .cm-scroller { overflow: auto; }
#welcome-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  gap: 16px;
}
#welcome-screen h2 { font-size: 20px; color: var(--text); font-weight: 400; }
#welcome-screen p { font-size: 13px; }
#welcome-screen kbd {
  background: var(--surface);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  font-family: var(--font);
  font-size: 12px;
}

/* Preview pane */
#preview-pane {
  width: 40%;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: #fff;
}
#preview-pane.hidden { display: none; }
#preview-bar {
  display: flex;
  align-items: center;
  height: 28px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 8px;
  gap: 6px;
}
#preview-bar input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  padding: 2px 8px;
  font-size: 11px;
  font-family: var(--font);
}
#preview-bar button {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
}
#preview-bar button:hover { color: var(--text); }
#preview-iframe {
  flex: 1;
  border: none;
  width: 100%;
  background: #fff;
}

/* Bottom panel */
#bottom-panel {
  grid-column: 2 / -1;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-top: 1px solid var(--border);
  height: 200px;
  min-height: 80px;
}
#bottom-panel.hidden { display: none; }
#bottom-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.bottom-tab {
  padding: 4px 16px;
  font-size: 11px;
  cursor: pointer;
  color: var(--text-dim);
  border-bottom: 2px solid transparent;
  text-transform: uppercase;
  letter-spacing: .5px;
}
.bottom-tab:hover { color: var(--text); }
.bottom-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.bottom-content { flex: 1; overflow: hidden; display: none; }
.bottom-content.active { display: flex; flex-direction: column; }

/* Terminal panel */
#panel-terminal {
  flex: 1;
  display: flex;
  flex-direction: column;
}
#terminal-output {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: var(--font);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg);
}
.term-line { line-height: 1.5; }
.term-line.cmd { color: var(--cyan); }
.term-line.stdout { color: var(--text); }
.term-line.stderr { color: var(--red); }
#terminal-input-row {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}
#terminal-input-row .prompt { color: var(--accent); margin-right: 6px; font-family: var(--font); font-size: 12px; }
#terminal-input {
  flex: 1;
  background: none;
  border: none;
  color: var(--text);
  font-family: var(--font);
  font-size: 12px;
  outline: none;
}

/* Output panel */
#panel-output {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: var(--font);
  font-size: 12px;
  white-space: pre-wrap;
  background: var(--bg);
}

/* Claude panel */
#panel-claude {
  flex: 1;
  display: flex;
  flex-direction: column;
}
#claude-messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  background: var(--bg);
}
.claude-msg { margin-bottom: 12px; }
.claude-msg .role { font-size: 10px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 2px; }
.claude-msg.user .role { color: var(--accent); }
.claude-msg.assistant .role { color: var(--green); }
.claude-msg .body {
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.claude-msg.assistant .body { font-family: var(--font-ui); }
#claude-input-row {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}
#claude-input {
  flex: 1;
  background: none;
  border: none;
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 12px;
  outline: none;
}
#claude-input::placeholder { color: var(--text-dim); }

/* Slash menu overlay */
#slash-menu {
  display: none;
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  min-width: 320px;
  max-width: 400px;
  padding: 8px 0;
  z-index: 1000;
  box-shadow: 0 12px 40px rgba(0,0,0,.6);
}
#slash-menu.visible { display: block; }
#slash-menu .title {
  padding: 8px 16px;
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 1px;
  border-bottom: 1px solid var(--border);
}
.slash-item {
  padding: 8px 16px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}
.slash-item:hover, .slash-item.highlighted { background: var(--accent); color: #fff; }
.slash-item .key {
  background: var(--border);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: var(--font);
  font-size: 11px;
  color: var(--accent);
}
.slash-item:hover .key, .slash-item.highlighted .key { background: rgba(255,255,255,.2); color: #fff; }

/* Scaffold modal */
#scaffold-modal {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.6);
  z-index: 2000;
  align-items: center;
  justify-content: center;
}
#scaffold-modal.visible { display: flex; }
#scaffold-modal .modal-content {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  width: 480px;
  max-width: 90vw;
}
#scaffold-modal h3 { margin-bottom: 16px; font-size: 16px; font-weight: 500; }
.template-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}
.template-card {
  padding: 12px;
  background: var(--bg);
  border: 2px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  text-align: center;
  transition: border-color .15s;
}
.template-card:hover { border-color: var(--accent); }
.template-card.selected { border-color: var(--accent); background: var(--accent-dim); }
.template-card .emoji { font-size: 24px; margin-bottom: 4px; }
.template-card .label { font-size: 12px; }
#scaffold-name {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  margin-bottom: 12px;
  outline: none;
}
#scaffold-name:focus { border-color: var(--accent); }
.modal-buttons { display: flex; justify-content: flex-end; gap: 8px; }
.modal-buttons button {
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}
.modal-buttons button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.modal-buttons button:hover { opacity: .9; }

/* Resize handle */
#bottom-resize {
  height: 4px;
  cursor: ns-resize;
  background: transparent;
  grid-column: 2 / -1;
}
#bottom-resize:hover { background: var(--accent); }

/* Scrollbar */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }

/* Loading overlay */
#loading-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5000;
  flex-direction: column;
  gap: 12px;
}
#loading-overlay .spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<div id="loading-overlay">
  <div class="spinner"></div>
  <div style="color:var(--text-dim);font-size:12px">Loading CodeMirror...</div>
</div>

<div id="ide-root">
  <!-- Menu bar -->
  <div id="menu-bar">
    <span class="logo">SHIRO IDE</span>
    <div class="menu-item" data-menu="file">File</div>
    <div class="menu-item" data-menu="edit">Edit</div>
    <div class="menu-item" data-menu="view">View</div>
    <div class="menu-item" data-menu="build">Build</div>
    <div class="menu-item" data-menu="git">Git</div>
    <div class="menu-item" data-menu="project">Project</div>
    <div class="menu-item" data-menu="claude">Claude</div>
  </div>

  <!-- Suggestions bar -->
  <div id="suggestions-bar"></div>

  <!-- File tree -->
  <div id="file-tree">
    <div class="tree-header">Explorer</div>
    <div id="tree-content"></div>
  </div>

  <!-- Editor area + preview -->
  <div id="editor-area">
    <div id="tab-bar"></div>
    <div id="editor-container">
      <div id="editor-pane">
        <div id="welcome-screen">
          <h2>Shiro IDE</h2>
          <p>Press <kbd>/</kbd> for commands &middot; Click a file to edit</p>
          <p style="font-size:11px;color:var(--text-dim)">Project: <code>${projectDir}</code></p>
        </div>
      </div>
      <div id="preview-pane" class="hidden">
        <div id="preview-bar">
          <button id="preview-back" title="Back">&larr;</button>
          <input id="preview-url" value="/" readonly>
          <button id="preview-refresh" title="Refresh">&#x21bb;</button>
          <button id="preview-close" title="Close">&times;</button>
        </div>
        <iframe id="preview-iframe" sandbox="allow-scripts allow-same-origin"></iframe>
      </div>
    </div>
  </div>

  <!-- Bottom panel -->
  <div id="bottom-panel">
    <div id="bottom-tabs">
      <div class="bottom-tab active" data-panel="terminal">Terminal</div>
      <div class="bottom-tab" data-panel="output">Output</div>
      <div class="bottom-tab" data-panel="claude">Claude</div>
    </div>
    <div class="bottom-content active" data-panel="terminal" id="panel-terminal">
      <div id="terminal-output"></div>
      <div id="terminal-input-row">
        <span class="prompt">$</span>
        <input id="terminal-input" placeholder="Run a command..." autocomplete="off" spellcheck="false">
      </div>
    </div>
    <div class="bottom-content" data-panel="output" id="panel-output"></div>
    <div class="bottom-content" data-panel="claude" id="panel-claude">
      <div id="claude-messages"></div>
      <div id="claude-input-row">
        <input id="claude-input" placeholder="Ask Claude..." autocomplete="off" spellcheck="false">
      </div>
    </div>
  </div>
</div>

<!-- Slash menu -->
<div id="slash-menu"></div>

<!-- Scaffold modal -->
<div id="scaffold-modal">
  <div class="modal-content">
    <h3>New Project</h3>
    <div class="template-grid" id="template-grid"></div>
    <input id="scaffold-name" placeholder="Project name..." autocomplete="off" spellcheck="false">
    <div class="modal-buttons">
      <button id="scaffold-cancel">Cancel</button>
      <button id="scaffold-create" class="primary">Create</button>
    </div>
  </div>
</div>

<script type="module">
// ─── Configuration ───
const PROJECT_DIR = ${JSON.stringify(projectDir)};

// ─── API helpers ───
const api = {
  async call(endpoint, data) {
    const res = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    });
    return res.json();
  },
  fs: {
    read: (path) => api.call('fs/read', { path }),
    write: (path, content) => api.call('fs/write', { path, content }),
    readdir: (path) => api.call('fs/readdir', { path }),
    stat: (path) => api.call('fs/stat', { path }),
    mkdir: (path) => api.call('fs/mkdir', { path, recursive: true }),
    rm: (path, recursive) => api.call('fs/rm', { path, recursive }),
    rename: (oldPath, newPath) => api.call('fs/rename', { oldPath, newPath }),
    glob: (pattern, base) => api.call('fs/glob', { pattern, base }),
  },
  shell: {
    exec: (command) => api.call('shell/exec', { command }),
  },
  git: {
    status: () => api.call('git/status'),
    log: (n) => api.call('git/log', { n: n || 20 }),
    diff: (cached) => api.call('git/diff', { cached }),
    commit: (message, files) => api.call('git/commit', { message, files }),
    push: () => api.call('git/push'),
    pull: () => api.call('git/pull'),
  },
  claude: {
    prompt: (text) => api.call('claude/prompt', { prompt: text }),
  },
  project: {
    scaffold: (template, name) => api.call('project/scaffold', { template, name }),
  },
};

// ─── CodeMirror loading ───
let cmState, cmView, cmCommands, cmLangJS, cmLangHTML, cmLangCSS, cmLangJSON, cmLangMD, cmOneDark, cmBasicSetup;
async function loadCodeMirror() {
  /* Load all CM packages from esm.sh with ?deps to force shared @codemirror/state
     and @codemirror/view — prevents duplicate-instance instanceof failures. */
  const B = 'https://esm.sh';
  const D = '?deps=@codemirror/state@6,@codemirror/view@6';
  try {
    const [stMod, vwMod, cmMod, jsM, htM, csM, jnM, mdM, thM, cmdM] = await Promise.all([
      import(/* @vite-ignore */ B + '/@codemirror/state@6'),
      import(/* @vite-ignore */ B + '/@codemirror/view@6?deps=@codemirror/state@6'),
      import(/* @vite-ignore */ B + '/codemirror@6' + D),
      import(/* @vite-ignore */ B + '/@codemirror/lang-javascript@6' + D),
      import(/* @vite-ignore */ B + '/@codemirror/lang-html@6' + D),
      import(/* @vite-ignore */ B + '/@codemirror/lang-css@6' + D),
      import(/* @vite-ignore */ B + '/@codemirror/lang-json@6' + D),
      import(/* @vite-ignore */ B + '/@codemirror/lang-markdown@6' + D),
      import(/* @vite-ignore */ B + '/@codemirror/theme-one-dark@6' + D),
      import(/* @vite-ignore */ B + '/@codemirror/commands@6' + D),
    ]);
    cmState = stMod;
    cmView = vwMod;
    cmBasicSetup = cmMod.basicSetup;
    cmLangJS = jsM;
    cmLangHTML = htM;
    cmLangCSS = csM;
    cmLangJSON = jnM;
    cmLangMD = mdM;
    cmOneDark = thM.oneDark;
    cmCommands = cmdM;
    return true;
  } catch (err) {
    console.error('Failed to load CodeMirror:', err);
    return false;
  }
}

// ─── Language detection ───
function langForFile(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return cmLangJS.javascript();
    case 'ts': case 'mts': case 'cts': return cmLangJS.javascript({ typescript: true });
    case 'jsx': return cmLangJS.javascript({ jsx: true });
    case 'tsx': return cmLangJS.javascript({ typescript: true, jsx: true });
    case 'html': case 'htm': case 'svg': return cmLangHTML.html();
    case 'css': return cmLangCSS.css();
    case 'json': return cmLangJSON.json();
    case 'md': case 'mdx': case 'markdown': return cmLangMD.markdown();
    default: return null;
  }
}

// ─── File type icons ───
function fileIcon(name, isDir) {
  if (isDir) return '\\ud83d\\udcc1';
  const ext = name.split('.').pop()?.toLowerCase();
  const icons = {
    js: '\\ud83d\\udfe8', ts: '\\ud83d\\udfe6', jsx: '\\u269b\\ufe0f', tsx: '\\u269b\\ufe0f',
    html: '\\ud83c\\udf10', htm: '\\ud83c\\udf10', css: '\\ud83c\\udfa8', json: '\\ud83d\\udccb',
    md: '\\ud83d\\udcdd', svg: '\\ud83d\\uddbc\\ufe0f', png: '\\ud83d\\uddbc\\ufe0f', jpg: '\\ud83d\\uddbc\\ufe0f',
    gif: '\\ud83d\\uddbc\\ufe0f', sh: '\\ud83d\\udcdc', txt: '\\ud83d\\udcc4', toml: '\\u2699\\ufe0f',
    yaml: '\\u2699\\ufe0f', yml: '\\u2699\\ufe0f', lock: '\\ud83d\\udd12',
  };
  return icons[ext] || '\\ud83d\\udcc4';
}

// ─── File Tree ───
class FileTree {
  constructor(container) {
    this.container = container;
    this.expanded = new Set([PROJECT_DIR]);
    this.selected = null;
    this.gitStatus = {};
    this.onFileSelect = null;
  }

  async refresh() {
    this.container.innerHTML = '';
    await this.renderDir(PROJECT_DIR, 0);
  }

  async renderDir(dirPath, depth) {
    const res = await api.fs.readdir(dirPath);
    if (!res.entries) return;

    /* Sort: dirs first, then alpha */
    const sorted = res.entries.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });

    /* Filter out hidden/noise */
    const filtered = sorted.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');

    for (const entry of filtered) {
      const fullPath = dirPath + '/' + entry.name;
      const isDir = entry.type === 'dir';
      const isOpen = this.expanded.has(fullPath);

      const el = document.createElement('div');
      el.className = 'tree-item' + (this.selected === fullPath ? ' selected' : '');
      el.style.setProperty('--depth', depth);

      /* Arrow for directories */
      const arrow = isDir ? (isOpen ? '\\u25be ' : '\\u25b8 ') : '  ';

      el.innerHTML =
        '<span class="icon">' + arrow + fileIcon(entry.name, isDir) + '</span>' +
        '<span class="name">' + entry.name + '</span>' +
        (this.gitStatus[fullPath] ? '<span class="git-dot ' + this.gitStatus[fullPath] + '"></span>' : '');

      el.addEventListener('click', () => {
        if (isDir) {
          if (this.expanded.has(fullPath)) this.expanded.delete(fullPath);
          else this.expanded.add(fullPath);
          this.refresh();
        } else {
          this.selected = fullPath;
          this.refresh();
          if (this.onFileSelect) this.onFileSelect(fullPath);
        }
      });

      this.container.appendChild(el);

      if (isDir && isOpen) {
        await this.renderDir(fullPath, depth + 1);
      }
    }
  }

  updateGitStatus(statusMap) {
    this.gitStatus = statusMap;
    this.refresh();
  }
}

// ─── Editor Manager ───
class EditorManager {
  constructor(editorPane, tabBar) {
    this.editorPane = editorPane;
    this.tabBar = tabBar;
    this.tabs = []; /* { path, view, modified, content } */
    this.activeTab = null;
    this.onSave = null;
  }

  open(path, content) {
    /* Check if already open */
    const existing = this.tabs.find(t => t.path === path);
    if (existing) {
      this.activate(existing);
      return;
    }

    /* Hide welcome screen */
    const welcome = this.editorPane.querySelector('#welcome-screen');
    if (welcome) welcome.style.display = 'none';

    /* Create EditorView */
    const lang = langForFile(path);
    const extensions = [
      cmBasicSetup,
      cmOneDark,
      cmView.keymap.of([
        { key: 'Mod-s', run: () => { this.save(); return true; } },
      ]),
      cmView.EditorView.updateListener.of(update => {
        if (update.docChanged) {
          const tab = this.tabs.find(t => t.view === update.view);
          if (tab && !tab.modified) {
            tab.modified = true;
            this.renderTabs();
          }
        }
      }),
    ].filter(Boolean);
    if (lang) extensions.push(lang);

    const edContainer = document.createElement('div');
    edContainer.style.cssText = 'height:100%;display:none';
    this.editorPane.appendChild(edContainer);

    const state = cmState.EditorState.create({
      doc: content,
      extensions,
    });
    const view = new cmView.EditorView({ state, parent: edContainer });

    const tab = { path, view, modified: false, content, container: edContainer };
    this.tabs.push(tab);
    this.activate(tab);
  }

  activate(tab) {
    if (this.activeTab) {
      this.activeTab.container.style.display = 'none';
    }
    this.activeTab = tab;
    tab.container.style.display = 'block';
    tab.view.focus();
    this.renderTabs();
  }

  close(tab) {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return;

    tab.view.destroy();
    tab.container.remove();
    this.tabs.splice(idx, 1);

    if (this.activeTab === tab) {
      this.activeTab = null;
      if (this.tabs.length > 0) {
        this.activate(this.tabs[Math.min(idx, this.tabs.length - 1)]);
      } else {
        const welcome = this.editorPane.querySelector('#welcome-screen');
        if (welcome) welcome.style.display = '';
      }
    }
    this.renderTabs();
  }

  async save() {
    if (!this.activeTab) return;
    const tab = this.activeTab;
    const content = tab.view.state.doc.toString();
    const res = await api.fs.write(tab.path, content);
    if (res.ok) {
      tab.modified = false;
      tab.content = content;
      this.renderTabs();
      if (this.onSave) this.onSave(tab.path);
    }
  }

  renderTabs() {
    this.tabBar.innerHTML = '';
    for (const tab of this.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab === this.activeTab ? ' active' : '');
      const name = tab.path.split('/').pop();
      el.innerHTML =
        (tab.modified ? '<span class="modified-dot"></span>' : '') +
        '<span>' + name + '</span>' +
        '<span class="close-btn">&times;</span>';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('close-btn')) {
          this.close(tab);
        } else {
          this.activate(tab);
        }
      });
      this.tabBar.appendChild(el);
    }
  }

  getActiveContent() {
    return this.activeTab ? this.activeTab.view.state.doc.toString() : null;
  }
}

// ─── Slash Menu ───
const MENU_TREE = {
  root: [
    { label: 'File', key: 'f', sub: 'file' },
    { label: 'Edit', key: 'e', sub: 'edit' },
    { label: 'View', key: 'v', sub: 'view' },
    { label: 'Build', key: 'b', sub: 'build' },
    { label: 'Git', key: 'g', sub: 'git' },
    { label: 'Project', key: 'p', sub: 'project' },
    { label: 'Claude', key: 'c', sub: 'claude' },
    { label: 'Help', key: 'h', sub: 'help' },
  ],
  file: [
    { label: 'Save', key: 's', action: 'save', shortcut: 'Ctrl+S' },
    { label: 'Close Tab', key: 'w', action: 'close-tab', shortcut: 'Ctrl+W' },
    { label: 'New File...', key: 'n', action: 'new-file' },
    { label: 'Exit IDE', key: 'x', action: 'exit' },
  ],
  edit: [
    { label: 'Undo', key: 'u', action: 'undo', shortcut: 'Ctrl+Z' },
    { label: 'Redo', key: 'r', action: 'redo', shortcut: 'Ctrl+Shift+Z' },
    { label: 'Find in File', key: 'f', action: 'find', shortcut: 'Ctrl+F' },
  ],
  view: [
    { label: 'Toggle Sidebar', key: 's', action: 'toggle-sidebar', shortcut: 'Ctrl+\\\\' },
    { label: 'Toggle Bottom Panel', key: 'b', action: 'toggle-bottom', shortcut: 'Ctrl+J' },
    { label: 'Toggle Preview', key: 'p', action: 'toggle-preview' },
    { label: 'Focus Terminal', key: 't', action: 'focus-terminal' },
  ],
  build: [
    { label: 'Run Build', key: 'b', action: 'run-build' },
    { label: 'Run Tests', key: 't', action: 'run-tests' },
    { label: 'Run Dev Server', key: 'd', action: 'run-dev' },
    { label: 'Run Script...', key: 'r', action: 'run-script' },
  ],
  git: [
    { label: 'Status', key: 's', action: 'git-status' },
    { label: 'Commit All...', key: 'c', action: 'git-commit' },
    { label: 'Diff', key: 'd', action: 'git-diff' },
    { label: 'Log', key: 'l', action: 'git-log' },
    { label: 'Push', key: 'p', action: 'git-push' },
    { label: 'Pull', key: 'u', action: 'git-pull' },
  ],
  project: [
    { label: 'New Project...', key: 'n', action: 'scaffold' },
    { label: 'Install Dependencies', key: 'i', action: 'npm-install' },
  ],
  claude: [
    { label: 'Ask Claude...', key: 'a', action: 'ask-claude' },
    { label: 'Explain File', key: 'e', action: 'explain-file' },
    { label: 'Fix Errors', key: 'f', action: 'fix-errors' },
  ],
  help: [
    { label: 'Keyboard Shortcuts', key: 'k', action: 'show-shortcuts' },
    { label: 'About', key: 'a', action: 'about' },
  ],
};

class SlashMenu {
  constructor(el) {
    this.el = el;
    this.stack = [];
    this.highlighted = 0;
    this.onAction = null;
  }

  open(section) {
    section = section || 'root';
    this.stack = [section];
    this.highlighted = 0;
    this.render();
    this.el.classList.add('visible');
  }

  close() {
    this.el.classList.remove('visible');
    this.stack = [];
  }

  isOpen() { return this.el.classList.contains('visible'); }

  render() {
    const section = this.stack[this.stack.length - 1];
    const items = MENU_TREE[section] || [];
    const title = this.stack.length > 1 ? section.charAt(0).toUpperCase() + section.slice(1) : 'Commands';

    let html = '<div class="title">' + (this.stack.length > 1 ? '\\u2190 ' : '') + title + '</div>';
    items.forEach((item, i) => {
      html += '<div class="slash-item' + (i === this.highlighted ? ' highlighted' : '') + '" data-idx="' + i + '">' +
        '<span>' + item.label + '</span>' +
        '<span>' +
          (item.shortcut ? '<span class="shortcut" style="margin-right:8px;color:var(--text-dim);font-size:11px">' + item.shortcut + '</span>' : '') +
          '<span class="key">' + item.key + '</span>' +
        '</span>' +
      '</div>';
    });
    this.el.innerHTML = html;

    /* Click handlers */
    this.el.querySelectorAll('.slash-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        this.selectItem(items[idx]);
      });
    });
  }

  handleKey(e) {
    if (!this.isOpen()) return false;

    const section = this.stack[this.stack.length - 1];
    const items = MENU_TREE[section] || [];

    if (e.key === 'Escape') {
      if (this.stack.length > 1) {
        this.stack.pop();
        this.highlighted = 0;
        this.render();
      } else {
        this.close();
      }
      return true;
    }
    if (e.key === 'ArrowDown') {
      this.highlighted = (this.highlighted + 1) % items.length;
      this.render();
      return true;
    }
    if (e.key === 'ArrowUp') {
      this.highlighted = (this.highlighted - 1 + items.length) % items.length;
      this.render();
      return true;
    }
    if (e.key === 'Enter') {
      this.selectItem(items[this.highlighted]);
      return true;
    }

    /* Match by key letter */
    const match = items.find(item => item.key === e.key.toLowerCase());
    if (match) {
      this.selectItem(match);
      return true;
    }

    return false;
  }

  selectItem(item) {
    if (!item) return;
    if (item.sub) {
      this.stack.push(item.sub);
      this.highlighted = 0;
      this.render();
    } else if (item.action) {
      this.close();
      if (this.onAction) this.onAction(item.action);
    }
  }
}

// ─── Preview Pane ───
class PreviewPane {
  constructor() {
    this.pane = document.getElementById('preview-pane');
    this.iframe = document.getElementById('preview-iframe');
    this.urlInput = document.getElementById('preview-url');
    this.refreshTimer = null;

    document.getElementById('preview-close').addEventListener('click', () => this.hide());
    document.getElementById('preview-refresh').addEventListener('click', () => this.reload());
  }

  show() {
    this.pane.classList.remove('hidden');
  }

  hide() {
    this.pane.classList.add('hidden');
  }

  toggle() {
    this.pane.classList.toggle('hidden');
  }

  isVisible() {
    return !this.pane.classList.contains('hidden');
  }

  setUrl(url) {
    this.urlInput.value = url;
    this.iframe.srcdoc = '';
  }

  async reload() {
    const path = this.urlInput.value || '/';
    try {
      const res = await api.fs.read(PROJECT_DIR + path);
      if (res.content !== undefined) {
        this.iframe.srcdoc = res.content;
      }
    } catch {}
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.reload(), 500);
  }
}

// ─── Bottom Panel ───
class BottomPanel {
  constructor() {
    this.panel = document.getElementById('bottom-panel');
    this.tabs = document.querySelectorAll('.bottom-tab');
    this.contents = document.querySelectorAll('.bottom-content');
    this.termOutput = document.getElementById('terminal-output');
    this.termInput = document.getElementById('terminal-input');
    this.outputPanel = document.getElementById('panel-output');
    this.claudeMsgs = document.getElementById('claude-messages');
    this.claudeInput = document.getElementById('claude-input');

    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.panel));
    });

    this.termInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const cmd = this.termInput.value.trim();
        if (!cmd) return;
        this.termInput.value = '';
        this.appendTerm(cmd, 'cmd');
        try {
          const res = await api.shell.exec(cmd);
          if (res.stdout) this.appendTerm(res.stdout, 'stdout');
          if (res.stderr) this.appendTerm(res.stderr, 'stderr');
        } catch (err) {
          this.appendTerm('Error: ' + err.message, 'stderr');
        }
      }
    });

    this.claudeInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const prompt = this.claudeInput.value.trim();
        if (!prompt) return;
        this.claudeInput.value = '';
        this.addClaudeMsg('user', prompt);
        this.addClaudeMsg('assistant', 'Thinking...');
        try {
          const res = await api.claude.prompt(prompt);
          /* Remove "Thinking..." */
          this.claudeMsgs.lastElementChild?.remove();
          this.addClaudeMsg('assistant', res.stdout || res.stderr || 'No response');
        } catch (err) {
          this.claudeMsgs.lastElementChild?.remove();
          this.addClaudeMsg('assistant', 'Error: ' + err.message);
        }
      }
    });
  }

  switchTab(name) {
    this.tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === name));
    this.contents.forEach(c => c.classList.toggle('active', c.dataset.panel === name));
  }

  toggle() {
    this.panel.classList.toggle('hidden');
  }

  isVisible() { return !this.panel.classList.contains('hidden'); }

  appendTerm(text, cls) {
    const line = document.createElement('div');
    line.className = 'term-line ' + cls;
    line.textContent = text;
    this.termOutput.appendChild(line);
    this.termOutput.scrollTop = this.termOutput.scrollHeight;
  }

  appendOutput(text) {
    this.outputPanel.textContent += text + '\\n';
    this.outputPanel.scrollTop = this.outputPanel.scrollHeight;
  }

  addClaudeMsg(role, text) {
    const msg = document.createElement('div');
    msg.className = 'claude-msg ' + role;
    msg.innerHTML = '<div class="role">' + role + '</div><div class="body"></div>';
    msg.querySelector('.body').textContent = text;
    this.claudeMsgs.appendChild(msg);
    this.claudeMsgs.scrollTop = this.claudeMsgs.scrollHeight;
  }

  focusTerminal() {
    this.switchTab('terminal');
    if (this.panel.classList.contains('hidden')) this.panel.classList.remove('hidden');
    this.termInput.focus();
  }
}

// ─── Suggestions Bar ───
class SuggestionsBar {
  constructor(el) {
    this.el = el;
    this.onAction = null;
    this.pollTimer = null;
  }

  start() {
    this.update();
    this.pollTimer = setInterval(() => this.update(), 5000);
  }

  stop() {
    clearInterval(this.pollTimer);
  }

  async update() {
    try {
      const res = await api.git.status();
      const lines = (res.stdout || '').trim().split('\\n').filter(Boolean);
      this.el.innerHTML = '';

      if (lines.length > 0) {
        const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
        const untracked = lines.filter(l => l.startsWith('??')).length;
        const staged = lines.filter(l => /^[MADRC]/.test(l) && !l.startsWith('??')).length;

        if (modified > 0) this.addPill(modified + ' modified', 'warn', 'git-commit');
        if (untracked > 0) this.addPill(untracked + ' untracked', '', 'git-status');
        if (staged > 0) this.addPill(staged + ' staged — Commit?', 'warn', 'git-commit');
      }
    } catch {}
  }

  addPill(text, cls, action) {
    const pill = document.createElement('span');
    pill.className = 'suggestion-pill ' + cls;
    pill.textContent = text;
    pill.addEventListener('click', () => {
      if (this.onAction) this.onAction(action);
    });
    this.el.appendChild(pill);
  }
}

// ─── Scaffold Modal ───
const TEMPLATES = [
  { id: 'static', emoji: '\\ud83c\\udf10', label: 'Static Website' },
  { id: 'express', emoji: '\\ud83d\\ude80', label: 'Express App' },
  { id: 'mcp', emoji: '\\ud83d\\udd0c', label: 'MCP Server' },
  { id: 'cli', emoji: '\\ud83d\\udcbb', label: 'CLI Tool' },
  { id: 'command', emoji: '\\u2699\\ufe0f', label: 'Shiro Command' },
];

class ScaffoldModal {
  constructor() {
    this.modal = document.getElementById('scaffold-modal');
    this.grid = document.getElementById('template-grid');
    this.nameInput = document.getElementById('scaffold-name');
    this.selected = null;
    this.onComplete = null;

    /* Render template cards */
    for (const tmpl of TEMPLATES) {
      const card = document.createElement('div');
      card.className = 'template-card';
      card.dataset.id = tmpl.id;
      card.innerHTML = '<div class="emoji">' + tmpl.emoji + '</div><div class="label">' + tmpl.label + '</div>';
      card.addEventListener('click', () => {
        this.grid.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selected = tmpl.id;
      });
      this.grid.appendChild(card);
    }

    document.getElementById('scaffold-cancel').addEventListener('click', () => this.close());
    document.getElementById('scaffold-create').addEventListener('click', () => this.create());
  }

  open() {
    this.selected = null;
    this.nameInput.value = '';
    this.grid.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
    this.modal.classList.add('visible');
    this.nameInput.focus();
  }

  close() {
    this.modal.classList.remove('visible');
  }

  async create() {
    if (!this.selected) return;
    const name = this.nameInput.value.trim() || 'my-project';
    this.close();
    try {
      await api.project.scaffold(this.selected, name);
      if (this.onComplete) this.onComplete();
    } catch (err) {
      console.error('Scaffold failed:', err);
    }
  }
}

// ─── Dropdown Menus (for menu bar) ───
class MenuBar {
  constructor() {
    this.activeMenu = null;
    this.onAction = null;

    document.querySelectorAll('#menu-bar .menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = item.dataset.menu;
        if (this.activeMenu === menu) {
          this.closeAll();
        } else {
          this.openDropdown(item, menu);
        }
      });
      item.addEventListener('mouseenter', () => {
        if (this.activeMenu) {
          this.openDropdown(item, item.dataset.menu);
        }
      });
    });

    document.addEventListener('click', () => this.closeAll());
  }

  openDropdown(menuItem, menuName) {
    this.closeAll();
    this.activeMenu = menuName;
    menuItem.classList.add('active');

    const items = MENU_TREE[menuName];
    if (!items) return;

    const dd = document.createElement('div');
    dd.className = 'dropdown-menu visible';

    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'dropdown-item';
      el.innerHTML = '<span>' + item.label + '</span>' +
        (item.shortcut ? '<span class="shortcut">' + item.shortcut + '</span>' : '');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeAll();
        if (item.sub) {
          /* Open slash menu for sub-menus */
          if (this.onAction) this.onAction('slash-' + item.sub);
        } else if (item.action) {
          if (this.onAction) this.onAction(item.action);
        }
      });
      dd.appendChild(el);
    });

    menuItem.appendChild(dd);
    menuItem.style.position = 'relative';
  }

  closeAll() {
    this.activeMenu = null;
    document.querySelectorAll('#menu-bar .menu-item').forEach(i => {
      i.classList.remove('active');
      const dd = i.querySelector('.dropdown-menu');
      if (dd) dd.remove();
    });
  }
}

// ─── Main Init ───
async function init() {
  const loaded = await loadCodeMirror();
  document.getElementById('loading-overlay').remove();
  if (!loaded) {
    document.body.innerHTML = '<div style="color:#ff6b6b;padding:2em;font-family:monospace">Failed to load CodeMirror from esm.sh. Check your network connection.</div>';
    return;
  }

  const fileTree = new FileTree(document.getElementById('tree-content'));
  const editor = new EditorManager(document.getElementById('editor-pane'), document.getElementById('tab-bar'));
  const slashMenu = new SlashMenu(document.getElementById('slash-menu'));
  const preview = new PreviewPane();
  const bottom = new BottomPanel();
  const suggestions = new SuggestionsBar(document.getElementById('suggestions-bar'));
  const scaffold = new ScaffoldModal();
  const menuBar = new MenuBar();

  /* Wire file tree -> editor */
  fileTree.onFileSelect = async (path) => {
    const res = await api.fs.read(path);
    if (res.content !== undefined) {
      editor.open(path, res.content);
    }
  };

  /* Wire editor save -> preview refresh + git status */
  editor.onSave = (path) => {
    if (preview.isVisible()) preview.scheduleRefresh();
    suggestions.update();
  };

  /* Wire scaffold complete -> refresh tree */
  scaffold.onComplete = () => {
    fileTree.refresh();
    bottom.appendTerm('Project scaffolded successfully.', 'stdout');
  };

  /* Action dispatcher */
  async function handleAction(action) {
    switch (action) {
      case 'save': editor.save(); break;
      case 'close-tab': if (editor.activeTab) editor.close(editor.activeTab); break;
      case 'new-file': {
        const name = prompt('File name:');
        if (name) {
          await api.fs.write(PROJECT_DIR + '/' + name, '');
          fileTree.refresh();
          const res = await api.fs.read(PROJECT_DIR + '/' + name);
          editor.open(PROJECT_DIR + '/' + name, res.content || '');
        }
        break;
      }
      case 'exit': {
        /* Post message to parent to unbecome */
        try { window.parent.__shiro?.unbecome?.(); } catch {}
        try { await api.shell.exec('unbecome'); } catch {}
        break;
      }
      case 'undo': cmCommands.undo(editor.activeTab?.view); break;
      case 'redo': cmCommands.redo(editor.activeTab?.view); break;
      case 'find':
        if (editor.activeTab?.view) cmCommands.openSearchPanel(editor.activeTab.view);
        break;
      case 'toggle-sidebar': document.getElementById('ide-root').classList.toggle('sidebar-hidden'); break;
      case 'toggle-bottom': bottom.toggle(); break;
      case 'toggle-preview': preview.toggle(); if (preview.isVisible()) preview.reload(); break;
      case 'focus-terminal': bottom.focusTerminal(); break;
      case 'run-build': {
        bottom.switchTab('output');
        bottom.appendOutput('> npm run build');
        const r = await api.shell.exec('cd ' + PROJECT_DIR + ' && npm run build');
        bottom.appendOutput(r.stdout || '');
        if (r.stderr) bottom.appendOutput(r.stderr);
        break;
      }
      case 'run-tests': {
        bottom.switchTab('output');
        bottom.appendOutput('> npm test');
        const r = await api.shell.exec('cd ' + PROJECT_DIR + ' && npm test');
        bottom.appendOutput(r.stdout || '');
        if (r.stderr) bottom.appendOutput(r.stderr);
        break;
      }
      case 'run-dev': {
        bottom.focusTerminal();
        bottom.appendTerm('$ npm run dev', 'cmd');
        const r = await api.shell.exec('cd ' + PROJECT_DIR + ' && npm run dev');
        if (r.stdout) bottom.appendTerm(r.stdout, 'stdout');
        if (r.stderr) bottom.appendTerm(r.stderr, 'stderr');
        break;
      }
      case 'run-script': {
        const script = prompt('Script name (e.g. start, build, test):');
        if (script) {
          bottom.switchTab('output');
          bottom.appendOutput('> npm run ' + script);
          const r = await api.shell.exec('cd ' + PROJECT_DIR + ' && npm run ' + script);
          bottom.appendOutput(r.stdout || '');
          if (r.stderr) bottom.appendOutput(r.stderr);
        }
        break;
      }
      case 'git-status': {
        bottom.focusTerminal();
        const r = await api.git.status();
        bottom.appendTerm('$ git status', 'cmd');
        bottom.appendTerm(r.stdout || 'clean', 'stdout');
        break;
      }
      case 'git-commit': {
        const msg = prompt('Commit message:');
        if (msg) {
          bottom.focusTerminal();
          bottom.appendTerm('$ git commit -m "' + msg + '"', 'cmd');
          const r = await api.git.commit(msg);
          bottom.appendTerm(r.stdout || '', 'stdout');
          if (r.stderr) bottom.appendTerm(r.stderr, 'stderr');
          suggestions.update();
        }
        break;
      }
      case 'git-diff': {
        bottom.focusTerminal();
        bottom.appendTerm('$ git diff', 'cmd');
        const r = await api.git.diff();
        bottom.appendTerm(r.stdout || 'No changes', 'stdout');
        break;
      }
      case 'git-log': {
        bottom.focusTerminal();
        bottom.appendTerm('$ git log --oneline -20', 'cmd');
        const r = await api.git.log(20);
        bottom.appendTerm(r.stdout || '', 'stdout');
        break;
      }
      case 'git-push': {
        bottom.focusTerminal();
        bottom.appendTerm('$ git push', 'cmd');
        const r = await api.git.push();
        bottom.appendTerm(r.stdout || '', 'stdout');
        if (r.stderr) bottom.appendTerm(r.stderr, 'stderr');
        break;
      }
      case 'git-pull': {
        bottom.focusTerminal();
        bottom.appendTerm('$ git pull', 'cmd');
        const r = await api.git.pull();
        bottom.appendTerm(r.stdout || '', 'stdout');
        if (r.stderr) bottom.appendTerm(r.stderr, 'stderr');
        break;
      }
      case 'scaffold': scaffold.open(); break;
      case 'npm-install': {
        bottom.focusTerminal();
        bottom.appendTerm('$ npm install', 'cmd');
        const r = await api.shell.exec('cd ' + PROJECT_DIR + ' && npm install');
        if (r.stdout) bottom.appendTerm(r.stdout, 'stdout');
        if (r.stderr) bottom.appendTerm(r.stderr, 'stderr');
        break;
      }
      case 'ask-claude': {
        bottom.switchTab('claude');
        if (bottom.panel.classList.contains('hidden')) bottom.panel.classList.remove('hidden');
        document.getElementById('claude-input').focus();
        break;
      }
      case 'explain-file': {
        if (!editor.activeTab) break;
        const content = editor.getActiveContent();
        const path = editor.activeTab.path;
        bottom.switchTab('claude');
        if (bottom.panel.classList.contains('hidden')) bottom.panel.classList.remove('hidden');
        bottom.addClaudeMsg('user', 'Explain this file: ' + path);
        bottom.addClaudeMsg('assistant', 'Thinking...');
        const r = await api.claude.prompt('Explain this file concisely. Path: ' + path + '\\n\\n' + content);
        bottom.claudeMsgs.lastElementChild?.remove();
        bottom.addClaudeMsg('assistant', r.stdout || r.stderr || 'No response');
        break;
      }
      case 'fix-errors': {
        if (!editor.activeTab) break;
        const content2 = editor.getActiveContent();
        const path2 = editor.activeTab.path;
        bottom.switchTab('claude');
        if (bottom.panel.classList.contains('hidden')) bottom.panel.classList.remove('hidden');
        bottom.addClaudeMsg('user', 'Fix errors in: ' + path2);
        bottom.addClaudeMsg('assistant', 'Thinking...');
        const r = await api.claude.prompt('Find and fix any errors in this code. Show the corrected version. Path: ' + path2 + '\\n\\n' + content2);
        bottom.claudeMsgs.lastElementChild?.remove();
        bottom.addClaudeMsg('assistant', r.stdout || r.stderr || 'No response');
        break;
      }
      case 'show-shortcuts': {
        bottom.focusTerminal();
        bottom.appendTerm([
          'Keyboard Shortcuts:',
          '  /              Open command menu',
          '  Ctrl+S         Save file',
          '  Ctrl+\\\\        Toggle sidebar',
          '  Ctrl+J         Toggle bottom panel',
          '  Ctrl+W         Close tab',
          '  Escape         Close menu / modal',
        ].join('\\n'), 'stdout');
        break;
      }
      case 'about': {
        bottom.focusTerminal();
        bottom.appendTerm('Shiro IDE — Browser-native development environment\\nPowered by CodeMirror 6 + Shiro OS', 'stdout');
        break;
      }
      default:
        if (action.startsWith('slash-')) {
          slashMenu.open(action.slice(6));
        }
        break;
    }
  }

  slashMenu.onAction = handleAction;
  menuBar.onAction = handleAction;
  suggestions.onAction = handleAction;

  /* Global keyboard shortcuts */
  document.addEventListener('keydown', (e) => {
    /* Slash menu handles its own keys when open */
    if (slashMenu.isOpen()) {
      if (slashMenu.handleKey(e)) {
        e.preventDefault();
        return;
      }
    }

    /* Escape closes modals */
    if (e.key === 'Escape') {
      if (slashMenu.isOpen()) { slashMenu.close(); e.preventDefault(); return; }
      if (scaffold.modal.classList.contains('visible')) { scaffold.close(); e.preventDefault(); return; }
      menuBar.closeAll();
      return;
    }

    /* Slash key opens menu (when not in an editor or input) */
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.closest('.cm-editor'))) return;
      e.preventDefault();
      slashMenu.open();
      return;
    }

    /* Ctrl+S save */
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      editor.save();
      return;
    }

    /* Ctrl+\\ toggle sidebar */
    if ((e.ctrlKey || e.metaKey) && e.key === '\\\\') {
      e.preventDefault();
      handleAction('toggle-sidebar');
      return;
    }

    /* Ctrl+J toggle bottom panel */
    if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
      e.preventDefault();
      handleAction('toggle-bottom');
      return;
    }

    /* Ctrl+W close tab */
    if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
      e.preventDefault();
      handleAction('close-tab');
      return;
    }
  });

  /* Initial load */
  await fileTree.refresh();
  suggestions.start();

  /* Preview: auto-load index.html if it exists */
  try {
    const idx = await api.fs.stat(PROJECT_DIR + '/index.html');
    if (idx && idx.type === 'file') {
      preview.setUrl('/index.html');
    }
  } catch {}
}

init().catch(console.error);
</script>
</body>
</html>`;
}
