#!/usr/bin/env python3
"""
Python worker for the performance matrix.

Uses the camunda-orchestration-sdk package (published on PyPI) to poll and
complete jobs via the Camunda REST API.

Environment variables (same protocol as TS worker):
  WORKER_PROCESS_ID, SDK_MODE (always "rest"), HANDLER_TYPE, HANDLER_LATENCY_MS,
  NUM_WORKERS, TARGET_PER_WORKER, ACTIVATE_BATCH, PAYLOAD_SIZE_KB,
  SCENARIO_TIMEOUT_S, BROKER_REST_URL, RESULT_FILE, READY_FILE, GO_FILE
"""

import asyncio
import json
import math
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

from camunda_orchestration_sdk import CamundaAsyncClient
from camunda_orchestration_sdk.runtime.job_worker import WorkerConfig

# ─── Config ──────────────────────────────────────────────

PROCESS_ID = os.environ.get("WORKER_PROCESS_ID", "process-0")
SDK_MODE = os.environ.get("SDK_MODE", "rest")
HANDLER_TYPE = os.environ.get("HANDLER_TYPE", "cpu")
HANDLER_LATENCY_MS = int(os.environ.get("HANDLER_LATENCY_MS", "200"))
NUM_WORKERS = int(os.environ.get("NUM_WORKERS", "1"))
TARGET_PER_WORKER = int(os.environ.get("TARGET_PER_WORKER", "10000"))
ACTIVATE_BATCH = int(os.environ.get("ACTIVATE_BATCH", "32"))
SCENARIO_TIMEOUT_S = int(os.environ.get("SCENARIO_TIMEOUT_S", "300"))
BROKER_REST_URL = os.environ.get("BROKER_REST_URL", "http://localhost:8080")
RESULT_FILE = os.environ.get("RESULT_FILE", "./result.json")
READY_FILE = os.environ.get("READY_FILE", "")
GO_FILE = os.environ.get("GO_FILE", "")

# ─── HTTP sim server ─────────────────────────────────────

http_sim_port = 0


class SimHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(HANDLER_LATENCY_MS / 1000.0)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, format, *args):
        pass  # suppress logs


def start_http_sim_server(latency_ms: int) -> int:
    server = HTTPServer(("127.0.0.1", 0), SimHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return port


# ─── CPU work simulation ─────────────────────────────────

def cpu_work(duration_ms: int):
    if duration_ms <= 0:
        return
    end = time.monotonic() + duration_ms / 1000.0
    x = 0.0
    while time.monotonic() < end:
        x += math.sin(x + 1)


# ─── Barrier protocol ────────────────────────────────────

def write_ready():
    if READY_FILE:
        d = os.path.dirname(READY_FILE)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(READY_FILE, "w") as f:
            f.write("1")


async def wait_for_go():
    if not GO_FILE:
        return
    while not os.path.exists(GO_FILE):
        await asyncio.sleep(0.01)


# ─── REST worker (using published SDK) ───────────────────

async def run_rest(http_sim_port: int):
    import httpx

    total_target = NUM_WORKERS * TARGET_PER_WORKER

    # Per-worker metrics
    worker_completed = [0] * NUM_WORKERS
    worker_errors = [0] * NUM_WORKERS

    done = False
    t0 = time.monotonic()
    deadline = t0 + SCENARIO_TIMEOUT_S

    # Set SDK env vars from our config
    os.environ["CAMUNDA_REST_ADDRESS"] = BROKER_REST_URL
    os.environ["CAMUNDA_AUTH_STRATEGY"] = "NONE"

    async with CamundaAsyncClient() as client:
        config = WorkerConfig(
            job_type="test-job",
            job_timeout_milliseconds=30_000,
            max_concurrent_jobs=ACTIVATE_BATCH * NUM_WORKERS,
        )

        # HTTP client for sim server calls
        http_client = httpx.AsyncClient() if (HANDLER_TYPE == "http" and http_sim_port > 0) else None

        async def handler(job):
            nonlocal done
            # Simulate work
            if HANDLER_TYPE == "cpu" and HANDLER_LATENCY_MS > 0:
                cpu_work(HANDLER_LATENCY_MS)
            elif HANDLER_TYPE == "http" and http_client:
                try:
                    await http_client.get(f"http://127.0.0.1:{http_sim_port}/work")
                except Exception:
                    pass

            # Round-robin: assign to worker with fewest completions
            min_idx = min(range(NUM_WORKERS), key=lambda i: worker_completed[i])
            worker_completed[min_idx] += 1
            total = sum(worker_completed)
            if total >= total_target:
                done = True

            # Return dict to auto-complete with these variables
            return {"done": True}

        worker = client.create_job_worker(
            config=config, callback=handler, auto_start=True,
        )

        # Run workers as background task, poll for completion or timeout
        worker_task = asyncio.create_task(client.run_workers())
        try:
            while not done and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
        finally:
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                pass

        if http_client:
            await http_client.aclose()

    wall_clock_s = time.monotonic() - t0
    return worker_completed, worker_errors, wall_clock_s


# ─── Main ────────────────────────────────────────────────

async def main():
    print(f"[python-worker] id={PROCESS_ID} mode={SDK_MODE} handler={HANDLER_TYPE} workers={NUM_WORKERS}", flush=True)
    print(f"[python-worker] target={TARGET_PER_WORKER}/worker broker={BROKER_REST_URL}", flush=True)

    global http_sim_port
    if HANDLER_TYPE == "http" and HANDLER_LATENCY_MS > 0:
        http_sim_port = start_http_sim_server(HANDLER_LATENCY_MS)

    # Signal ready (barrier protocol)
    write_ready()
    await wait_for_go()

    print("[python-worker] GO received, starting benchmark...", flush=True)

    worker_completed, worker_errors, wall_clock_s = await run_rest(http_sim_port)

    total_completed = sum(worker_completed)
    total_errors = sum(worker_errors)
    throughput = total_completed / wall_clock_s if wall_clock_s > 0 else 0

    per_worker_throughputs = [
        c / wall_clock_s if wall_clock_s > 0 else 0 for c in worker_completed
    ]

    output = {
        "processId": PROCESS_ID,
        "sdkMode": SDK_MODE,
        "handlerType": HANDLER_TYPE,
        "workersInProcess": NUM_WORKERS,
        "totalCompleted": total_completed,
        "totalErrors": total_errors,
        "wallClockS": wall_clock_s,
        "throughput": throughput,
        "perWorkerCompleted": worker_completed,
        "perWorkerErrors": worker_errors,
        "perWorkerThroughputs": per_worker_throughputs,
    }

    print(f"[python-worker] Done: {total_completed} completed, {total_errors} errors, {throughput:.1f} ops/s", flush=True)

    with open(RESULT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    print(f"[python-worker] Result written to {RESULT_FILE}", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"[python-worker] Fatal error: {e}", file=sys.stderr, flush=True)
        output = {
            "processId": PROCESS_ID,
            "sdkMode": SDK_MODE,
            "handlerType": HANDLER_TYPE,
            "workersInProcess": NUM_WORKERS,
            "totalCompleted": 0,
            "totalErrors": 0,
            "wallClockS": 0,
            "throughput": 0,
            "perWorkerCompleted": [],
            "perWorkerErrors": [],
            "perWorkerThroughputs": [],
            "error": str(e),
        }
        with open(RESULT_FILE, "w") as f:
            json.dump(output, f, indent=2)
        sys.exit(1)
