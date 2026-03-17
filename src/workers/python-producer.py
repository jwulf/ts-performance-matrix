#!/usr/bin/env python3
"""
Python Producer — deploys BPMN, pre-creates process instances, and optionally
runs a continuous producer during the benchmark.

Runs on the leader (worker-0) VM.

Environment variables:
  BROKER_REST_URL        — broker REST URL (e.g., http://10.x.x.x:8080)
  BPMN_PATH              — path to the BPMN file to deploy
  PRECREATE_COUNT        — number of process instances to pre-create (buffer)
  PAYLOAD_SIZE_KB        — variable payload size in KB (default: 10)
  CONTINUOUS             — if "1", keep creating after pre-creation until STOP_FILE appears
  READY_FILE             — write "1" here when pre-creation is done (optional)
  GO_FILE                — wait for this file before starting continuous mode (optional)
  STOP_FILE              — stop continuous production when this file appears
  PRODUCER_STATS_FILE    — write continuous producer stats JSON here on exit
"""

import asyncio
import json
import os
import random
import string
import sys
import time

# Configure SDK env vars before importing
BROKER_REST_URL = os.environ.get("BROKER_REST_URL", "http://localhost:8080")
os.environ["CAMUNDA_REST_ADDRESS"] = BROKER_REST_URL
os.environ["CAMUNDA_AUTH_STRATEGY"] = "NONE"

from camunda_orchestration_sdk import CamundaAsyncClient
from camunda_orchestration_sdk.models import ProcessCreationByKey, ProcessInstanceCreationInstructionByKeyVariables

BPMN_PATH = os.environ.get("BPMN_PATH", "")
PRECREATE_COUNT = int(os.environ.get("PRECREATE_COUNT", "0"))
PAYLOAD_SIZE_KB = int(os.environ.get("PAYLOAD_SIZE_KB", "10"))
PRECREATE_CONCURRENCY = 200
CONTINUOUS_BATCH = 10
CONTINUOUS_INTERVAL_S = 5
CONTINUOUS = os.environ.get("CONTINUOUS", "0") == "1"
READY_FILE = os.environ.get("READY_FILE", "")
GO_FILE = os.environ.get("GO_FILE", "")
STOP_FILE = os.environ.get("STOP_FILE", "")
PRODUCER_STATS_FILE = os.environ.get("PRODUCER_STATS_FILE", "")
PRECREATE_STATS_FILE = os.environ.get("PRECREATE_STATS_FILE", "")


async def create_batch(client, process_def_key, variables, count, label):
    """Create a fixed number of instances with concurrency control."""
    created = 0
    errors = 0
    sem = asyncio.Semaphore(PRECREATE_CONCURRENCY)
    t0 = time.time()
    last_log = t0

    print(f"[python-producer] {label}: creating {count} instances...")

    async def create_one():
        nonlocal created, errors, last_log
        async with sem:
            try:
                await client.create_process_instance(
                    data=ProcessCreationByKey(
                        process_definition_key=process_def_key,
                        variables=variables,
                    )
                )
                created += 1
            except Exception:
                errors += 1

            now = time.time()
            if now - last_log > 10:
                elapsed = int(now - t0)
                rate = int(created / (now - t0)) if now > t0 else 0
                print(f"[python-producer] {label}: {created + errors}/{count} ({created} ok, {errors} err) {elapsed}s, ~{rate}/s")
                last_log = now

    tasks = [asyncio.create_task(create_one()) for _ in range(count)]
    await asyncio.gather(*tasks)

    duration_s = time.time() - t0
    print(f"[python-producer] {label}: done {created} created, {errors} errors in {duration_s:.1f}s")
    return created, errors, duration_s


async def continuous_loop(client, process_def_key, variables):
    """Create instances continuously until STOP_FILE appears."""
    created = 0
    errors = 0
    t0 = time.time()
    last_log = t0

    print(f"[python-producer] continuous: starting (batch={CONTINUOUS_BATCH} every {CONTINUOUS_INTERVAL_S}s)...")

    while not STOP_FILE or not os.path.exists(STOP_FILE):
        # Launch a small batch
        batch_created = 0
        batch_errors = 0

        async def create_one():
            nonlocal created, errors, batch_created, batch_errors
            try:
                await client.create_process_instance(
                    data=ProcessCreationByKey(
                        process_definition_key=process_def_key,
                        variables=variables,
                    )
                )
                created += 1
                batch_created += 1
            except Exception:
                errors += 1
                batch_errors += 1

        tasks = [asyncio.create_task(create_one()) for _ in range(CONTINUOUS_BATCH)]
        await asyncio.gather(*tasks)

        now = time.time()
        if now - last_log > 10:
            elapsed = int(now - t0)
            rate = int(created / (now - t0)) if now > t0 else 0
            print(f"[python-producer] continuous: {created} ok, {errors} err, {elapsed}s, ~{rate}/s")
            last_log = now

        await asyncio.sleep(CONTINUOUS_INTERVAL_S)

    duration_s = time.time() - t0
    rate = created / duration_s if duration_s > 0 else 0
    print(f"[python-producer] continuous: stopped. {created} created, {errors} errors in {duration_s:.1f}s (~{rate:.0f}/s)")

    if PRODUCER_STATS_FILE:
        stats = {"created": created, "errors": errors, "durationS": round(duration_s, 1), "rate": round(rate, 1)}
        with open(PRODUCER_STATS_FILE, "w") as f:
            json.dump(stats, f)
        print(f"[python-producer] continuous: stats written to {PRODUCER_STATS_FILE}")


async def main():
    if not BPMN_PATH:
        print("[python-producer] BPMN_PATH not set", file=sys.stderr)
        sys.exit(1)

    print(f"[python-producer] broker={BROKER_REST_URL} bpmn={BPMN_PATH} precreate={PRECREATE_COUNT} continuous={CONTINUOUS}")

    async with CamundaAsyncClient() as client:
        # Deploy
        print("[python-producer] Deploying process...")
        deployment = await client.deploy_resources_from_files([BPMN_PATH])
        process_def_key = deployment.processes[0].process_definition_key
        print(f"[python-producer] Deployed: {process_def_key}")

        # Wait for deployment propagation
        await asyncio.sleep(10)

        # Build payload
        chars = string.ascii_letters + string.digits
        payload = "".join(random.choices(chars, k=PAYLOAD_SIZE_KB * 1024))

        variables = ProcessInstanceCreationInstructionByKeyVariables()
        variables.additional_properties = {"data": payload}

        # Phase 1: pre-create buffer
        if PRECREATE_COUNT > 0:
            pc_created, pc_errors, pc_duration = await create_batch(client, process_def_key, variables, PRECREATE_COUNT, "pre-create")
            if PRECREATE_STATS_FILE:
                with open(PRECREATE_STATS_FILE, "w") as f:
                    json.dump({"created": pc_created, "errors": pc_errors, "durationS": pc_duration}, f)
                print(f"[python-producer] Pre-create stats written to {PRECREATE_STATS_FILE}")

        # Signal ready
        if READY_FILE:
            with open(READY_FILE, "w") as f:
                f.write("1")
            print(f"[python-producer] Ready signal written to {READY_FILE}")

        if not CONTINUOUS:
            print("[python-producer] Done (no continuous mode).")
            return

        # Wait for GO
        if GO_FILE:
            print(f"[python-producer] Waiting for GO file: {GO_FILE}")
            while not os.path.exists(GO_FILE):
                await asyncio.sleep(0.1)
            print("[python-producer] GO received, starting continuous production...")

        # Phase 2: continuous production
        await continuous_loop(client, process_def_key, variables)


if __name__ == "__main__":
    asyncio.run(main())
