#!/usr/bin/env python3
"""The same notes API in Python (standard library only), serving the same client.

Run: python3 server.py [port]   (default 3001). Shares notes.json with server.js.
"""
import json, os, sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "public")
DB = os.environ.get("NOTES_DB", os.path.join(HERE, "notes.json"))
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css"}


def load():
    try:
        with open(DB) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"nextId": 1, "notes": []}


def save(db):
    with open(DB, "w") as f:
        json.dump(db, f, indent=2)


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body)).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def route(self):
        parts = self.path.split("?")[0].strip("/").split("/")
        if parts[:2] != ["api", "notes"]:
            return None, None
        return load(), (int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            return self.send(200, {"ok": True, "python": sys.version.split()[0], "pid": os.getpid()})
        db, nid = self.route()
        if db is not None:
            return self.send(200, db["notes"]) if nid is None else self.one(db, nid, lambda n: self.send(200, n))
        rel = os.path.normpath(self.path.split("?")[0].lstrip("/") or "index.html")
        path = os.path.join(ROOT, rel)
        if rel.startswith("..") or not os.path.isfile(path):
            return self.send(404, "not found", "text/plain")
        with open(path, "rb") as f:
            self.send(200, f.read(), TYPES.get(os.path.splitext(path)[1], "application/octet-stream"))

    def one(self, db, nid, fn):
        note = next((n for n in db["notes"] if n["id"] == nid), None)
        return fn(note) if note else self.send(404, {"error": "no such note"})

    def do_POST(self):
        db, nid = self.route()
        if db is None or nid is not None:
            return self.send(405, {"error": "method not allowed"})
        text = self.body().get("text")
        if not isinstance(text, str) or not text:
            return self.send(400, {"error": "text required"})
        note = {"id": db["nextId"], "text": text[:500], "done": False,
                "at": datetime.now(timezone.utc).isoformat()}
        db["nextId"] += 1
        db["notes"].append(note)
        save(db)
        self.send(201, note)

    def do_PATCH(self):
        db, nid = self.route()
        def patch(note):
            b = self.body()
            if "done" in b:
                note["done"] = bool(b["done"])
            save(db)
            self.send(200, note)
        return self.one(db, nid, patch) if db is not None else self.send(404, {"error": "not found"})

    def do_DELETE(self):
        db, nid = self.route()
        def delete(note):
            db["notes"].remove(note)
            save(db)
            self.send(204, b"")
        return self.one(db, nid, delete) if db is not None else self.send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("py: " + fmt % args + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3001
    print(f"notes (python): http://localhost:{port}/", flush=True)
    ThreadingHTTPServer(("", port), Handler).serve_forever()
