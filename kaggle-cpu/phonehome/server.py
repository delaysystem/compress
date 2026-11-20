#!/usr/bin/env python3
"""Phone-home receiver for Kaggle kernels (stdlib only).

  PHONEHOME_TOKEN=<secret> [PHONEHOME_PORT=8765] server.py

POST /hb?token=<secret> with a JSON object -> appended to
/tmp/kwatch/live.jsonl and printed as one LIVE line on stdout.
GET /health -> ok (no auth, for tunnel checks).

Token is a bearer secret: generated at deploy, kept in /tmp/phonehome/,
stamped into kernels by phonehome/push.sh, NEVER committed.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TOKEN = os.environ.get("PHONEHOME_TOKEN", "")
_TOKEN_FILE = os.environ.get("PHONEHOME_TOKEN_FILE", "")
if _TOKEN_FILE:
    TOKEN = open(_TOKEN_FILE).read().strip()
PORT = int(os.environ.get("PHONEHOME_PORT", "8765"))
LOG = "/tmp/kwatch/live.jsonl"


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if urlparse(self.path).path == "/health":
            self._send(200, b"ok")
        else:
            self._send(404, b"no\n")

    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        want = parse_qs(u.query).get("token", [""])[0]
        if u.path != "/hb" or not TOKEN or want != TOKEN:
            self._send(403, b"no\n")
            return
        try:
            n = min(int(self.headers.get("Content-Length") or 0), 8192)
        except ValueError:
            n = 0
        try:
            evt = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            evt = {}
        items = list(evt.items()) if isinstance(evt, dict) else []
        evt = {str(k)[:32]: str(v)[:300] for k, v in items[:8]}
        evt["t"] = round(time.time(), 1)
        with open(LOG, "a") as f:
            f.write(json.dumps(evt) + "\n")
        print(
            f"LIVE {evt.get('kernel', '?')} {evt.get('phase', '?')} "
            f"{evt.get('msg', '')}",
            flush=True,
        )
        self._send(200, b"ok\n")


if not TOKEN:
    sys.exit("PHONEHOME_TOKEN is required (refusing to run open)")
os.makedirs(os.path.dirname(LOG), exist_ok=True)
print(f"phone-home receiver on 127.0.0.1:{PORT}, log {LOG}", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
