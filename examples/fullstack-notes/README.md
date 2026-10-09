# fullstack-notes: a server and a client in one tab

A small notes app in which the backend (a JSON API) and the frontend (HTML and
`fetch()`) run together inside tabcomputer, with the frontend in a preview
window on the desktop. This is the "server and client in the same sandbox"
case that front-end-only sandboxes (JSFiddle, CodePen) can't do, and that
WebContainers does only for Node. See
[docs/research/SANDBOXES.md](../../docs/research/SANDBOXES.md).

| File | What |
|---|---|
| `server.js` | Node HTTP server: `GET/POST /api/notes`, `PATCH/DELETE /api/notes/:id`, `GET /api/health`, static files from `public/`. No dependencies. |
| `server.py` | The same API in Python (standard library only), for Debian's `python3`. |
| `public/` | The client: `index.html`, `app.js` (`fetch()` against the API), `style.css`. |
| `test.js` | API test: starts the server on a spare port and drives it over HTTP. |

Notes are kept in `notes.json` next to the server (or `$NOTES_DB`).

## Run it in tabcomputer

```sh
# get the files into tabcomputer (e.g. git clone this repo, or drag the folder onto Files)
cd fullstack-notes
node test.js                 # 9 checks; prints "ok N - ..." lines
node server.js 3000 &        # the API and the client on port 3000
serve open 3000              # a desktop window with the app
page :3000 input '#text' 'hello'; page :3000 click '#save'; page :3000 text '#list'
curl -s localhost:3000/api/notes
```

Python instead of Node (Debian mode, because the server needs real sockets):

```sh
debian install && sudo apt update && sudo apt install -y python3
python3 server.py 3002 &
serve open 3002
```

## Run it anywhere else

```sh
node test.js && node server.js       # http://localhost:3000/
python3 server.py                    # http://localhost:3001/
```

## What was verified (2026-10-09, https://tabcomputer.com, headless Chromium)

- `node server.js 3000 &`, then `serve fetch 3000 /api/health`, gives 200.
- `serve open 3000` opens the app in a desktop window (it reports "0 note(s), served
  by the API").
- `page` input, click and text add a note through the client. The server writes
  `notes.json`, and the checkbox's PATCH marks it done.
- `curl` from the shell reaches the same server.

Not working yet:

- tabcomputer's `node` has no `assert.match`, so the test uses
  `assert.ok(re.test(...))`.
- File watching (`fs.watch`) delivers no events, so there is no auto-reload on
  save.
- WebSocket and EventSource from the preview: see SANDBOXES.md.
