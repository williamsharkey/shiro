/**
 * Template palette — modal overlay with starter project templates.
 * Each template is a shell command string that creates files and starts a server.
 */

import type { Shell } from './shell';

interface Template {
  name: string;
  desc: string;
  icon: string;
  cmd: string;
}

const templates: Template[] = [
  {
    name: 'Static Page',
    desc: 'HTML page served on port 3000',
    icon: '🌐',
    cmd: `mkdir -p /tmp/mypage && cat > /tmp/mypage/index.html << 'ENDHTML'
<!DOCTYPE html>
<html>
<head><title>My Page</title><style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px}</style></head>
<body><h1>Hello from Shiro</h1><p>Edit /tmp/mypage/index.html to get started.</p></body>
</html>
ENDHTML
serve /tmp/mypage 3000 --split right`,
  },
  {
    name: 'Node.js Server',
    desc: 'Express API on port 3001',
    icon: '🟩',
    cmd: `mkdir -p /tmp/myapi && cat > /tmp/myapi/server.js << 'ENDJS'
const express = require('express');
const app = express();
app.get('/', (req, res) => res.json({ message: 'Hello from Shiro API' }));
app.get('/time', (req, res) => res.json({ time: new Date().toISOString() }));
app.listen(3001, () => console.log('API running on port 3001'));
ENDJS
node /tmp/myapi/server.js`,
  },
  {
    name: 'Python Script',
    desc: 'Hello world with Pyodide',
    icon: '🐍',
    cmd: `cat > /tmp/hello.py << 'ENDPY'
import sys
print(f"Hello from Python {sys.version}")
for i in range(5):
    print(f"  {i+1}. Shiro runs Python in the browser!")
ENDPY
python /tmp/hello.py`,
  },
  {
    name: 'React App',
    desc: 'JSX + esbuild on port 3002',
    icon: '⚛️',
    cmd: `mkdir -p /tmp/myreact && cat > /tmp/myreact/app.jsx << 'ENDJSX'
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
function App() {
  const [count, setCount] = useState(0);
  return React.createElement('div', { style: { fontFamily: 'system-ui', maxWidth: 400, margin: '40px auto', textAlign: 'center' } },
    React.createElement('h1', null, 'Shiro React'),
    React.createElement('p', null, 'Count: ' + count),
    React.createElement('button', { onClick: () => setCount(c => c + 1), style: { padding: '8px 16px', fontSize: 16 } }, '+1')
  );
}
createRoot(document.getElementById('root')).render(React.createElement(App));
ENDJSX
node -e "require('fs').writeFileSync('/tmp/myreact/index.html','<!DOCTYPE html><html><head><title>React App</title></head><body><div id=root></div><scr'+'ipt src=bundle.js></scr'+'ipt></body></html>')"
build /tmp/myreact/app.jsx --bundle --outfile=/tmp/myreact/bundle.js && serve /tmp/myreact 3002 --split right`,
  },
  {
    name: 'React + Routing',
    desc: 'Multi-page app with live reload',
    icon: '🔀',
    cmd: `mkdir -p /tmp/myapp && cat > /tmp/myapp/app.tsx << 'ENDTSX'
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
var pages = {
  '/': function() { return React.createElement('div', null,
    React.createElement('h1', null, 'Home'),
    React.createElement('p', null, 'A React app running in Shiro with live reload.'),
    React.createElement('nav', null,
      React.createElement('a', { href: '#/about', style: { marginRight: 12 } }, 'About'),
      React.createElement('a', { href: '#/counter' }, 'Counter')))},
  '/about': function() { return React.createElement('div', null,
    React.createElement('h1', null, 'About'),
    React.createElement('p', null, 'Edit /tmp/myapp/app.tsx and watch it update.'),
    React.createElement('p', null, 'Try: page text h1'),
    React.createElement('a', { href: '#/' }, 'Back'))},
  '/counter': function() {
    var s = useState(0);
    return React.createElement('div', null,
      React.createElement('h1', null, 'Counter'),
      React.createElement('p', { id: 'count' }, 'Count: ' + s[0]),
      React.createElement('button', { onClick: function() { s[1](s[0] + 1); }, style: { padding: '8px 16px', fontSize: 16 } }, '+1'),
      React.createElement('br'), React.createElement('br'),
      React.createElement('a', { href: '#/' }, 'Back'))}
};
var style = { fontFamily: 'system-ui', maxWidth: 500, margin: '40px auto', padding: '0 20px' };
function App() {
  var r = useState(location.hash.slice(1) || '/');
  useEffect(function() {
    var fn = function() { r[1](location.hash.slice(1) || '/'); };
    window.addEventListener('hashchange', fn);
    return function() { window.removeEventListener('hashchange', fn); };
  }, []);
  var Page = pages[r[0]] || pages['/'];
  return React.createElement('div', { style: style }, React.createElement(Page));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
ENDTSX
node -e "require('fs').writeFileSync('/tmp/myapp/index.html','<!DOCTYPE html><html><head><title>My App</title></head><body><div id=root></div><scr'+'ipt src=bundle.js></scr'+'ipt></body></html>')"
build /tmp/myapp/app.tsx --bundle --outfile=/tmp/myapp/bundle.js --watch &
serve /tmp/myapp 3003 --split right`,
  },
];

/**
 * Show the template palette modal. Returns when the user picks a template or closes.
 * @param runCmd callback receiving the template name and shell command
 */
export function showTemplatePalette(runCmd: (name: string, cmd: string) => void): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: #1a1a2e; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px; padding: 20px; width: 340px; max-width: 90vw;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  `;

  const title = document.createElement('div');
  title.textContent = 'Start a project';
  title.style.cssText = 'color: #fff; font-size: 16px; font-weight: 600; margin-bottom: 16px;';
  modal.appendChild(title);

  for (const tmpl of templates) {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px; border-radius: 8px; cursor: pointer;
      transition: background 0.1s;
    `;
    row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.06)'; };
    row.onmouseleave = () => { row.style.background = 'none'; };

    const icon = document.createElement('span');
    icon.textContent = tmpl.icon;
    icon.style.cssText = 'font-size: 22px; width: 32px; text-align: center; flex-shrink: 0;';

    const text = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.textContent = tmpl.name;
    nameEl.style.cssText = 'color: rgba(255,255,255,0.9); font-size: 14px; font-weight: 500;';
    const descEl = document.createElement('div');
    descEl.textContent = tmpl.desc;
    descEl.style.cssText = 'color: rgba(255,255,255,0.35); font-size: 12px; margin-top: 2px;';
    text.appendChild(nameEl);
    text.appendChild(descEl);

    row.appendChild(icon);
    row.appendChild(text);
    modal.appendChild(row);

    row.onclick = () => {
      overlay.remove();
      runCmd(tmpl.name, tmpl.cmd);
    };
  }

  overlay.appendChild(modal);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}
