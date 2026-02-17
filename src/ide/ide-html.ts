// ide-html.ts — Generates the complete IDE HTML interface
// Single inline HTML with CSS + JS, using LiteEditor (zero-dependency textarea-based editor)

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
.tree-item .icon { min-width: 32px; text-align: left; font-size: 12px; flex-shrink: 0; }
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
/* LiteEditor */
.lite-editor-wrap {
  position: relative;
  height: 100%;
  overflow: hidden;
  isolation: isolate;
  background: var(--bg);
}
.lite-gutter {
  position: absolute;
  left: 0;
  top: 0;
  width: 48px;
  height: 100%;
  overflow: hidden;
  background: var(--surface);
  border-right: 1px solid var(--border);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-dim);
  text-align: right;
  padding: 0 6px 0 0;
  user-select: none;
  z-index: 0;
}
.lite-gutter .ln { display: block; }
.lite-highlight {
  position: absolute;
  top: 0;
  left: 48px;
  right: 0;
  bottom: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
  margin: 0;
  border: 0;
  background: transparent;
}
.lite-highlight code {
  display: block;
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.6;
  padding: 0 8px;
  white-space: pre;
  tab-size: 2;
  color: var(--text);
}
.lite-textarea {
  position: absolute;
  top: 0;
  left: 48px;
  right: 0;
  bottom: 0;
  overflow: auto;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.6;
  padding: 0 8px;
  white-space: pre;
  tab-size: 2;
  color: transparent;
  caret-color: #fff;
  z-index: 1;
  -webkit-text-fill-color: transparent;
}
.lite-textarea::selection { background: rgba(108,99,255,0.35); }
.lite-find-bar {
  position: absolute;
  top: 4px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
}
.lite-find-bar input {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-family: var(--font);
  font-size: 12px;
  padding: 2px 8px;
  outline: none;
  width: 180px;
}
.lite-find-bar input:focus { border-color: var(--accent); }
.lite-find-bar button {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
}
.lite-find-bar button:hover { color: var(--text); }

/* Syntax token colors (One Dark) */
.tok-keyword { color: #c678dd; }
.tok-string { color: #98c379; }
.tok-comment { color: #5c6370; font-style: italic; }
.tok-number { color: #d19a66; }
.tok-func { color: #61afef; }
.tok-tag { color: #e06c75; }
.tok-attr { color: #d19a66; }
.tok-type { color: #e5c07b; }
.tok-operator { color: #56b6c2; }
.tok-property { color: #e06c75; }
.tok-heading { color: #c678dd; font-weight: bold; }
.tok-bold { font-weight: bold; }
.tok-italic { font-style: italic; }
.tok-code { color: #56b6c2; }
.tok-link { color: #61afef; text-decoration: underline; }
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
#claude-input-row { gap: 6px; }
#claude-new-btn {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
#claude-new-btn:hover { color: var(--text); background: var(--accent-dim); }
.claude-code-block { position: relative; margin: 8px 0; border-radius: 6px; overflow: hidden; }
.claude-code-block pre { margin: 0; padding: 12px; background: var(--bg); overflow-x: auto; font-size: 12px; font-family: var(--font); line-height: 1.5; }
.claude-code-actions { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; }
.claude-code-actions button { background: var(--surface2); border: 1px solid var(--border); color: var(--text-dim); padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; }
.claude-code-actions button:hover { color: var(--text); background: var(--accent-dim); }
.claude-msg.assistant .body code { background: var(--surface2); padding: 1px 4px; border-radius: 3px; font-family: var(--font); font-size: 12px; }
.claude-msg.assistant .body h2, .claude-msg.assistant .body h3, .claude-msg.assistant .body h4 { margin: 8px 0 4px; font-weight: 500; }
.claude-msg.assistant .body ul, .claude-msg.assistant .body ol { margin: 4px 0; padding-left: 20px; }
.claude-msg.assistant .body li { margin: 2px 0; }

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
  <div style="color:var(--text-dim);font-size:12px">Loading IDE...</div>
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
        <button id="claude-new-btn" title="New conversation">New</button>
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
    chat: (prompt, context, isFirstMessage) =>
      api.call('claude/chat', { prompt, context, isFirstMessage }),
  },
  project: {
    scaffold: (template, name) => api.call('project/scaffold', { template, name }),
  },
};

// ─── Language detection ───
function langForFile(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'js';
    case 'ts': case 'mts': case 'cts': case 'tsx': return 'ts';
    case 'html': case 'htm': case 'svg': return 'html';
    case 'css': return 'css';
    case 'json': return 'json';
    case 'md': case 'mdx': case 'markdown': return 'md';
    default: return 'text';
  }
}

// ─── Tokenizer ───
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function span(cls, text) { return '<span class="' + cls + '">' + esc(text) + '</span>'; }

const JS_KW = new Set('const let var function return if else for while do switch case break continue new delete typeof instanceof void throw try catch finally class extends super this import export from default async await yield of in true false null undefined static get set'.split(' '));
const TS_KW = new Set([...JS_KW, 'type', 'interface', 'enum', 'namespace', 'declare', 'abstract', 'implements', 'readonly', 'as', 'is', 'keyof', 'infer', 'never', 'unknown', 'any']);
const TYPE_NAMES = new Set('String Number Boolean Object Array Function Promise Map Set Date RegExp Error Symbol BigInt'.split(' '));
const OP_CHARS = new Set('=+-*/%<>!&|^~?:');

function tokenizeJS(text, typescript) {
  const KW = typescript ? TS_KW : JS_KW;
  let out = '', i = 0, len = text.length;
  function isIdChar(c) { return /[a-zA-Z0-9_$]/.test(c); }
  function ahead(s) { return text.substr(i, s.length) === s; }
  while (i < len) {
    /* line comment */
    if (ahead('//')) {
      let j = i; while (j < len && text[j] !== '\\n') j++;
      out += span('tok-comment', text.slice(i, j)); i = j; continue;
    }
    /* block comment */
    if (ahead('/*')) {
      let j = text.indexOf('*/', i + 2);
      if (j < 0) j = len - 2;
      out += span('tok-comment', text.slice(i, j + 2)); i = j + 2; continue;
    }
    /* template literal */
    if (text[i] === '\`') {
      let j = i + 1, depth = 0, s = '\`';
      while (j < len) {
        if (text[j] === '\\\\') { s += text.substr(j, 2); j += 2; continue; }
        if (depth === 0 && text[j] === '\`') { s += '\`'; j++; break; }
        if (text[j] === '$' && text[j+1] === '{') { depth++; s += text.substr(j, 2); j += 2; continue; }
        if (text[j] === '{') { depth++; }
        if (text[j] === '}') { if (depth > 0) depth--; }
        s += text[j]; j++;
      }
      out += span('tok-string', s); i = j; continue;
    }
    /* string */
    if (text[i] === "'" || text[i] === '"') {
      const q = text[i]; let j = i + 1;
      while (j < len && text[j] !== q && text[j] !== '\\n') {
        if (text[j] === '\\\\') j++;
        j++;
      }
      if (j < len && text[j] === q) j++;
      out += span('tok-string', text.slice(i, j)); i = j; continue;
    }
    /* number */
    if (/[0-9]/.test(text[i]) && (i === 0 || !isIdChar(text[i-1]))) {
      let j = i;
      if (text[j] === '0' && (text[j+1] === 'x' || text[j+1] === 'X')) { j += 2; while (j < len && /[0-9a-fA-F_]/.test(text[j])) j++; }
      else if (text[j] === '0' && (text[j+1] === 'b' || text[j+1] === 'B')) { j += 2; while (j < len && /[01_]/.test(text[j])) j++; }
      else { while (j < len && /[0-9._eE]/.test(text[j])) j++; }
      if (j < len && text[j] === 'n') j++; /* BigInt */
      out += span('tok-number', text.slice(i, j)); i = j; continue;
    }
    /* identifier / keyword */
    if (/[a-zA-Z_$]/.test(text[i])) {
      let j = i; while (j < len && isIdChar(text[j])) j++;
      const word = text.slice(i, j);
      /* look ahead for ( to detect function calls */
      let k = j; while (k < len && text[k] === ' ') k++;
      if (KW.has(word)) out += span('tok-keyword', word);
      else if (TYPE_NAMES.has(word)) out += span('tok-type', word);
      else if (text[k] === '(') out += span('tok-func', word);
      else out += esc(word);
      i = j; continue;
    }
    /* operator */
    if (OP_CHARS.has(text[i])) {
      let j = i; while (j < len && OP_CHARS.has(text[j])) j++;
      out += span('tok-operator', text.slice(i, j)); i = j; continue;
    }
    /* default */
    out += esc(text[i]); i++;
  }
  return out;
}

function tokenizeCSS(text) {
  let out = '', i = 0, len = text.length;
  while (i < len) {
    if (text[i] === '/' && text[i+1] === '*') {
      let j = text.indexOf('*/', i + 2);
      if (j < 0) j = len - 2;
      out += span('tok-comment', text.slice(i, j + 2)); i = j + 2; continue;
    }
    if (text[i] === '@') {
      let j = i + 1; while (j < len && /[a-zA-Z-]/.test(text[j])) j++;
      out += span('tok-keyword', text.slice(i, j)); i = j; continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i]; let j = i + 1;
      while (j < len && text[j] !== q) { if (text[j] === '\\\\') j++; j++; }
      if (j < len) j++;
      out += span('tok-string', text.slice(i, j)); i = j; continue;
    }
    if (text[i] === '#' && /[0-9a-fA-F]/.test(text[i+1] || '')) {
      let j = i + 1; while (j < len && /[0-9a-fA-F]/.test(text[j])) j++;
      out += span('tok-number', text.slice(i, j)); i = j; continue;
    }
    if (/[0-9]/.test(text[i])) {
      let j = i; while (j < len && /[0-9.%a-zA-Z]/.test(text[j])) j++;
      out += span('tok-number', text.slice(i, j)); i = j; continue;
    }
    if (/[a-zA-Z-]/.test(text[i])) {
      let j = i; while (j < len && /[a-zA-Z0-9-_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      let k = j; while (k < len && text[k] === ' ') k++;
      if (text[k] === ':' && text[k+1] !== ':') out += span('tok-property', word);
      else out += esc(word);
      i = j; continue;
    }
    out += esc(text[i]); i++;
  }
  return out;
}

function tokenizeHTML(text) {
  let out = '', i = 0, len = text.length;
  while (i < len) {
    if (text.substr(i, 4) === '<!--') {
      let j = text.indexOf('-->', i + 4);
      if (j < 0) j = len - 3;
      out += span('tok-comment', text.slice(i, j + 3)); i = j + 3; continue;
    }
    if (text[i] === '<') {
      /* opening/closing tag */
      let j = i + 1;
      if (text[j] === '/') j++;
      let tagStart = j;
      while (j < len && /[a-zA-Z0-9-]/.test(text[j])) j++;
      let tag = text.slice(tagStart, j);
      out += esc(text.slice(i, tagStart));
      if (tag) out += span('tok-tag', tag);
      /* attributes */
      while (j < len && text[j] !== '>') {
        if (text[j] === '"' || text[j] === "'") {
          const q = text[j]; let k = j + 1;
          while (k < len && text[k] !== q) k++;
          if (k < len) k++;
          out += span('tok-string', text.slice(j, k)); j = k; continue;
        }
        if (/[a-zA-Z-]/.test(text[j])) {
          let k = j; while (k < len && /[a-zA-Z0-9-]/.test(text[k])) k++;
          out += span('tok-attr', text.slice(j, k)); j = k; continue;
        }
        out += esc(text[j]); j++;
      }
      if (j < len) { out += esc('>'); j++; }
      i = j; continue;
    }
    out += esc(text[i]); i++;
  }
  return out;
}

function tokenizeJSON(text) {
  let out = '', i = 0, len = text.length;
  while (i < len) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < len && text[j] !== '"') { if (text[j] === '\\\\') j++; j++; }
      if (j < len) j++;
      const s = text.slice(i, j);
      let k = j; while (k < len && text[k] === ' ') k++;
      if (text[k] === ':') out += span('tok-property', s);
      else out += span('tok-string', s);
      i = j; continue;
    }
    if (/[0-9-]/.test(text[i])) {
      let j = i; if (text[j] === '-') j++;
      while (j < len && /[0-9.eE+-]/.test(text[j])) j++;
      out += span('tok-number', text.slice(i, j)); i = j; continue;
    }
    if (text.substr(i, 4) === 'true' || text.substr(i, 5) === 'false' || text.substr(i, 4) === 'null') {
      const w = text[i] === 'f' ? 5 : 4;
      out += span('tok-keyword', text.substr(i, w)); i += w; continue;
    }
    out += esc(text[i]); i++;
  }
  return out;
}

function tokenizeMD(text) {
  const lines = text.split('\\n');
  let inFence = false, out = [];
  for (const line of lines) {
    if (line.startsWith('\`\`\`')) { inFence = !inFence; out.push(span('tok-code', line)); continue; }
    if (inFence) { out.push(span('tok-code', line)); continue; }
    if (/^#{1,6} /.test(line)) { out.push(span('tok-heading', line)); continue; }
    /* inline formatting */
    let s = '', j = 0;
    while (j < line.length) {
      if (line[j] === '\`') {
        let k = j + 1; while (k < line.length && line[k] !== '\`') k++;
        if (k < line.length) { s += span('tok-code', line.slice(j, k + 1)); j = k + 1; continue; }
      }
      if (line[j] === '*' && line[j+1] === '*') {
        let k = line.indexOf('**', j + 2);
        if (k > j) { s += span('tok-bold', line.slice(j, k + 2)); j = k + 2; continue; }
      }
      if (line[j] === '*' && line[j+1] !== '*') {
        let k = line.indexOf('*', j + 1);
        if (k > j) { s += span('tok-italic', line.slice(j, k + 1)); j = k + 1; continue; }
      }
      if (line[j] === '[') {
        let cb = line.indexOf('](', j);
        if (cb > j) {
          let ce = line.indexOf(')', cb + 2);
          if (ce > cb) {
            s += esc(line.slice(j, cb + 2)) + span('tok-link', line.slice(cb + 2, ce)) + esc(')');
            j = ce + 1; continue;
          }
        }
      }
      s += esc(line[j]); j++;
    }
    out.push(s);
  }
  return out.join('\\n');
}

function tokenize(text, lang) {
  if (lang === 'js') return tokenizeJS(text, false);
  if (lang === 'ts') return tokenizeJS(text, true);
  if (lang === 'css') return tokenizeCSS(text);
  if (lang === 'html') return tokenizeHTML(text);
  if (lang === 'json') return tokenizeJSON(text);
  if (lang === 'md') return tokenizeMD(text);
  return esc(text);
}

// ─── LiteEditor ───
const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}' };
const OPEN_BRACKETS = new Set(['(', '[', '{']);
const INDENT_AFTER = new Set(['{', '(', ':', '[']);

class LiteEditor {
  constructor(container, opts) {
    opts = opts || {};
    this.language = opts.language || 'text';
    this.onChange = opts.onChange || null;
    this.onSave = opts.onSave || null;
    this._rafId = null;

    this.wrap = document.createElement('div');
    this.wrap.className = 'lite-editor-wrap';

    this.gutter = document.createElement('div');
    this.gutter.className = 'lite-gutter';

    this.pre = document.createElement('pre');
    this.pre.className = 'lite-highlight';
    this.code = document.createElement('code');
    this.pre.appendChild(this.code);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'lite-textarea';
    this.textarea.spellcheck = false;
    this.textarea.autocomplete = 'off';
    this.textarea.autocapitalize = 'off';

    this.wrap.appendChild(this.gutter);
    this.wrap.appendChild(this.pre);
    this.wrap.appendChild(this.textarea);
    container.appendChild(this.wrap);

    this.findBar = null;

    /* Events */
    this.textarea.addEventListener('input', () => this._onInput());
    this.textarea.addEventListener('scroll', () => this._syncScroll());
    this.textarea.addEventListener('keydown', (e) => this._onKeydown(e));

    /* ResizeObserver to sync scroll on resize */
    this._ro = new ResizeObserver(() => this._syncScroll());
    this._ro.observe(this.wrap);
  }

  getValue() { return this.textarea.value; }

  setValue(text) {
    this.textarea.value = text;
    this._scheduleHighlight();
  }

  focus() { this.textarea.focus(); }

  setLanguage(lang) {
    this.language = lang;
    this._scheduleHighlight();
  }

  undo() { this.textarea.focus(); document.execCommand('undo'); }
  redo() { this.textarea.focus(); document.execCommand('redo'); }

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._ro.disconnect();
    this.closeFind();
    this.wrap.remove();
  }

  openFind() {
    if (this.findBar) { this.findBar.querySelector('input').focus(); return; }
    this.findBar = document.createElement('div');
    this.findBar.className = 'lite-find-bar';
    this.findBar.innerHTML =
      '<input type="text" placeholder="Find..." spellcheck="false" autocomplete="off">' +
      '<button title="Previous">\\u2191</button>' +
      '<button title="Next">\\u2193</button>' +
      '<button title="Close">\\u2715</button>';
    this.wrap.appendChild(this.findBar);
    const inp = this.findBar.querySelector('input');
    const btns = this.findBar.querySelectorAll('button');
    btns[0].addEventListener('click', () => this._findNext(inp.value, -1));
    btns[1].addEventListener('click', () => this._findNext(inp.value, 1));
    btns[2].addEventListener('click', () => this.closeFind());
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this._findNext(inp.value, e.shiftKey ? -1 : 1); e.preventDefault(); }
      if (e.key === 'Escape') { this.closeFind(); e.preventDefault(); }
    });
    inp.focus();
  }

  closeFind() {
    if (this.findBar) { this.findBar.remove(); this.findBar = null; }
  }

  _onInput() {
    if (this.onChange) this.onChange(this.textarea.value);
    this._scheduleHighlight();
  }

  _syncScroll() {
    this.pre.scrollTop = this.textarea.scrollTop;
    this.pre.scrollLeft = this.textarea.scrollLeft;
    this.gutter.style.transform = 'translateY(' + (-this.textarea.scrollTop) + 'px)';
  }

  _scheduleHighlight() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => { this._rafId = null; this._highlight(); });
  }

  _highlight() {
    const text = this.textarea.value;
    this.code.innerHTML = tokenize(text, this.language);
    const lineCount = text.split('\\n').length;
    this._renderGutter(lineCount);
    /* Match code height to textarea so pre can scroll as far (prevents bottom desync) */
    this.code.style.minHeight = this.textarea.scrollHeight + 'px';
  }

  _renderGutter(lineCount) {
    let html = '';
    for (let i = 1; i <= lineCount; i++) html += '<span class="ln">' + i + '</span>';
    this.gutter.innerHTML = html;
  }

  _onKeydown(e) {
    /* Ctrl+S save */
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (this.onSave) this.onSave();
      return;
    }
    /* Ctrl+F find */
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      this.openFind();
      return;
    }
    /* Tab indent */
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = this.textarea;
      const start = ta.selectionStart, end = ta.selectionEnd;
      if (e.shiftKey) {
        /* dedent: remove up to 2 spaces before cursor */
        const before = ta.value.substring(0, start);
        const lineStart = before.lastIndexOf('\\n') + 1;
        const linePrefix = before.substring(lineStart, start);
        const spaces = linePrefix.match(/^ {1,2}/);
        if (spaces) {
          ta.selectionStart = lineStart;
          ta.selectionEnd = lineStart + spaces[0].length;
          document.execCommand('delete');
        }
      } else {
        document.execCommand('insertText', false, '  ');
      }
      this._onInput();
      return;
    }
    /* Enter auto-indent */
    if (e.key === 'Enter') {
      const ta = this.textarea;
      const start = ta.selectionStart;
      const before = ta.value.substring(0, start);
      const lineStart = before.lastIndexOf('\\n') + 1;
      const currentLine = before.substring(lineStart);
      const indent = currentLine.match(/^[ \\t]*/)[0];
      const lastChar = before.trimEnd().slice(-1);
      const extra = INDENT_AFTER.has(lastChar) ? '  ' : '';
      e.preventDefault();
      document.execCommand('insertText', false, '\\n' + indent + extra);
      this._onInput();
      return;
    }
    /* Auto-close brackets */
    if (OPEN_BRACKETS.has(e.key)) {
      const ta = this.textarea;
      const start = ta.selectionStart, end = ta.selectionEnd;
      if (start === end) {
        e.preventDefault();
        document.execCommand('insertText', false, e.key + BRACKET_PAIRS[e.key]);
        ta.selectionStart = ta.selectionEnd = start + 1;
      }
    }
  }

  _findNext(query, dir) {
    if (!query) return;
    const ta = this.textarea;
    const text = ta.value.toLowerCase();
    const q = query.toLowerCase();
    let pos;
    if (dir > 0) {
      pos = text.indexOf(q, ta.selectionEnd);
      if (pos < 0) pos = text.indexOf(q); /* wrap */
    } else {
      pos = text.lastIndexOf(q, ta.selectionStart - 1);
      if (pos < 0) pos = text.lastIndexOf(q); /* wrap */
    }
    if (pos >= 0) {
      ta.focus();
      ta.setSelectionRange(pos, pos + query.length);
    }
  }
}

// ─── File type icons ───
function fileIcon(name, isDir) {
  if (isDir) return '\\ud83d\\udcc1';
  const ext = name.split('.').pop()?.toLowerCase();
  const icons = {
    js: '\\ud83d\\udfe8', ts: '\\ud83d\\udd37', jsx: '\\u269b\\ufe0f', tsx: '\\u269b\\ufe0f',
    html: '\\ud83c\\udf10', htm: '\\ud83c\\udf10', css: '\\ud83d\\udc8e', json: '\\u24bf',
    md: '\\u24c2\\ufe0f', svg: '\\ud83d\\uddbc\\ufe0f', png: '\\ud83d\\uddbc\\ufe0f', jpg: '\\ud83d\\uddbc\\ufe0f',
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
        '<span class="icon">' + arrow + fileIcon(entry.name, isDir) + ' </span>' +
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
    this.tabs = []; /* { path, editor, modified, content, container } */
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

    const lang = langForFile(path);

    const edContainer = document.createElement('div');
    edContainer.style.cssText = 'height:100%;display:none';
    this.editorPane.appendChild(edContainer);

    const self = this;
    const editor = new LiteEditor(edContainer, {
      language: lang,
      onChange: () => {
        const tab = self.tabs.find(t => t.editor === editor);
        if (tab && !tab.modified) {
          tab.modified = true;
          self.renderTabs();
        }
      },
      onSave: () => self.save(),
    });
    editor.setValue(content);

    const tab = { path, editor, modified: false, content, container: edContainer };
    this.tabs.push(tab);
    this.activate(tab);
  }

  activate(tab) {
    if (this.activeTab) {
      this.activeTab.container.style.display = 'none';
    }
    this.activeTab = tab;
    tab.container.style.display = 'block';
    tab.editor.focus();
    this.renderTabs();
  }

  close(tab) {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return;

    tab.editor.destroy();
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
    const content = tab.editor.getValue();
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
    return this.activeTab ? this.activeTab.editor.getValue() : null;
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

// ─── Claude conversation state ───
let claudeConversationActive = false;
let _editorRef = null; // set during init
let _fileTreeRef = null; // set during init
let _bottomRef = null; // set during init

function gatherContext() {
  const ctx = { projectDir: PROJECT_DIR, openFiles: [] };
  if (_editorRef && _editorRef.activeTab) {
    ctx.currentFile = {
      path: _editorRef.activeTab.path,
      content: _editorRef.activeTab.editor?.getValue() || '',
    };
  }
  if (_editorRef) ctx.openFiles = _editorRef.tabs.map(t => t.path);
  if (_bottomRef) {
    const lines = Array.from(_bottomRef.termOutput.querySelectorAll('.term-line'))
      .slice(-20).map(el => el.textContent);
    if (lines.length) ctx.recentTerminal = lines.join('\\n');
  }
  return ctx;
}

function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\\/li>\\n?)+/g, (m) => '<ul>' + m + '</ul>')
    .replace(/\\n/g, '<br>');
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

        const isFirst = !claudeConversationActive;
        const context = isFirst ? gatherContext() : null;

        try {
          const res = await api.claude.chat(prompt, context, isFirst);
          claudeConversationActive = true;
          /* Remove "Thinking..." */
          this.claudeMsgs.lastElementChild?.remove();
          const text = res.stdout || res.stderr || 'No response';
          this.addClaudeMsgRich('assistant', text);

          /* Refresh files Claude may have edited */
          if (_fileTreeRef) _fileTreeRef.refresh();
          if (_editorRef) {
            for (const tab of _editorRef.tabs) {
              try {
                const fresh = await api.fs.read(tab.path);
                if (fresh.content !== undefined && fresh.content !== tab.editor?.getValue()) {
                  tab.editor?.setValue(fresh.content);
                  tab.modified = false;
                  _editorRef.renderTabs();
                }
              } catch {}
            }
          }
        } catch (err) {
          this.claudeMsgs.lastElementChild?.remove();
          this.addClaudeMsg('assistant', 'Error: ' + err.message);
        }
      }
    });

    /* New conversation button */
    document.getElementById('claude-new-btn')?.addEventListener('click', () => {
      claudeConversationActive = false;
      this.claudeMsgs.innerHTML = '';
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

  addClaudeMsgRich(role, text) {
    const msg = document.createElement('div');
    msg.className = 'claude-msg ' + role;
    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    roleEl.textContent = role;
    msg.appendChild(roleEl);

    const body = document.createElement('div');
    body.className = 'body';

    /* Parse fenced code blocks */
    const parts = text.split(/(^\`\`\`[^\\n]*\\n[\\s\\S]*?^\`\`\`)/gm);
    for (const part of parts) {
      const fenceMatch = part.match(/^\`\`\`([^\\n]*)\\n([\\s\\S]*?)^\`\`\`/m);
      if (fenceMatch) {
        const lang = fenceMatch[1].trim() || 'text';
        const code = fenceMatch[2];

        const block = document.createElement('div');
        block.className = 'claude-code-block';

        const pre = document.createElement('pre');
        /* Use tokenizer if available for the language */
        try {
          const mappedLang = lang === 'javascript' ? 'js' : lang === 'typescript' ? 'ts' : lang === 'markdown' ? 'md' : lang;
          pre.innerHTML = tokenize(code, mappedLang);
        } catch {
          pre.textContent = code;
        }
        block.appendChild(pre);

        const actions = document.createElement('div');
        actions.className = 'claude-code-actions';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(code).catch(() => {});
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
        actions.appendChild(copyBtn);

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.addEventListener('click', () => {
          if (_editorRef && _editorRef.activeTab) {
            _editorRef.activeTab.editor.setValue(code);
            _editorRef.activeTab.modified = true;
            _editorRef.renderTabs();
            applyBtn.textContent = 'Applied!';
            setTimeout(() => { applyBtn.textContent = 'Apply'; }, 1500);
          }
        });
        actions.appendChild(applyBtn);

        block.appendChild(actions);
        body.appendChild(block);
      } else if (part.trim()) {
        const prose = document.createElement('div');
        prose.innerHTML = renderMarkdown(part);
        body.appendChild(prose);
      }
    }

    msg.appendChild(body);
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
  document.getElementById('loading-overlay').remove();

  const fileTree = new FileTree(document.getElementById('tree-content'));
  const editor = new EditorManager(document.getElementById('editor-pane'), document.getElementById('tab-bar'));
  const slashMenu = new SlashMenu(document.getElementById('slash-menu'));
  const preview = new PreviewPane();
  const bottom = new BottomPanel();
  const suggestions = new SuggestionsBar(document.getElementById('suggestions-bar'));
  const scaffold = new ScaffoldModal();
  const menuBar = new MenuBar();

  /* Set refs for Claude context gathering */
  _editorRef = editor;
  _fileTreeRef = fileTree;
  _bottomRef = bottom;

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
      case 'undo': editor.activeTab?.editor?.undo(); break;
      case 'redo': editor.activeTab?.editor?.redo(); break;
      case 'find': editor.activeTab?.editor?.openFind(); break;
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
        const promptText = 'Explain this file concisely: ' + editor.activeTab.path;
        bottom.switchTab('claude');
        if (bottom.panel.classList.contains('hidden')) bottom.panel.classList.remove('hidden');
        bottom.addClaudeMsg('user', promptText);
        bottom.addClaudeMsg('assistant', 'Thinking...');
        const isFirst = !claudeConversationActive;
        const ctx = isFirst ? gatherContext() : null;
        try {
          const r = await api.claude.chat(promptText, ctx, isFirst);
          claudeConversationActive = true;
          bottom.claudeMsgs.lastElementChild?.remove();
          bottom.addClaudeMsgRich('assistant', r.stdout || r.stderr || 'No response');
        } catch (err) {
          bottom.claudeMsgs.lastElementChild?.remove();
          bottom.addClaudeMsg('assistant', 'Error: ' + err.message);
        }
        break;
      }
      case 'fix-errors': {
        if (!editor.activeTab) break;
        const promptText2 = 'Find and fix any errors in: ' + editor.activeTab.path;
        bottom.switchTab('claude');
        if (bottom.panel.classList.contains('hidden')) bottom.panel.classList.remove('hidden');
        bottom.addClaudeMsg('user', promptText2);
        bottom.addClaudeMsg('assistant', 'Thinking...');
        const isFirst2 = !claudeConversationActive;
        const ctx2 = isFirst2 ? gatherContext() : null;
        try {
          const r = await api.claude.chat(promptText2, ctx2, isFirst2);
          claudeConversationActive = true;
          bottom.claudeMsgs.lastElementChild?.remove();
          bottom.addClaudeMsgRich('assistant', r.stdout || r.stderr || 'No response');
          /* Refresh files in case Claude made edits */
          fileTree.refresh();
          for (const tab of editor.tabs) {
            try {
              const fresh = await api.fs.read(tab.path);
              if (fresh.content !== undefined && fresh.content !== tab.editor?.getValue()) {
                tab.editor?.setValue(fresh.content);
                tab.modified = false;
                editor.renderTabs();
              }
            } catch {}
          }
        } catch (err) {
          bottom.claudeMsgs.lastElementChild?.remove();
          bottom.addClaudeMsg('assistant', 'Error: ' + err.message);
        }
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
        bottom.appendTerm('Shiro IDE — Browser-native development environment\\nPowered by LiteEditor + Shiro OS', 'stdout');
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
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
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
