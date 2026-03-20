#!/usr/bin/env python3
"""
Python worker for the performance matrix.

Uses the camunda-orchestration-sdk package (published on PyPI) to poll and
complete jobs via the Camunda REST API.

Environment variables (same protocol as TS worker):
  WORKER_PROCESS_ID, SDK_MODE ("rest" or "rest-threaded"), HANDLER_TYPE, HANDLER_LATENCY_MS,
  NUM_WORKERS, TARGET_PER_WORKER, ACTIVATE_BATCH, PAYLOAD_SIZE_KB,
  SCENARIO_TIMEOUT_S, BROKER_REST_URL, RESULT_FILE, READY_FILE, GO_FILE
"""

import asyncio
import json
import math
import os
import sys
import time
import threading

from camunda_orchestration_sdk import (
    CamundaAsyncClient,
    ConnectedJobContext,
    SyncJobContext,
    WorkerConfig,
)

# ─── Config ──────────────────────────────────────────────

PROCESS_ID = os.environ.get("WORKER_PROCESS_ID", "process-0")
SDK_MODE = os.environ.get("SDK_MODE", "rest")
HANDLER_TYPE = os.environ.get("HANDLER_TYPE", "cpu")
HANDLER_LATENCY_MS = int(os.environ.get("HANDLER_LATENCY_MS", "20"))
NUM_WORKERS = int(os.environ.get("NUM_WORKERS", "1"))
TARGET_PER_WORKER = int(os.environ.get("TARGET_PER_WORKER", "10000"))
ACTIVATE_BATCH = int(os.environ.get("ACTIVATE_BATCH", "32"))
SCENARIO_TIMEOUT_S = int(os.environ.get("SCENARIO_TIMEOUT_S", "300"))
BROKER_REST_URL = os.environ.get("BROKER_REST_URL", "http://localhost:8080")
RESULT_FILE = os.environ.get("RESULT_FILE", "./result.json")
READY_FILE = os.environ.get("READY_FILE", "")
GO_FILE = os.environ.get("GO_FILE", "")

# Aggregator URL for centralized pool exhaustion detection
AGGREGATOR_URL = os.environ.get("AGGREGATOR_URL", "")

_aggregator_stop = False
_last_heartbeat = 0.0


def send_heartbeat(total_completed: int):
    """Non-blocking heartbeat to the aggregator (runs in a daemon thread)."""
    global _aggregator_stop, _last_heartbeat
    if not AGGREGATOR_URL:
        return
    now = time.monotonic()
    if now - _last_heartbeat < 2:
        return
    _last_heartbeat = now

    def _do():
        global _aggregator_stop
        try:
            import urllib.request
            req = urllib.request.Request(
                AGGREGATOR_URL + "/heartbeat",
                data=json.dumps({"processId": PROCESS_ID, "completed": total_completed}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            resp = urllib.request.urlopen(req, timeout=1)
            data = json.loads(resp.read())
            if data.get("stop"):
                _aggregator_stop = True
        except Exception:
            pass

    threading.Thread(target=_do, daemon=True).start()

# ─── HTTP sim server port (provided externally by Node.js sim server) ────

http_sim_port = int(os.environ.get("HTTP_SIM_PORT", "0"))


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


# ─── Memory sampling ─────────────────────────────────────

class MemorySampler:
    def __init__(self):
        self._samples = []
        self._running = False
        self._thread = None
        self._page_size = os.sysconf("SC_PAGE_SIZE")

    def _read_rss_bytes(self):
        """Read current process RSS from /proc/self/statm (Linux). Returns bytes."""
        try:
            with open("/proc/self/statm", "r") as f:
                fields = f.read().split()
            return int(fields[1]) * self._page_size
        except Exception:
            return 0

    def start(self):
        self._running = True
        self._samples.append(self._read_rss_bytes())
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while self._running:
            time.sleep(5)
            if self._running:
                self._samples.append(self._read_rss_bytes())

    def stop(self):
        self._running = False
        self._samples.append(self._read_rss_bytes())
        mbs = [s / (1024 * 1024) for s in self._samples]
        peak = max(mbs) if mbs else 0
        avg = sum(mbs) / len(mbs) if mbs else 0
        return {
            "peakRssMb": round(peak, 1),
            "avgRssMb": round(avg, 1),
            "samples": len(self._samples),
        }


# ─── Error type aggregation ───────────────────────────────

error_types: dict = {}

def error_key(exc: Exception) -> str:
    """Extract a root-cause error key like 'ClassName: message'."""
    cause = exc
    while cause.__cause__ is not None:
        cause = cause.__cause__
    name = type(cause).__name__
    msg = str(cause)
    if len(msg) > 120:
        msg = msg[:120]
    return f"{name}: {msg}" if msg else name

def record_error(worker_errors: list, exc: Exception):
    min_idx = min(range(len(worker_errors)), key=lambda i: worker_errors[i])
    worker_errors[min_idx] += 1
    key = error_key(exc)
    error_types[key] = error_types.get(key, 0) + 1


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

    # HTTP client for sim server calls — generous timeout for 200ms handler
    http_client = httpx.AsyncClient(timeout=5.0) if (HANDLER_TYPE == "http" and http_sim_port > 0) else None

    async with CamundaAsyncClient() as client:
        config = WorkerConfig(
            job_type="test-job",
            job_timeout_milliseconds=30_000,
            max_concurrent_jobs=ACTIVATE_BATCH * NUM_WORKERS,
        )

        async def handler(job: ConnectedJobContext) -> dict:
            nonlocal done
            try:
                # Simulate work
                if HANDLER_TYPE == "cpu" and HANDLER_LATENCY_MS > 0:
                    cpu_work(HANDLER_LATENCY_MS)
                elif HANDLER_TYPE == "http" and http_client:
                    await http_client.get(f"http://127.0.0.1:{http_sim_port}/work")

                # Round-robin: assign to worker with fewest completions
                min_idx = min(range(NUM_WORKERS), key=lambda i: worker_completed[i])
                worker_completed[min_idx] += 1
                total = sum(worker_completed)
                if total >= total_target:
                    done = True

                return {"done": True}
            except Exception as e:
                record_error(worker_errors, e)
                raise

        client.create_job_worker(config=config, callback=handler)

        # Run workers as background task, poll for completion, aggregator stop, or timeout
        worker_task = asyncio.create_task(client.run_workers())
        try:
            while not done and not _aggregator_stop and time.monotonic() < deadline:
                send_heartbeat(sum(worker_completed))
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
    total = sum(worker_completed)
    stop_reason = "target" if total >= total_target else ("pool-exhaustion" if _aggregator_stop else "timeout")
    return worker_completed, worker_errors, wall_clock_s, stop_reason


# ─── REST-threaded worker (sync handler in ThreadPoolExecutor) ────

async def run_rest_threaded(http_sim_port: int):
    import urllib.request

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

        # Sync handler — runs in ThreadPoolExecutor, receives SyncJobContext with sync client
        def handler(job: SyncJobContext) -> dict:
            nonlocal done
            try:
                # Simulate work
                if HANDLER_TYPE == "cpu" and HANDLER_LATENCY_MS > 0:
                    cpu_work(HANDLER_LATENCY_MS)
                elif HANDLER_TYPE == "http" and http_sim_port > 0:
                    urllib.request.urlopen(f"http://127.0.0.1:{http_sim_port}/work", timeout=5)

                # Round-robin: assign to worker with fewest completions
                min_idx = min(range(NUM_WORKERS), key=lambda i: worker_completed[i])
                worker_completed[min_idx] += 1
                total = sum(worker_completed)
                if total >= total_target:
                    done = True

                return {"done": True}
            except Exception as e:
                record_error(worker_errors, e)
                raise

        client.create_job_worker(
            config=config, callback=handler,
            execution_strategy="thread",
        )

        # Run workers as background task, poll for completion, aggregator stop, or timeout
        worker_task = asyncio.create_task(client.run_workers())
        try:
            while not done and not _aggregator_stop and time.monotonic() < deadline:
                send_heartbeat(sum(worker_completed))
                await asyncio.sleep(0.05)
        finally:
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                pass

    wall_clock_s = time.monotonic() - t0
    total = sum(worker_completed)
    stop_reason = "target" if total >= total_target else ("pool-exhaustion" if _aggregator_stop else "timeout")
    return worker_completed, worker_errors, wall_clock_s, stop_reason

async def main():
    print(f"[python-worker] id={PROCESS_ID} mode={SDK_MODE} handler={HANDLER_TYPE} workers={NUM_WORKERS}", flush=True)
    print(f"[python-worker] target={TARGET_PER_WORKER}/worker broker={BROKER_REST_URL}", flush=True)

    if HANDLER_TYPE == "http" and http_sim_port > 0:
        print(f"[python-worker] Using external HTTP sim server on port {http_sim_port}", flush=True)
    elif HANDLER_TYPE == "http":
        print("[python-worker] WARNING: HANDLER_TYPE=http but HTTP_SIM_PORT not set", flush=True)

    # Signal ready (barrier protocol)
    write_ready()
    await wait_for_go()

    print("[python-worker] GO received, starting benchmark...", flush=True)

    sampler = MemorySampler()
    sampler.start()

    if SDK_MODE == "rest-threaded":
        worker_completed, worker_errors, wall_clock_s, stop_reason = await run_rest_threaded(http_sim_port)
    else:
        worker_completed, worker_errors, wall_clock_s, stop_reason = await run_rest(http_sim_port)

    total_completed = sum(worker_completed)
    total_errors = sum(worker_errors)
    throughput = total_completed / wall_clock_s if wall_clock_s > 0 else 0

    per_worker_throughputs = [
        c / wall_clock_s if wall_clock_s > 0 else 0 for c in worker_completed
    ]

    # Sort errorTypes by count descending
    sorted_error_types = dict(sorted(error_types.items(), key=lambda x: -x[1]))

    memory_usage = sampler.stop()

    output = {
        "processId": PROCESS_ID,
        "sdkMode": SDK_MODE,
        "handlerType": HANDLER_TYPE,
        "workersInProcess": NUM_WORKERS,
        "totalCompleted": total_completed,
        "totalErrors": total_errors,
        "wallClockS": wall_clock_s,
        "throughput": throughput,
        "stopReason": stop_reason,
        "perWorkerCompleted": worker_completed,
        "perWorkerErrors": worker_errors,
        "perWorkerThroughputs": per_worker_throughputs,
        "errorTypes": sorted_error_types,
        "memoryUsage": memory_usage,
    }

    error_type_count = len(sorted_error_types)
    print(f"[python-worker] Done: {total_completed} completed, {total_errors} errors ({error_type_count} types), {throughput:.1f} ops/s", flush=True)
    if error_type_count > 0:
        for key, count in list(sorted_error_types.items())[:5]:
            print(f"[python-worker]   {count}× {key}", flush=True)

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
