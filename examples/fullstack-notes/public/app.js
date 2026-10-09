// The client: plain fetch() against the server's JSON API.
const list = document.getElementById('list');
const status = document.getElementById('status');

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  if (!r.ok && r.status !== 204) throw new Error(`${method} ${url}: ${r.status}`);
  return r.status === 204 ? null : r.json();
}

async function refresh() {
  const notes = await api('GET', '/api/notes');
  list.innerHTML = '';
  for (const n of notes) {
    const li = document.createElement('li');
    li.className = n.done ? 'done' : '';
    li.dataset.id = n.id;
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: n.done });
    box.onchange = () => api('PATCH', `/api/notes/${n.id}`, { done: box.checked }).then(refresh);
    const del = Object.assign(document.createElement('button'), { textContent: 'Delete', className: 'del' });
    del.onclick = () => api('DELETE', `/api/notes/${n.id}`).then(refresh);
    li.append(box, Object.assign(document.createElement('span'), { textContent: n.text }), del);
    list.append(li);
  }
  status.textContent = `${notes.length} note(s), served by the API`;
}

document.getElementById('add').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('text');
  if (!input.value.trim()) return;
  await api('POST', '/api/notes', { text: input.value.trim() });
  input.value = '';
  refresh();
};

refresh().catch((e) => { status.textContent = String(e); });
