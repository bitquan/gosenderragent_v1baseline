#!/usr/bin/env python3
"""Minimal webhook receiver that triggers dev_assistant autopilot runs.

This file implements a tiny HTTP server with one POST endpoint. It does not
perform any secret validation; in a real setup you should verify signatures
from GitHub/GitLab/other systems.

Usage:
    python backend/scripts/webhook_listener.py --port 8080

When a POST is received, the assistant is invoked in autopilot mode. You can
use this to trigger runs on merge events, comments, board updates, etc.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import os
import hmac
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

class WebhookHandler(BaseHTTPRequestHandler):
    def _check_signature(self, body: bytes) -> bool:
        """Validate request body against configured secret (if any).

        Uses the X-Hub-Signature-256 header (GitHub style). If no secret is
        configured we accept every request (useful for local testing).
        """
        secret = os.environ.get("WEBHOOK_SECRET")
        sig_header = self.headers.get("X-Hub-Signature-256")
        if not secret:
            # no secret configured; do not enforce
            return True
        if not sig_header or not sig_header.startswith("sha256="):
            return False
        try:
            provided = sig_header.split("=", 1)[1]
        except Exception:
            return False
        digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        # use hmac.compare_digest to prevent timing attacks
        return hmac.compare_digest(provided, digest)

    def do_POST(self):
        # read body and optionally inspect JSON payload
        length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(length) if length else b''
        if not self._check_signature(body):
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'unverified')
            return
        try:
            data = json.loads(body.decode('utf-8'))
        except Exception:
            data = None
        print('webhook received', self.path, data)
        # simple trigger
        cmd = [sys.executable, str(ROOT / 'backend' / 'scripts' / 'dev_assistant.py'), '--autopilot']
        subprocess.Popen(cmd, cwd=str(ROOT))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')


def main():
    parser = argparse.ArgumentParser(description='Webhook listener for dev assistant')
    parser.add_argument('--port', type=int, default=8001, help='Port to listen on')
    args = parser.parse_args()
    server = HTTPServer(('0.0.0.0', args.port), WebhookHandler)
    print(f'Listening for webhooks on port {args.port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('shutting down')


if __name__ == '__main__':
    main()
