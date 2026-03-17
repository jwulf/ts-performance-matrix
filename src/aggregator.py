#!/usr/bin/env python3
"""
Aggregator — central pool exhaustion detector.

Runs on the leader VM (process-0). Workers POST heartbeats reporting their
completed count. The aggregator computes the global remaining pool:

    pool = PRECREATE_COUNT + PRODUCER_RATE * elapsed - sum(completed)

When pool drops below STOP_THRESHOLD, it responds with {"stop": true},
signalling all workers to stop the clock.

Environment:
  PRECREATE_COUNT    — total pre-created instances (default: 50000)
  PRODUCER_RATE      — continuous producer rate in instances/s (default: 2)
  AGGREGATOR_PORT    — port to listen on (default: 3333)
"""

import http.server
import json
import os
import sys
import time
import threading

PRECREATE_COUNT = int(os.environ.get("PRECREATE_COUNT", "50000"))
PRODUCER_RATE = float(os.environ.get("PRODUCER_RATE", "2"))
PORT = int(os.environ.get("AGGREGATOR_PORT", "3333"))
STOP_THRESHOLD = 100

t0 = None
lock = threading.Lock()
process_completed = {}  # processId -> latest completed count
stop_signaled = False


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global t0, stop_signaled

        if self.path != "/heartbeat":
            self.send_error(404)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length))
        process_id = body.get("processId", "")
        completed = body.get("completed", 0)

        with lock:
            if t0 is None:
                t0 = time.monotonic()
                print(f"[aggregator] First heartbeat from {process_id} — clock started", flush=True)

            process_completed[process_id] = completed

            elapsed = time.monotonic() - t0
            total_produced = PRECREATE_COUNT + PRODUCER_RATE * elapsed
            total_consumed = sum(process_completed.values())
            pool = total_produced - total_consumed

            if not stop_signaled and pool < STOP_THRESHOLD:
                stop_signaled = True
                print(
                    f"[aggregator] Pool exhausted: pool={pool:.0f} "
                    f"(produced={total_produced:.0f}, consumed={total_consumed}) "
                    f"after {elapsed:.1f}s — signalling stop",
                    flush=True,
                )

            response = json.dumps({"stop": stop_signaled})

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response.encode())

    def do_GET(self):
        """Health check endpoint."""
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass  # suppress per-request logs


if __name__ == "__main__":
    print(
        f"[aggregator] Listening on port {PORT}, "
        f"precreate={PRECREATE_COUNT}, rate={PRODUCER_RATE}/s, "
        f"threshold={STOP_THRESHOLD}",
        flush=True,
    )
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[aggregator] Shutting down", flush=True)
        server.shutdown()
