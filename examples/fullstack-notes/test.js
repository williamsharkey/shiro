// API test: starts the server on a spare port and drives it over HTTP.
// Run: node test.js   (prints "ok N" lines, exits non-zero on failure)
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NOTES_DB = path.join(os.tmpdir(), `notes-test-${process.pid}.json`);
try { fs.unlinkSync(process.env.NOTES_DB); } catch {}
const PORT = 3000 + (process.pid % 1000) + 1;
process.argv[2] = String(PORT);
const server = require('./server.js');

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: 'localhost', port: PORT, path: url, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s ? (res.headers['content-type'] || '').includes('json') ? JSON.parse(s) : s : null }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

let n = 0;
const ok = (msg) => console.log(`ok ${++n} - ${msg}`);

(async () => {
  let r = await req('GET', '/api/notes');
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, []); ok('empty list');
  r = await req('POST', '/api/notes', { text: 'buy milk' });
  assert.strictEqual(r.status, 201); assert.strictEqual(r.body.text, 'buy milk'); ok('create');
  const id = r.body.id;
  r = await req('POST', '/api/notes', {});
  assert.strictEqual(r.status, 400); ok('reject empty note');
  r = await req('PATCH', `/api/notes/${id}`, { done: true });
  assert.strictEqual(r.body.done, true); ok('mark done');
  r = await req('GET', '/api/notes');
  assert.strictEqual(r.body.length, 1); ok('list has one');
  r = await req('GET', '/');
  assert.strictEqual(r.status, 200); assert.ok(/<h1>Notes<\/h1>/.test(r.body)); ok('serves the client');
  r = await req('GET', '/../server.js');
  assert.notStrictEqual(r.status, 200); ok('no path traversal');
  r = await req('DELETE', `/api/notes/${id}`);
  assert.strictEqual(r.status, 204); ok('delete');
  r = await req('GET', `/api/notes/${id}`);
  assert.strictEqual(r.status, 404); ok('gone');
  console.log(`# ${n} passed`);
  server.close();
  try { fs.unlinkSync(process.env.NOTES_DB); } catch {}
  process.exit(0);
})().catch((e) => { console.log('not ok -', e.message); process.exit(1); });
