"""占位 sidecar：PCM1 用于验证托管/自愈/端口，PCM2 起逐个替换为真实服务。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    name = "sidecar"
    started = time.time()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] not in ("/health", "/"):
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(
            {
                "ok": True,
                "service": self.name,
                "pid": os.getpid(),
                "uptime": round(time.time() - self.started, 1),
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stdout.write(f"[{self.name}] {fmt % args}\n")
        sys.stdout.flush()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="dhvw_worker")
    parser.add_argument("--name", default="sidecar")
    parser.add_argument("--port", type=int, required=True)
    ns = parser.parse_args(argv)

    Handler.name = ns.name
    server = ThreadingHTTPServer(("127.0.0.1", ns.port), Handler)
    sys.stdout.write(f"[{ns.name}] listening on 127.0.0.1:{ns.port} pid={os.getpid()}\n")
    sys.stdout.flush()

    def heartbeat() -> None:
        while True:
            time.sleep(15)
            sys.stdout.write(f"[{ns.name}] alive pid={os.getpid()}\n")
            sys.stdout.flush()

    threading.Thread(target=heartbeat, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
