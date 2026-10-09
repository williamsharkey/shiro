// A tiny full-stack app: a JSON API and a static client from one Node process.
// Run: node server.js [port]   (default 3000; tabcomputer previews it with `serve open 3000`)
// No dependencies, so it starts the same way in tabcomputer, on a laptop, or in CI.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const ROOT = path.join(__dirname, 'public');
const DB = process.env.NOTES_DB || path.join(__dirname, 'notes.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function load() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { nextId: 1, notes: [] }; }
}
function save(db) { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); }

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/api\/notes(?:\/(\d+))?$/);
  if (m) {
    const db = load();
    const id = m[1] && Number(m[1]);
    if (req.method === 'GET' && !id) return send(res, 200, db.notes);
    if (req.method === 'POST' && !id) {
      const { text } = await readBody(req);
      if (!text || typeof text !== 'string') return send(res, 400, { error: 'text required' });
      const note = { id: db.nextId++, text: text.slice(0, 500), done: false, at: new Date().toISOString() };
      db.notes.push(note); save(db);
      return send(res, 201, note);
    }
    const note = db.notes.find((n) => n.id === id);
    if (!note) return send(res, 404, { error: 'no such note' });
    if (req.method === 'PATCH') { const b = await readBody(req); if ('done' in b) note.done = !!b.done; save(db); return send(res, 200, note); }
    if (req.method === 'DELETE') { db.notes = db.notes.filter((n) => n !== note); save(db); return send(res, 204, ''); }
    return send(res, 405, { error: 'method not allowed' });
  }
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, node: process.version, pid: process.pid });
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { error: String(e && e.message || e) }));
});
server.listen(PORT, () => console.log(`notes: http://localhost:${PORT}/  (API at /api/notes)`));
module.exports = server;
