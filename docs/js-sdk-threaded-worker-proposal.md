# Proposal: Thread Pool Execution Strategy for JS SDK Job Worker

## Problem

The performance matrix shows that Node.js job workers with CPU-bound handlers suffer a **3.78x throughput penalty** compared to I/O-bound (HTTP) handlers. This is because `cpuWork()` blocks the event loop, starving the polling loop and preventing concurrent job processing.

Other SDKs don't have this problem to the same degree (C# 1.29x, Java 1.22x, Python 0.99x) because they have real threads or a GIL-releasing thread pool.

## Evidence

From run-08205 (performance matrix):

| Language | HTTP handler (jobs/s) | CPU handler (jobs/s) | Ratio |
|----------|----------------------|---------------------|-------|
| TS       | 421.6 (peak)         | 111.5 (peak)        | 3.78x |
| C#       | 224.7                | 174.5               | 1.29x |
| Java     | 153.1                | 125.5               | 1.22x |
| Python   | 228.5                | 143.6               | 0.99x (threaded: 203.9) |

The `rest-threaded` mode in the perf matrix (using `worker_threads`) closes this gap for TS by offloading CPU work to threads while keeping the event loop free for polling.

## Python SDK Already Has This

The Python SDK supports `execution_strategy="thread"` on its job worker, which runs the handler in a `ThreadPoolExecutor`. This frees the async event loop for polling while CPU work runs in threads.

## Options for the JS SDK

### Option 1: Module-path handler with thread pool (Piscina)

Use [Piscina](https://github.com/piscinajs/piscina) (or similar) to run handlers in a `worker_threads` pool.

```ts
// Current API (unchanged, runs on main thread)
client.createJobWorker({
  jobType: 'my-task',
  jobHandler: async (job) => { /* runs on event loop */ },
  maxParallelJobs: 32,
})

// New: thread-pool execution
client.createJobWorker({
  jobType: 'cpu-heavy-task',
  handlerModule: './my-handler.js',  // must export a default function
  executionStrategy: 'thread-pool',
  maxParallelJobs: 32,
})
```

**Pros**: Matches Python SDK's `execution_strategy` pattern. Clean separation. Thread pool is managed by the SDK.

**Cons**: DX change — handler must be a separate module file (functions aren't serializable across `worker_threads`). Users must export a specific function shape. Adds a dependency (Piscina or custom pool).

### Option 2: SDK utility for offloading CPU work

Export a helper that users wrap their CPU-bound work in, keeping the existing handler API unchanged:

```ts
import { runInThread } from '@camunda8/sdk'

client.createJobWorker({
  jobType: 'cpu-heavy-task',
  jobHandler: async (job) => {
    const result = await runInThread('./cpu-work.js', job.variables)
    return job.complete({ result })
  },
  maxParallelJobs: 32,
})
```

**Pros**: No DX change to the worker API. Opt-in per call. Lower scope.

**Cons**: User still has to know about threading. Doesn't "just work" like Python's `execution_strategy`.

### Option 3: Process-level isolation (cluster mode)

Use `child_process.fork()` or Node.js cluster module to run multiple event loops.

**Pros**: No serialization constraints — each process gets its own event loop and can use inline handlers. Closest to "it just works".

**Cons**: Heavier resource usage. Each process has its own V8 heap. More complex lifecycle management. Harder to coordinate shared state (auth tokens, backpressure).

## Recommendation

**Option 1** is the best fit for parity with the Python SDK. The DX change is real but can be made backward-compatible: inline function = main-thread (default), module path = thread pool. This mirrors what production Node.js applications already do for CPU-bound work.

The key question is whether CPU-bound job handlers are common enough among Camunda users to justify the added complexity. Most Node.js job handlers are I/O-bound (API calls, DB queries), where the single-threaded event loop excels. But for users who do have CPU-heavy handlers (data transformation, validation, PDF generation, ML inference), the current SDK gives them no escape hatch — they have to implement `worker_threads` themselves.

## Real-world patterns where this matters

- PDF/document generation from process variables
- Data transformation / ETL steps
- Schema validation of large payloads
- Image processing
- Cryptographic operations
- Any handler that does significant computation before calling an external service
