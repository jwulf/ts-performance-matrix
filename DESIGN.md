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
| **SDK mode** | `rest`, `rest-threaded`, `grpc-streaming`, `grpc-poll` | Four competitive modes (not all languages support all modes) |
| **Handler type** | `cpu`, `http` | CPU-bound (20ms busy-loop) vs I/O-bound (20ms async wait) |
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
| 50 | 1 | 50 | Full isolation |
| 50 | 2 | 25 | |
| 50 | 5 | 10 | |
| 50 | 10 | 5 | |
| 50 | 25 | 2 | |
| 50 | 50 | 1 | Full sharing |
| 100 | 1 | 100 | Full isolation |
| 100 | 2 | 50 | |
| 100 | 5 | 20 | |
| 100 | 10 | 10 | |
| 100 | 25 | 4 | |
| 100 | 50 | 2 | |

That's **20 topology configurations** × 10 language-mode combos × 2 handlers × 2 clusters = **800 scenarios**.

### Key Questions This Answers

**Worker-to-Process Ratio:**
1. **At what WPP does throughput degrade?** Is the drop linear or cliff-like?
2. **At what WPP does fairness collapse?** Do workers within a process get starved?
3. **Does cluster size shift the crossover?** More broker capacity may tolerate more sharing.
4. **What's the cost of isolation?** Connection overhead and memory at 50 separate processes.
5. **What's the ideal process/worker split** for a given SDK and scenario?

**Transport & Execution Strategy:**
6. **How do REST, gRPC polling, and gRPC streaming compare** across the performance envelope?
7. **Does the crossover point differ by transport?** REST vs gRPC may have different sweet spots.
8. **Does offloading CPU work to threads help?** (TS `worker_threads`, Python `ThreadPoolExecutor`)
9. **What is the recommended transport/execution strategy** for an SDK given workload characteristics (I/O-bound vs CPU-bound)?

**Cross-SDK Comparison:**
10. **How do the SDKs perform against each other** (TS, Python, C#, Java) on the same workload?
11. **Does client-side adaptive backpressure management make a measurable difference** to throughput, and in what scenarios?
12. **Which SDK/transport combinations are production-viable** at scale, and which have stability issues (error rates, timeouts)?

## SDK Characteristics

The matrix tests four Camunda 8 client SDKs across two distinct SDK packages for TypeScript. Each has a distinct runtime model, transport options, and execution strategy for job handlers. Understanding these differences is essential for interpreting the results.

### Overview

| SDK | Package | Language | Runtime | Transports | Execution Model |
|-----|---------|----------|---------|------------|-----------------|
| **TS REST** | `@camunda8/orchestration-cluster-api` | Node.js 22 | Single-threaded event loop | REST | Async handlers on event loop; `rest-threaded` offloads CPU to `worker_threads` |
| **TS gRPC** | `@camunda8/sdk` | Node.js 22 | Single-threaded event loop | gRPC (streaming & polling) | Async handlers on event loop |
| **Python** | `camunda-orchestration-sdk` | CPython 3.12 | GIL-constrained threads | REST | `rest`: async handlers via `httpx`; `rest-threaded`: `ThreadPoolExecutor` for CPU work |
| **C#** | `Camunda.Orchestration.Sdk` | .NET 9 | Task-based async (thread pool) | REST | Async `Task` handlers; runtime manages thread pool automatically |
| **Java** | `io.camunda:camunda-client-java` | JDK 21 | Thread-per-handler pool | REST, gRPC (streaming & polling) | Fixed execution thread pool; handlers run on SDK-managed threads |

### Transport Modes

| Mode | Protocol | Job Delivery | SDK Package | Available In |
|------|----------|-------------|-------------|-------------|
| `rest` | HTTP/1.1 | Long-polling — worker polls broker at 100ms intervals | `@camunda8/orchestration-cluster-api` (TS), respective SDK (others) | All SDKs |
| `rest-threaded` | HTTP/1.1 | Same as `rest`, but CPU handler work is offloaded to a thread | `@camunda8/orchestration-cluster-api` (TS), `camunda-orchestration-sdk` (Python) | TS, Python |
| `grpc-streaming` | gRPC/HTTP2 | Broker pushes jobs to the client over a persistent stream | `@camunda8/sdk` (TS), `camunda-client-java` (Java) | TS, Java |
| `grpc-polling` | gRPC/HTTP2 | Worker polls broker via gRPC `ActivateJobs` RPC | `@camunda8/sdk` (TS), `camunda-client-java` (Java) | TS, Java |

### TypeScript — REST modes (`@camunda8/orchestration-cluster-api`)

- **Event loop**: All job handler callbacks run on the single Node.js event loop. I/O-bound handlers (`await fetch(...)`) yield the loop and allow other handlers to execute concurrently. CPU-bound handlers (`Math.sin` busy-loop) **block the event loop**, preventing all other handlers from executing until completion.
- **`rest-threaded` mode**: Offloads each CPU handler invocation to a `worker_threads` `Worker`, keeping the event loop free for job polling and I/O. Returns results via `postMessage`. This eliminates the event-loop-blocking penalty for CPU-bound workloads.
- **Backpressure**: The SDK's `BackpressureManager` adapts concurrency based on broker responses (429s, rate headers).
- **Job completion**: Fire-and-forget async — `job.complete()` returns a Promise that is not awaited in the handler.
- **Concurrency control**: `maxParallelJobs = ACTIVATE_BATCH × NUM_WORKERS` (default: 32 × WPP). This is both the job activation limit *and* the concurrent handler limit — the SDK invokes up to this many handler callbacks simultaneously. On the event loop, I/O handlers run truly concurrently (many `await`s in flight); CPU handlers serialize regardless.

### TypeScript — gRPC modes (`@camunda8/sdk`)

- **Different SDK**: gRPC modes use `@camunda8/sdk` (the Zeebe gRPC client), which is a separate package from the REST SDK. It uses `getZeebeGrpcApiClient()` and has different API conventions (`taskType`/`taskHandler` vs `jobType`/`jobHandler`).
- **Streaming**: `zeebe.streamJobs()` opens a persistent gRPC stream; the broker pushes jobs to the client. Uses `pollMaxJobsToActivate` for flow control.
- **Polling**: `zeebe.createWorker()` polls via gRPC `ActivateJobs` RPC at the configured interval.
- **Same event loop constraints**: CPU handlers block the event loop identically to REST mode. There is no `grpc-threaded` variant.
- **No backpressure management**: The `@camunda8/sdk` gRPC client does not implement adaptive backpressure.

### Python (`camunda-orchestration-sdk`)

- **GIL**: The Global Interpreter Lock means only one thread runs Python bytecode at a time. CPU-bound handlers cannot achieve true parallelism even with threads. However, I/O-bound handlers release the GIL during `await`, allowing effective concurrency.
- **`rest` mode**: Uses `httpx` async client. Handlers run as `async` coroutines on the asyncio event loop.
- **`rest-threaded` mode**: Uses `ThreadPoolExecutor` (via `execution_strategy="thread"`) to offload handler execution. For CPU-bound work this provides limited benefit (GIL), but allows the main event loop to remain responsive for job activation and completion. For I/O-bound work, threads add overhead without benefit since `httpx` async is already non-blocking.
- **No gRPC**: The Python SDK currently supports REST only.
- **Concurrency control**: `max_concurrent_jobs = ACTIVATE_BATCH × NUM_WORKERS` (default: 32 × WPP). Acts as both the activation and handler concurrency limit.

### C\# (`Camunda.Orchestration.Sdk`)

- **Task-based**: Handlers run as `async Task` methods on the .NET thread pool. The runtime automatically scales the thread pool based on demand.
- **Natural concurrency**: Both CPU and I/O handlers are async. The .NET thread pool efficiently handles both patterns — I/O handlers yield threads during `await`, CPU handlers get dedicated thread pool threads.
- **REST only**: The C# SDK supports REST transport only.
- **Backpressure**: Implements the same `BackpressureManager` pattern as the TS REST SDK.
- **Concurrency control**: `MaxConcurrentJobs = ACTIVATE_BATCH × NUM_WORKERS` (default: 32 × WPP). All concurrent handlers run on the .NET thread pool, which dynamically scales to accommodate them.

### Java (`io.camunda:camunda-client-java`)

- **Thread pool**: The SDK uses a configurable execution thread pool (`numJobWorkerExecutionThreads`). Each handler runs on a dedicated thread from this pool. **This must be set explicitly** — the default is 1 thread, which serializes all handler execution (limiting throughput to ~50 jobs/s with 20ms handlers).
- **gRPC native**: Java is the original gRPC SDK. Streaming mode uses the broker's job push stream; polling mode uses the `ActivateJobs` RPC.
- **REST support**: Added more recently, uses the same HTTP client internally.
- **Completion model**: `newCompleteCommand(job).send()` returns a `CompletableFuture`. Blocking with `.join()` in the handler causes carrier-thread pinning and deadlock at high concurrency, so the benchmark uses `.whenComplete()` (fire-and-forget with error callback).
- **Error aggregation**: Failed completions are counted per error type (root cause class + message), enabling diagnosis of systematic failures (e.g., `RESOURCE_EXHAUSTED`, `DEADLINE_EXCEEDED`).
- **Concurrency control**: Java has a **two-level pipeline** unlike the other SDKs: `maxJobsActive = ACTIVATE_BATCH × NUM_WORKERS` (32 × WPP) controls how many jobs are fetched from the broker, while `numJobWorkerExecutionThreads = min(ACTIVATE_BATCH × NUM_WORKERS, availableProcessors × 100)` controls how many handlers can execute in parallel. A CPU-based hard cap prevents OS thread explosion at high WPP on small VMs.

### Concurrent Handler Execution — A Key Asymmetry

The SDKs differ significantly in how many job handlers can execute concurrently. This is the
single most important variable affecting throughput comparisons:

| SDK | Max concurrent handlers | How it's configured | At WPP=10 |
|-----|------------------------|--------------------:|----------:|
| **Java** | min(32 × WPP, CPUs × 100) | `numJobWorkerExecutionThreads(Math.min(ACTIVATE_BATCH × NUM_WORKERS, availableProcessors × 100))` | **200** (on 2 vCPU) |
| **C#** | 32 × WPP | `MaxConcurrentJobs = ACTIVATE_BATCH × NUM_WORKERS` | **320** |
| **TS REST** | 32 × WPP | `maxParallelJobs = ACTIVATE_BATCH × NUM_WORKERS` | **320** (event loop limits CPU to 1) |
| **Python** | 32 × WPP | `max_concurrent_jobs = ACTIVATE_BATCH × NUM_WORKERS` | **320** (GIL limits CPU to 1) |

**Why `ACTIVATE_BATCH × NUM_WORKERS`**: All SDKs now use the same formula — one execution slot
per activated job. Java's execution thread pool is set to match its activation buffer so that
I/O-bound handlers (e.g. 20ms HTTP calls) run concurrently at full capacity rather than
queuing behind a smaller thread pool.

**Java thread cap**: Unlike the other SDKs (which use async tasks, event loops, or green threads),
Java's `numJobWorkerExecutionThreads` creates real OS threads — each consuming ~1MB stack memory.
At WPP=50, uncapped `ACTIVATE_BATCH × NUM_WORKERS` = 1,600 threads on a 2-vCPU VM (3.2GB in
stacks alone). The cap of `availableProcessors() × 100` limits this to 200 threads on 2-vCPU
VMs, which is ample for I/O-bound handlers while preventing OOM/scheduler thrashing.

> **Future dimension**: We plan to sweep the concurrent-handler / activation-batch dimension
> separately in a later run to quantify the throughput impact of different concurrency caps
> (e.g. WPP, 2×WPP, 16×WPP, 32×WPP) across SDKs and handler types.

**Impact on I/O-bound (HTTP) handlers** (WPP=10, 20ms `sleep`/`await`):
- All SDKs: 320 concurrent I/O waits × 50 completions/s = **16,000 jobs/s max**
- TS: limited by event loop if CPU-bound work is mixed in

**Impact on CPU-bound handlers** (WPP=10, 20ms busy-loop, 2 vCPU VM):
- All SDKs: bottlenecked by 2 real cores → **~100 jobs/s** regardless of concurrency cap
- TS (non-threaded): 1 event loop thread → **~50 jobs/s**

The asymmetry primarily affects **CPU-bound workloads**, where the TS event loop serialises
handlers while other SDKs parallelise across cores. For I/O-bound workloads all SDKs now
have the same concurrency ceiling.

A follow-up concurrency sweep (see note above) will quantify the effect of varying this cap.

### Other Asymmetries

| Asymmetry | Impact |
|-----------|--------|
| **Two TS SDKs** | REST modes use `@camunda8/orchestration-cluster-api`; gRPC modes use `@camunda8/sdk`. These are different packages with different internals, not just different transport options on the same client. |
| **TS event loop vs Java thread pool** | CPU handlers block the TS event loop (1 handler at a time) but Java runs WPP in parallel. The `rest-threaded` mode closes this gap. |
| **Python GIL** | CPU-bound threads don't help Python. I/O-bound async is efficient. Threading adds overhead for I/O workloads. |
| **gRPC availability** | Only TS and Java support gRPC, so gRPC scenarios produce no data for Python and C#. |
| **Backpressure management** | TS REST and C# have client-side adaptive backpressure. Java, TS gRPC, and Python do not. This may affect error rates under high load. |
| **Completion semantics** | All SDKs fire-and-forget completions. All capture error types (root cause class + message) for post-hoc diagnosis. |

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
   - Create 100,000 process instances as an initial buffer
   - Concurrency-limited (50 inflight) for rate control

4. PROVISION WORKER VMS
   - Create P = W/WPP worker VMs
   - Leader VM (worker-0) also runs the continuous producer as a background process
   - Each VM startup script:
     a. Install language runtime (Node.js, Python, .NET, JDK)
     b. Download worker package from GCS
     c. Set environment: SDK_MODE, HANDLER_TYPE, NUM_WORKERS=WPP, BROKER_URL
     d. Write "ready" flag to GCS
   - Wait for all P VMs to report ready

5. START BENCHMARK
   - Write "go" flag to GCS
   - All worker VMs begin simultaneously (barrier protocol via GCS)
   - Leader VM signals continuous producer to start creating new instances
   - Server resource usage (CPU, memory, threads) is sampled via Prometheus
     gauges every 30 seconds during execution

6. COLLECT RESULTS
   - Each worker VM writes result JSON to GCS on completion
   - Leader VM stops the continuous producer and uploads producer stats
   - Orchestrator polls for P result files (or timeout)
   - Orchestrator reads continuous producer stats from a separate GCS path

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
        process-0.json        # Written by each worker VM on completion
        process-1.json
        ...
        scenario-summary.json # Aggregated result written by orchestrator
      producer-stats.json     # Continuous producer stats (separate from results/)
      precreate-stats.json    # Pre-creation stats (leader VM only)
      broker-metrics-before.json
      broker-metrics-after.json
```

### Worker VM Startup Script

Each worker VM receives a startup script that:

1. Installs the appropriate language runtime (Node.js, Python, .NET, or JDK)
2. Downloads the worker package from GCS
3. Configures environment variables (broker URL, SDK mode, etc.)
4. **Leader only (worker-0):** Launches the producer as a background process, waits for pre-creation
   to complete, then starts the worker. After the worker finishes, signals the producer to stop and
   uploads producer stats to GCS.
5. Runs the worker, writing results back to GCS

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

Each scenario takes ~45 minutes end-to-end, dominated by provisioning and pre-creation:

| Phase | Duration | Notes |
|-------|----------|-------|
| Broker provisioning | ~5 min | Skipped when retained from previous scenario |
| Pre-create 150K instances | ~10-15 min | At concurrency 200 |
| Worker VM provisioning | ~5-10 min | Create VMs, boot, install runtime, download package |
| Benchmark execution | ≤5 min | 300s timeout |
| Result collection + teardown | ~2-5 min | Upload results, delete worker VMs |

With 8 lanes running in parallel, observed throughput is ~1.3 scenarios/lane/hour
(128 scenarios in 12 hours). Extrapolating to a full 800-scenario run:

- **Wall-clock time**: ~75 hours (100 scenarios/lane × 45 min)
- **8 lanes** running in parallel, each with its own broker pool and worker VMs

| Resource | Quantity | Duration | Cost/hr | Total |
|----------|----------|----------|---------|-------|
| Orchestrator | 1× e2-standard-4 | 75 hrs | $0.134 | $10 |
| Broker VMs | 8 pools × avg 2× e2-standard-8 | 75 hrs | $0.268 | ~$322 |
| Worker VMs | avg ~17× e2-standard-2 per scenario | ~45 min each | $0.067 | ~$670 |
| GCS | < 1 GB | — | — | < $0.01 |
| **Total** | | | | **~$1,000** |

The dominant cost is worker VMs — high-process-count scenarios (W=100, WPP=1 → 100 VMs)
are disproportionately expensive. Reducing `MAX_TOTAL_WORKERS` or capping process count
would significantly lower costs.

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

Every scenario runs with a **20ms simulated workload**, regardless of handler type:

| Handler Type | Simulation Method | Duration |
|---|---|---|
| `cpu` | Busy-loop (`Math.sin` / equivalent) burns CPU for the configured duration | 20ms |
| `http` | `Thread.sleep` / `setTimeout` / equivalent simulates async I/O wait | 20ms |

The latency is passed to workers via the `HANDLER_LATENCY_MS` environment variable (always `20`).
The constant `DEFAULT_HANDLER_LATENCY_MS` in `src/config.ts` is the single source of truth.

The difference between the two handler types is *how* the 20ms is spent:
- **CPU handlers** keep the execution thread busy (CPU-bound).
- **HTTP handlers** release the execution thread during the wait (I/O-bound), allowing the
  runtime to schedule other work on that thread.

### Job Activation & Execution Threads

Each worker process opens a single `JobWorker` that polls/streams jobs from the broker. The
key parameters controlling concurrency are:

| Parameter | Value | Description |
|---|---|---|
| `maxJobsActive` | `ACTIVATE_BATCH × NUM_WORKERS` (default: 32 × W/P) | Max jobs buffered locally before pausing activation |
| `pollIntervalMs` | 100ms | How often the worker polls for new jobs (REST/gRPC-polling modes) |
| `timeout` | 30s | Job lock timeout — how long a job is reserved before the broker reclaims it |
| `streamEnabled` | `true` for gRPC-streaming, `false` otherwise | Whether to use the gRPC job push stream |

**Execution thread pool** — the number of threads that can run job handlers in parallel:

| Language | Configuration | Notes |
|---|---|---|
| TypeScript | Single-threaded (Node.js event loop) | Async I/O naturally multiplexes; CPU handlers block the event loop |
| Python | `NUM_WORKERS` threads via `ThreadPoolExecutor` | GIL limits true CPU parallelism but allows I/O concurrency |
| C# | `Task`-based async — thread pool sized by .NET runtime | Naturally concurrent for async handlers |
| Java | `.numJobWorkerExecutionThreads(min(ACTIVATE_BATCH × NUM_WORKERS, CPUs × 100))` | Capped to avoid OS thread explosion on small VMs. On 2-vCPU: max 200 threads |

The Java thread pool setting is critical: without it, a single execution thread processes
handlers sequentially. With 20ms handler latency this limits throughput to ~50 jobs/s regardless
of `NUM_WORKERS`. Setting it to `ACTIVATE_BATCH × NUM_WORKERS` (with a CPU-based cap) allows
I/O-bound handlers to run at full concurrency while preventing thread explosion at high WPP.

### Job Completion

All workers complete jobs asynchronously (fire-and-forget with error callback) to avoid blocking
handler threads. The Java worker uses `.send().whenComplete(...)` rather than `.send().join()`.
Blocking completion was found to cause carrier-thread pinning and deadlock at high concurrency.

### Error Counting

Every worker tracks two error metrics:

1. **Error count** (all SDKs): Each failed job completion increments a per-worker error counter.
   The result JSON includes `totalErrors`, `perWorkerErrors[]`, and evenly distributed errors
   indicate a systematic problem (e.g., inter-broker routing) rather than a single bad worker.

2. **Error type aggregation** (all SDKs): Every worker buckets errors by their
   root cause class and message. When a job handler or completion fails, an `errorKey()` function
   walks the exception/cause chain to the root cause and builds a key of
   `ClassName: message` (message truncated to 120 characters). A concurrent map accumulates
   counts per distinct error key. The result JSON includes an `errorTypes` map sorted by count
   descending:

   ```json
   {
     "errorTypes": {
       "StatusRuntimeException: RESOURCE_EXHAUSTED: ...": 2100,
       "TimeoutException: deadline exceeded": 500
     }
   }
   ```

   This enables diagnosis of *what* is failing without per-invocation logging — critical for
   understanding error patterns where streaming may show high error rates.

   The top 5 error types are also logged to stdout at the end of the benchmark.

### Continuous Producer (Two-Phase Protocol)

Early benchmarks revealed a **producer starvation problem**: with a fixed pre-created pool of
50,000 instances and 100 workers each completing ~10,000 jobs, fast scenarios would drain the
entire pool. Observed throughput would plateau at ~164/s — not a broker limit, but simply
50,000 / ~305s ≈ 164/s.

To eliminate this artifact, the system uses a **two-phase producer protocol**:

1. **Phase 1 — Pre-create buffer:** Before workers start, create 100,000 process instances as an
   initial buffer. This ensures workers have jobs available immediately at startup.

2. **Phase 2 — Continuous production:** Once the GO signal fires, a background producer
   continuously creates new instances (concurrency 50) until the workers finish and a STOP signal
   is written.

The protocol uses file-based coordination (GCS files on GCP, local filesystem in local mode):

| Signal | Written by | Purpose |
|--------|-----------|---------|
| `READY_FILE` | Producer | Pre-creation complete, buffer is ready |
| `GO_FILE` | Orchestrator | Workers have started, begin continuous creation |
| `STOP_FILE` | Worker process | Workers finished, stop producing |
| `PRODUCER_STATS_FILE` | Producer | Final stats: `{created, errors, durationS, rate}` |

All four SDK producers (TypeScript, Java, Python, C#) implement this protocol identically.
On GCP, the producer runs as a background process on the leader VM (worker-0). In local mode,
it runs as an in-process async loop.

Producer stats are stored at a **separate GCS path** (`producer-stats.json`) rather than inside
`results/` to avoid contaminating the `gcsWaitForFiles` file count used for worker result polling.

### Server Resource Monitoring

During each scenario, the orchestrator samples JVM gauges from the broker's Prometheus endpoint
every 30 seconds. The sampled metrics are:

| Metric | Description |
|--------|-------------|
| `process_cpu_usage` | Process CPU usage (0.0–1.0) |
| `system_cpu_usage` | System CPU usage (0.0–1.0) |
| `jvm_memory_used_bytes` | JVM heap + non-heap memory (summed, reported in MB) |
| `jvm_threads_live_threads` | Live JVM threads (summed across brokers) |

Results include both **average** and **peak** values across all samples, enabling identification
of CPU saturation, memory pressure, or thread exhaustion during high-concurrency scenarios.


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
    deferredAppends: number;
    jobsPushed: number;
    jobsPushFailed: number;
    recordsProcessed: number;
    backpressureLimit: number;
    backpressureInflight: number;
    jobActivationAvgMs: number | null;
    jobLifetimeAvgMs: number | null;
    piExecutionAvgMs: number | null;
  };

  // Server resource usage (gauge sampling during execution)
  serverResourceUsage: {
    samples: number;
    cpuAvg: number;            // process_cpu_usage avg (0.0–1.0)
    cpuPeak: number;
    systemCpuAvg: number;      // system_cpu_usage avg (0.0–1.0)
    systemCpuPeak: number;
    memoryUsedAvgMb: number;   // jvm_memory_used_bytes total (MB)
    memoryUsedPeakMb: number;
    liveThreadsAvg: number;    // jvm_threads_live_threads total
    liveThreadsPeak: number;
  } | null;

  // Continuous producer stats (null if not enabled)
  continuousProducer: {
    created: number;
    errors: number;
    durationS: number;
    rate: number;
  } | null;
}
```

## Analysis Outputs

### Post-Run Data Retrieval

Each scenario produces two levels of result data in GCS:

**Per-process files** (`results/process-{N}.json`) — written by individual worker VMs:

| Field | Type | Description |
|-------|------|-------------|
| `processId` | string | e.g. `process-0` |
| `sdkMode` | string | `rest`, `rest-threaded`, `grpc-streaming`, `grpc-polling` |
| `handlerType` | string | `cpu` or `http` |
| `workersInProcess` | number | Number of workers in this process |
| `totalCompleted` | number | Jobs completed by this process |
| `totalErrors` | number | Errors in this process |
| `wallClockS` | number | Wall-clock duration (seconds) |
| `throughput` | number | Per-process throughput (jobs/s) |
| `perWorkerCompleted` | number[] | Completions per worker |
| `perWorkerErrors` | number[] | Errors per worker |
| `perWorkerThroughputs` | number[] | Throughput per worker |
| `errorTypes` | object | Map of error key → count, sorted by count descending. Key format: `RootCauseClass: message` (truncated to 120 chars) |
| `memoryUsage` | object | Client memory stats: `{ peakRssMb, avgRssMb, samples }` (TS/Python/C# use RSS; Java uses `peakHeapMb`/`avgHeapMb`) |

**Scenario summary** (`results/scenario-summary.json`) — written by the orchestrator after
collecting all per-process results. This is the primary file for analysis:

| Field | Type | Description |
|-------|------|-------------|
| `scenarioId` | string | Unique scenario identifier |
| `totalWorkers` | number | Total workers across all processes |
| `workersPerProcess` | number | Workers per process |
| `processes` | number | Number of OS processes |
| `sdkLanguage` | string | `ts`, `python`, `csharp`, `java` |
| `sdkMode` | string | Transport mode |
| `handlerType` | string | `cpu` or `http` |
| `cluster` | string | `1broker` or `3broker` |
| `totalCompleted` | number | Total jobs completed across all processes |
| `totalErrors` | number | Total errors across all processes |
| `wallClockS` | number | Wall-clock duration |
| `aggregateThroughput` | number | `totalCompleted / wallClockS` (jobs/s) |
| `jainFairness` | number | Jain's fairness index across all individual workers (0–1) |
| `processResults` | array | Per-process breakdown (same shape as per-process files) |
| `serverMetrics` | object/null | Prometheus counter deltas (GCP only) |
| `serverResourceUsage` | object/null | JVM gauge aggregates (GCP only) |
| `status` | string | `ok`, `timeout`, or `error` |
| `preCreate` | object | Pre-creation stats |
| `continuousProducer` | object/null | Continuous producer stats |

To download all scenario summaries for a run:

```bash
# List available summaries
gsutil ls gs://camunda-perf-matrix/run-{ID}-l*/scenarios/*/results/scenario-summary.json | wc -l

# Download all summaries to a local directory
mkdir -p /tmp/run-{ID}
gsutil -m cp gs://camunda-perf-matrix/run-{ID}-l*/scenarios/*/results/scenario-summary.json /tmp/run-{ID}/
```

Note: Multi-lane runs use `run-{ID}-l{N}` as the GCS prefix (one per lane). The summary
files are self-contained — each includes the full `scenarioId` so files from different
lanes can be collected into a flat directory without conflicts.

### Planned Report Outputs

The final report will include:

1. **Throughput vs Workers-per-Process curves** — for each (W, mode, handler, cluster)
   combination, showing where throughput peaks and drops off.

2. **Error rate vs Workers-per-Process** — showing the error cliff.

3. **Fairness vs Workers-per-Process** — showing when work distribution becomes uneven.

4. **Recommendations table** — "For W workers doing X-type work, use P processes with Y
   workers each."

5. **Cost-efficiency analysis** — throughput per VM, helping users optimize their cloud spend.
