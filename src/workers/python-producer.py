#!/usr/bin/env python3
"""
Python Producer — deploys BPMN and pre-creates process instances using the Python SDK.

Runs on the worker-0 VM before the benchmark starts.

Environment variables:
  BROKER_REST_URL   — broker REST URL (e.g., http://10.x.x.x:8080)
  BPMN_PATH         — path to the BPMN file to deploy
  PRECREATE_COUNT   — number of process instances to pre-create
  PAYLOAD_SIZE_KB   — variable payload size in KB (default: 10)
"""

import asyncio
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
CONCURRENCY = 50


async def main():
    if not BPMN_PATH:
        print("[python-producer] BPMN_PATH not set", file=sys.stderr)
        sys.exit(1)

    print(f"[python-producer] broker={BROKER_REST_URL} bpmn={BPMN_PATH} precreate={PRECREATE_COUNT}")

    async with CamundaAsyncClient() as client:
        # Deploy
        print("[python-producer] Deploying process...")
        deployment = await client.deploy_resources_from_files([BPMN_PATH])
        process_def_key = deployment.processes[0].process_definition_key
        print(f"[python-producer] Deployed: {process_def_key}")

        # Wait for deployment propagation
        await asyncio.sleep(10)

        if PRECREATE_COUNT <= 0:
            print("[python-producer] No pre-creation requested, done.")
            return

        # Build payload
        chars = string.ascii_letters + string.digits
        payload = "".join(random.choices(chars, k=PAYLOAD_SIZE_KB * 1024))

        variables = ProcessInstanceCreationInstructionByKeyVariables()
        variables.additional_properties = {"data": payload}

        # Pre-create with concurrency control
        created = 0
        errors = 0
        sem = asyncio.Semaphore(CONCURRENCY)
        t0 = time.time()
        last_log = t0

        print(f"[python-producer] Creating {PRECREATE_COUNT} process instances...")

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
                    print(f"[python-producer] {created + errors}/{PRECREATE_COUNT} ({created} ok, {errors} err) {elapsed}s, ~{rate}/s")
                    last_log = now

        tasks = [asyncio.create_task(create_one()) for _ in range(PRECREATE_COUNT)]
        await asyncio.gather(*tasks)

        duration_s = time.time() - t0
        print(f"[python-producer] Done: {created} created, {errors} errors in {duration_s:.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
