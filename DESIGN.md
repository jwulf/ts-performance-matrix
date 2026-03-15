# Performance Envelope: Optimal Worker-to-Process Ratio

## Problem Statement

A Camunda customer asked: **"How many workers should I have per application?"**

This is fundamentally a question about the optimal **worker-to-process ratio**. Given a workload
that requires W concurrent workers, should you run:

- **W separate applications** each with 1 worker? (maximum isolation)
- **1 application** with W workers? (maximum sharing)
- **Something in between** — P applications each with W/P workers?

The answer depends on the interplay between:

1. **Backpressure isolation**: Each OS process has its own `BackpressureManager`. When processes
   are isolated, one overloaded worker can't starve others. In a shared process, all workers share
   one concurrency limiter — under backpressure the limiter may throttle all workers equally, even
   if only one is causing the problem.

2. **Connection overhead**: Each process opens its own HTTP/gRPC connections. More processes =
   more connections = more overhead on both client and server.

3. **Resource efficiency**: OS processes have memory overhead (~50-100MB each for a Node.js
   process). At 50 processes the overhead is 2.5-5GB of RAM just for V8 heaps.

4. **Fairness**: With separate processes, the broker distributes work across connections. With
   shared processes, the SDK's internal job distribution determines fairness.

5. **Transport protocol**: REST (with backpressure management) vs gRPC (streaming or polling)
   have fundamentally different scaling characteristics.

## Prior Art: The 50/100 Worker Matrix

Previous benchmarking with 50 and 100 workers revealed:

| Finding | Detail |
|---------|--------|
| **Independent >> Shared** | Independent processes delivered 5-8× throughput with 1000× fewer errors |
| **BALANCED >> LEGACY** | Adaptive backpressure reduced errors 82-97% with equal/better throughput |
| **gRPC streaming collapses** | Jain fairness drops from 0.99 to 0.03 above 50 workers |
| **gRPC poll is competitive** | Matches REST throughput without the streaming fairness problem |
| **3-broker doubles throughput** | At 50 workers; diminishing returns at 100 (client bottleneck) |

But these results only compared the extremes: all-independent vs all-shared. They don't answer
**where the crossover point is**.

## The Performance Envelope

We need to map the **performance envelope** — the surface defined by:

```
throughput = f(total_workers, workers_per_process, sdk_mode, handler_type, cluster_size)
```

### Matrix Dimensions

| Dimension | Values | Rationale |
|-----------|--------|-----------|
| **Total workers (W)** | 10, 20, 50, 100 | Small team → medium → large deployment → backpressure stress test |
| **Workers per process (WPP)** | 1, 2, 5, 10, 25, 50 | Granular sweep from full isolation to full sharing |
| **SDK mode** | `rest-balanced`, `grpc-poll` | Two competitive modes from prior data |
| **Handler type** | `cpu`, `http` | CPU-bound (200ms busy-loop) vs I/O-bound (200ms async wait) |
| **Cluster** | `1broker`, `3broker` | Single vs distributed broker |

Not every (W, WPP) combination is valid — WPP must divide W evenly, and WPP ≤ W.
For example, W=10 with WPP=25 is impossible.

### Valid Configurations

| Total Workers | Workers/Process | Processes | Notes |
|:---:|:---:|:---:|:---|
| 10 | 1 | 10 | Full isolation |
| 10 | 2 | 5 | |
| 10 | 5 | 2 | |
| 10 | 10 | 1 | Full sharing |
| 20 | 1 | 20 | Full isolation |
| 20 | 2 | 10 | |
| 20 | 5 | 4 | |
| 20 | 10 | 2 | |
| 20 | 20 | 1 | Full sharing |
| 50 | 1 | 50 | Full isolation |
| 50 | 2 | 25 | |
| 50 | 5 | 10 | |
| 50 | 10 | 5 | |
| 50 | 25 | 2 | |
| 50 | 50 | 1 | Full sharing |

That's **15 topology configurations** × 2 SDK modes × 2 handlers × 2 clusters = **120 scenarios**.

### Key Questions This Answers

1. **At what WPP does throughput degrade?** Is the drop linear or cliff-like?
2. **At what WPP does fairness collapse?** Do workers within a process get starved?
3. **Does the crossover point differ by transport?** REST vs gRPC may have different sweet spots.
4. **Does cluster size shift the crossover?** More broker capacity may tolerate more sharing.
5. **What's the cost of isolation?** Connection overhead and memory at 50 separate processes.

## Architecture

### Why Cloud VMs?

Running 50 separate Node.js processes on a single laptop creates **resource contention** that
confounds the results. CPU, memory, and network are all shared, making it impossible to
distinguish "SDK overhead" from "laptop running out of resources."

By running each "application" (process group) on a separate VM, we get:

- **True process isolation**: Each VM has dedicated CPU and memory
- **Realistic networking**: Processes communicate with the broker over the network, not localhost
- **Parallel execution**: Multiple scenarios run simultaneously across VM pools
- **Reproducibility**: Identical VM specs eliminate hardware variance

### GCP Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Orchestrator VM                     │
│  (e2-standard-4, runs matrix controller)             │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  run-matrix.ts                                   │ │
│  │  - Enumerates matrix configurations              │ │
│  │  - Provisions worker VM pools per scenario       │ │
│  │  - Manages Camunda broker VM lifecycle           │ │
│  │  - Collects results from GCS                     │ │
│  │  - Generates analysis report                     │ │
│  └─────────────────────────────────────────────────┘ │
└───────────────┬───────────────────────────────────────┘
                │ gcloud compute API
    ┌───────────┼───────────────┐
    ▼           ▼               ▼
┌────────┐ ┌────────┐   ┌────────────┐
│Broker  │ │Broker  │   │ Workers    │
│VM 1    │ │VM 2..N │   │ VM Pool    │
│(1-3x   │ │(for 3  │   │            │
│ broker) │ │broker) │   │ P VMs, each│
│        │ │        │   │ running WPP│
│ Docker │ │ Docker │   │ workers    │
│Compose │ │Compose │   │            │
└────┬───┘ └────┬───┘   └─────┬──────┘
     │          │              │
     └──────────┴──────────────┘
              VPC Network
              (internal IPs)
```

### VM Specifications

| Role | Machine Type | Count | Purpose |
|------|-------------|-------|---------|
| **Orchestrator** | `e2-standard-4` | 1 | Matrix controller, result aggregation |
| **Broker** | `e2-standard-8` | 1 or 3 | Camunda 8 broker(s) with H2 in-memory |
| **Worker** | `e2-standard-2` | P (varies) | Each runs WPP workers in one Node.js process |

Worker VMs use `e2-standard-2` (2 vCPU, 8GB RAM) — enough for up to 50 workers in a single
process, but small enough that provisioning 50 of them is affordable.

### Execution Flow

```
For each scenario (W, WPP, mode, handler, cluster):

1. PROVISION BROKER
   - Create broker VM(s) from startup script template
   - Wait for health check (REST /v2/topology 200 OK)

2. DEPLOY PROCESS
   - Deploy test BPMN to the broker via REST API

3. PRE-CREATE INSTANCES
   - Create W × TARGET_PER_WORKER process instances
   - Use BALANCED backpressure profile for rate limiting

4. PROVISION WORKER VMS
   - Create P = W/WPP worker VMs
   - Each VM startup script:
     a. Install Node.js + tsx
     b. Clone/download worker script
     c. Set environment: SDK_MODE, HANDLER_TYPE, NUM_WORKERS=WPP, BROKER_URL
     d. Write "ready" flag to GCS
   - Wait for all P VMs to report ready

5. START BENCHMARK
   - Write "go" flag to GCS
   - All worker VMs begin simultaneously (barrier protocol via GCS)

6. COLLECT RESULTS
   - Each worker VM writes result JSON to GCS on completion
   - Orchestrator polls for P result files (or timeout)

7. TEARDOWN
   - Delete worker VMs
   - Optionally retain broker for next scenario with same cluster config

8. AGGREGATE
   - Parse results, compute throughput/errors/fairness
   - Append to scenario report
```

### GCS Coordination Protocol

Instead of the filesystem-based barrier protocol used in the local runner, the cloud version
uses Google Cloud Storage (GCS) for coordination:

```
gs://perf-matrix-{run-id}/
  scenarios/
    {scenario-id}/
      go                      # Written by orchestrator → signals start
      ready/
        worker-0              # Written by each worker VM when initialized
        worker-1
        ...
      results/
        worker-0.json         # Written by each worker VM on completion
        worker-1.json
        ...
      broker-metrics-before.json
      broker-metrics-after.json
```

### Worker VM Startup Script

Each worker VM receives a startup script that:

1. Installs Node.js 22 and tsx
2. Downloads the worker script from GCS
3. Configures environment variables (broker URL, SDK mode, etc.)
4. Runs the worker, writing results back to GCS

```bash
#!/bin/bash
# Injected via VM metadata at creation time

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Download worker package
gsutil cp gs://perf-matrix-{run-id}/worker-package.tar.gz /opt/worker/
cd /opt/worker && tar xzf worker-package.tar.gz && npm install

# Signal ready
echo "1" | gsutil cp - gs://perf-matrix-{run-id}/scenarios/{scenario-id}/ready/{worker-id}

# Wait for go signal
while ! gsutil -q stat gs://perf-matrix-{run-id}/scenarios/{scenario-id}/go 2>/dev/null; do
  sleep 0.1
done

# Run worker
cd /opt/worker && \
  SDK_MODE={sdk_mode} \
  HANDLER_TYPE={handler_type} \
  NUM_WORKERS={wpp} \
  BROKER_REST_URL=http://{broker_ip}:8080 \
  BROKER_GRPC_URL={broker_ip}:26500 \
  TARGET_PER_WORKER={target} \
  SCENARIO_TIMEOUT_S=300 \
  npx tsx worker.ts

# Upload results
gsutil cp /opt/worker/result.json \
  gs://perf-matrix-{run-id}/scenarios/{scenario-id}/results/{worker-id}.json
```

### Cost Estimate

For a full 120-scenario run with ~5 min per scenario:

| Resource | Quantity | Duration | Cost/hr | Total |
|----------|----------|----------|---------|-------|
| Orchestrator | 1× e2-standard-4 | 10 hrs | $0.134 | $1.34 |
| Broker VMs | 1-3× e2-standard-8 | 10 hrs | $0.268 | $2.68-$8.04 |
| Worker VMs | avg 10× e2-standard-2 | 5 min each | $0.067 | ~$6.70 |
| GCS | < 1 GB | — | — | < $0.01 |
| **Total** | | | | **~$11-17** |

Running scenarios in parallel (e.g., 4 at a time with different broker pools) could reduce
wall-clock time to ~2.5 hours at similar cost.

### Local Development Mode

For development and debugging, the system also supports a **local mode** that runs everything
on a single machine using Docker and child processes — identical to the existing matrix runner
but with the new composite (P × WPP) topology. This is useful for:

- Validating worker scripts before cloud deployment
- Running quick smoke tests
- Debugging individual scenarios

```bash
# Local mode (single machine, Docker broker)
npx tsx src/run-matrix.ts --local --total-workers 10 --wpp 2 5

# Cloud mode (GCP VMs)
npx tsx src/run-matrix.ts --project my-gcp-project --zone us-central1-a
```

## Worker Configuration

All SDK workers are configured identically to ensure a fair comparison. The key parameters
that affect throughput are handler latency, job activation batch size, and execution thread
pool sizing.

### Handler Latency

Every scenario runs with a **200ms simulated workload**, regardless of handler type:

| Handler Type | Simulation Method | Duration |
|---|---|---|
| `cpu` | Busy-loop (`Math.sin` / equivalent) burns CPU for the configured duration | 200ms |
| `http` | `Thread.sleep` / `setTimeout` / equivalent simulates async I/O wait | 200ms |

The latency is passed to workers via the `HANDLER_LATENCY_MS` environment variable (always `200`).
The constant `DEFAULT_HANDLER_LATENCY_MS` in `src/config.ts` is the single source of truth.

The difference between the two handler types is *how* the 200ms is spent:
- **CPU handlers** keep the execution thread busy (CPU-bound).
- **HTTP handlers** release the execution thread during the wait (I/O-bound), allowing the
  runtime to schedule other work on that thread.

### Job Activation & Execution Threads

Each worker process opens a single `JobWorker` that polls/streams jobs from the broker. The
key parameters controlling concurrency are:

| Parameter | Value | Description |
|---|---|---|
| `maxJobsActive` | `ACTIVATE_BATCH × NUM_WORKERS` (default: 32 × W/P) | Max jobs buffered locally before pausing activation |
| `pollInterval` | 100ms | How often the worker polls for new jobs (REST/gRPC-polling modes) |
| `timeout` | 30s | Job lock timeout — how long a job is reserved before the broker reclaims it |
| `streamEnabled` | `true` for gRPC-streaming, `false` otherwise | Whether to use the gRPC job push stream |

**Execution thread pool** — the number of threads that can run job handlers in parallel:

| Language | Configuration | Notes |
|---|---|---|
| TypeScript | Single-threaded (Node.js event loop) | Async I/O naturally multiplexes; CPU handlers block the event loop |
| Python | `NUM_WORKERS` threads via `ThreadPoolExecutor` | GIL limits true CPU parallelism but allows I/O concurrency |
| C# | `Task`-based async — thread pool sized by .NET runtime | Naturally concurrent for async handlers |
| Java | `.numJobWorkerExecutionThreads(NUM_WORKERS)` | Explicitly set to match the desired worker count. Defaults to 1 if not set, which serializes all handler execution |

The Java thread pool setting is critical: without it, a single execution thread processes
handlers sequentially. With 200ms handler latency this limits throughput to ~5 jobs/s regardless
of `NUM_WORKERS`. Setting it to `NUM_WORKERS` allows up to N handlers to execute in parallel.

### Job Completion

All workers complete jobs asynchronously (fire-and-forget with error callback) to avoid blocking
handler threads. The Java worker uses `.send().whenComplete(...)` rather than `.send().join()`.
Blocking completion was found to cause carrier-thread pinning and deadlock at high concurrency.


  // Configuration
  totalWorkers: number;
  workersPerProcess: number;
  processes: number;           // = totalWorkers / workersPerProcess
  sdkMode: string;
  handlerType: string;
  cluster: string;

  // Aggregate metrics
  totalCompleted: number;
  totalErrors: number;
  wallClockS: number;
  aggregateThroughput: number; // completions / wallClock
  jainFairness: number;        // across all individual workers

  // Per-process breakdown
  processResults: Array<{
    processId: string;
    vmName: string;
    workersInProcess: number;
    completed: number;
    errors: number;
    throughput: number;
    perWorkerThroughputs: number[];
  }>;

  // Server-side metrics
  serverMetrics: {
    receivedRequests: number;
    droppedRequests: number;
    jobActivationAvgMs: number;
    jobLifetimeAvgMs: number;
  };
}
```

## Analysis Outputs

The final report will include:

1. **Throughput vs Workers-per-Process curves** — for each (W, mode, handler, cluster)
   combination, showing where throughput peaks and drops off.

2. **Error rate vs Workers-per-Process** — showing the error cliff.

3. **Fairness vs Workers-per-Process** — showing when work distribution becomes uneven.

4. **Recommendations table** — "For W workers doing X-type work, use P processes with Y
   workers each."

5. **Cost-efficiency analysis** — throughput per VM, helping users optimize their cloud spend.
