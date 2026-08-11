#!/usr/bin/env python3
"""Serve the EMA cross dashboard. Reads scan.json off disk; POST /api/rescan re-runs the scanner."""

import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PORT = 8790

_scan_lock = threading.Lock()
_scanning = {"running": False, "log": ""}


def run_scan():
    with _scan_lock:
        if _scanning["running"]:
            return
        _scanning["running"] = True
    try:
        p = subprocess.run([sys.executable, str(ROOT / "scanner.py"), "--workers", "8"],
                           capture_output=True, text=True, cwd=ROOT, timeout=1800)
        _scanning["log"] = (p.stderr or "")[-2000:]
    except Exception as e:
        _scanning["log"] = f"scan failed: {e}"
    finally:
        _scanning["running"] = False


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            f = ROOT / "index.html"
            if not f.exists():
                return self._send(404, "index.html missing", "text/plain")
            return self._send(200, f.read_bytes(), "text/html; charset=utf-8")
        if path == "/api/scan":
            f = ROOT / "data" / "scan.json"
            if not f.exists():
                return self._send(404, json.dumps({"error": "no scan yet"}), "application/json")
            return self._send(200, f.read_bytes(), "application/json")
        if path == "/api/status":
            return self._send(200, json.dumps(_scanning), "application/json")
        return self._send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path.split("?")[0] == "/api/rescan":
            if _scanning["running"]:
                return self._send(409, json.dumps({"error": "scan already running"}),
                                  "application/json")
            threading.Thread(target=run_scan, daemon=True).start()
            return self._send(202, json.dumps({"started": True}), "application/json")
        return self._send(404, "not found", "text/plain")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"EMA cross dashboard → http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
