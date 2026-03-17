/**
 * Worker Process Script — runs inside each worker VM (cloud) or child process (local).
 *
 * This script creates WPP (workers per process) job workers that share a single
 * SDK client and BackpressureManager instance. Each worker runs a completion loop
 * targeting TARGET_PER_WORKER completions.
 *
 * Environment variables:
 *   WORKER_PROCESS_ID     — unique process identifier (e.g., "process-0")
 *   SDK_MODE              — rest | rest-threaded | grpc-streaming | grpc-polling
 *   HANDLER_TYPE          — cpu | http
 *   HANDLER_LATENCY_MS    — handler simulation latency (default: 0 for cpu, 200 for http)
 *   NUM_WORKERS           — number of workers in this process (WPP)
 *   TARGET_PER_WORKER     — completions target per worker (default: 10000)
 *   ACTIVATE_BATCH        — maxJobsToActivate per poll (default: 32)
 *   PAYLOAD_SIZE_KB       — variable payload size (default: 10)
 *   SCENARIO_TIMEOUT_S    — hard timeout (default: 300)
 *   BROKER_REST_URL       — broker REST URL (default: http://localhost:8080)
 *   BROKER_GRPC_URL       — broker gRPC URL (default: localhost:26500)
 *   RESULT_FILE           — path to write result JSON (default: ./result.json)
 *   READY_FILE            — path to write ready sentinel (optional, for barrier protocol)
 *   GO_FILE               — path to poll for go signal (optional, for barrier protocol)
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

// ─── Config ──────────────────────────────────────────────

const PROCESS_ID = process.env.WORKER_PROCESS_ID || 'process-0';
const SDK_MODE = (process.env.SDK_MODE || 'rest') as 'rest' | 'rest-threaded' | 'grpc-streaming' | 'grpc-polling';
const HANDLER_TYPE = (process.env.HANDLER_TYPE || 'cpu') as 'cpu' | 'http';
const HANDLER_LATENCY_MS = parseInt(process.env.HANDLER_LATENCY_MS || '200', 10);
const NUM_WORKERS = parseInt(process.env.NUM_WORKERS || '1', 10);
const TARGET_PER_WORKER = parseInt(process.env.TARGET_PER_WORKER || '10000', 10);
const ACTIVATE_BATCH = parseInt(process.env.ACTIVATE_BATCH || '32', 10);
const PAYLOAD_SIZE_KB = parseInt(process.env.PAYLOAD_SIZE_KB || '10', 10);
const SCENARIO_TIMEOUT_S = parseInt(process.env.SCENARIO_TIMEOUT_S || '300', 10);
const BROKER_REST_URL = process.env.BROKER_REST_URL || 'http://localhost:8080';
const BROKER_GRPC_URL = process.env.BROKER_GRPC_URL || 'localhost:26500';
const RESULT_FILE = process.env.RESULT_FILE || './result.json';
const READY_FILE = process.env.READY_FILE || '';
const GO_FILE = process.env.GO_FILE || '';

// Aggregator URL for centralized pool exhaustion detection
const AGGREGATOR_URL = process.env.AGGREGATOR_URL || '';

// ─── Per-worker metrics ──────────────────────────────────

interface WorkerMetrics {
  workerId: string;
  completed: number;
  errors: number;
}

// ─── Error type aggregation ──────────────────────────────

const errorTypes: Record<string, number> = {};

function errorKey(err: unknown): string {
  if (err instanceof Error) {
    const name = err.constructor.name || 'Error';
    let msg = err.message || '';
    if (msg.length > 120) msg = msg.slice(0, 120);
    return msg ? `${name}: ${msg}` : name;
  }
  const s = String(err);
  return s.length > 120 ? s.slice(0, 120) : s;
}

function recordError(workerMetrics: WorkerMetrics[], err: unknown) {
  const minWorker = workerMetrics.reduce((a, b) =>
    a.errors < b.errors ? a : b
  );
  minWorker.errors++;
  const key = errorKey(err);
  errorTypes[key] = (errorTypes[key] || 0) + 1;
}

// ─── Aggregator heartbeat (centralized pool exhaustion) ──

type StopReason = 'target' | 'pool-exhaustion' | 'timeout';

function createAggregatorChecker(): { check: (totalCompleted: number) => void; isStopped: () => boolean } {
  let stopped = false;
  let lastHB = 0;
  return {
    check(totalCompleted: number) {
      if (!AGGREGATOR_URL) return;
      const now = Date.now();
      if (now - lastHB < 2000) return;
      lastHB = now;
      fetch(`${AGGREGATOR_URL}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processId: PROCESS_ID, completed: totalCompleted }),
        signal: AbortSignal.timeout(1000),
      })
        .then(r => r.json())
        .then(d => { if (d.stop) stopped = true; })
        .catch(() => {});
    },
    isStopped: () => stopped,
  };
}

// ─── HTTP sim server ─────────────────────────────────────

let httpSimServer: http.Server | undefined;
function startHttpSimServer(latencyMs: number): Promise<number> {
  return new Promise((resolve) => {
    httpSimServer = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      }, latencyMs);
    });
    httpSimServer.listen(0, '127.0.0.1', () => {
      const addr = httpSimServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

// ─── CPU work simulation ─────────────────────────────────

function cpuWork(durationMs: number) {
  if (durationMs <= 0) return;
  const end = Date.now() + durationMs;
  let x = 0;
  while (Date.now() < end) {
    x += Math.sin(x + 1);
  }
}

// ─── CPU work on worker_threads pool ─────────────────

// Worker thread entry point: when this file is loaded as a worker thread,
// it listens for { durationMs } messages, runs cpuWork, and posts 'done' back.
// The thread stays alive for reuse — no per-job startup cost.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (msg: { durationMs: number }) => {
    cpuWork(msg.durationMs);
    port.postMessage('done');
  });
}

// Fixed-size thread pool for CPU-bound work. Threads are created lazily and
// reused across handler invocations. Pool size is capped at the number of CPU
// cores (the VM has 2 vCPUs, so more threads just context-switch without benefit).

const THREAD_POOL_SIZE = os.cpus().length;

interface PooledWorker {
  worker: Worker;
  busy: boolean;
}

const threadPool: PooledWorker[] = [];
const waitQueue: Array<{ durationMs: number; resolve: () => void; reject: (err: Error) => void }> = [];

function getOrCreatePoolWorker(): PooledWorker | null {
  // Find an idle worker
  const idle = threadPool.find(pw => !pw.busy);
  if (idle) return idle;

  // Create a new worker if pool isn't full
  if (threadPool.length < THREAD_POOL_SIZE) {
    const w = new Worker(__filename, { workerData: {} });
    const pw: PooledWorker = { worker: w, busy: false };
    threadPool.push(pw);
    return pw;
  }

  // Pool exhausted — caller must queue
  return null;
}

function cpuWorkThreaded(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const pw = getOrCreatePoolWorker();
    if (!pw) {
      // Queue until a thread becomes available
      waitQueue.push({ durationMs, resolve, reject });
      return;
    }

    dispatchToWorker(pw, durationMs, resolve, reject);
  });
}

function dispatchToWorker(
  pw: PooledWorker,
  durationMs: number,
  resolve: () => void,
  reject: (err: Error) => void,
) {
  pw.busy = true;

  const onMessage = () => {
    cleanup();
    pw.busy = false;
    resolve();
    drainQueue();
  };

  const onError = (err: Error) => {
    cleanup();
    // Replace dead worker
    const idx = threadPool.indexOf(pw);
    if (idx !== -1) threadPool.splice(idx, 1);
    reject(err);
    drainQueue();
  };

  function cleanup() {
    pw.worker.off('message', onMessage);
    pw.worker.off('error', onError);
  }

  pw.worker.on('message', onMessage);
  pw.worker.on('error', onError);
  pw.worker.postMessage({ durationMs });
}

function drainQueue() {
  while (waitQueue.length > 0) {
    const pw = getOrCreatePoolWorker();
    if (!pw) break;
    const item = waitQueue.shift()!;
    dispatchToWorker(pw, item.durationMs, item.resolve, item.reject);
  }
}

// ─── Barrier protocol (local mode) ──────────────────────

function writeReady() {
  if (READY_FILE) {
    const dir = READY_FILE.substring(0, READY_FILE.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(READY_FILE, '1');
  }
}

async function waitForGo(): Promise<void> {
  if (!GO_FILE) return;
  while (!fs.existsSync(GO_FILE)) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── REST mode runner ────────────────────────────────────

async function runRestBalanced(httpSimPort: number): Promise<{ metrics: WorkerMetrics[]; wallClockS: number; stopReason: StopReason }> {
  const { createCamundaClient } = await import('@camunda8/orchestration-cluster-api');

  // Single shared client for this process — all WPP workers share it
  const client = createCamundaClient({
    config: {
      CAMUNDA_REST_ADDRESS: BROKER_REST_URL,
      CAMUNDA_SDK_LOG_LEVEL: 'error',
      CAMUNDA_SDK_BACKPRESSURE_PROFILE: 'BALANCED',
      CAMUNDA_OAUTH_DISABLED: true,
    } as any,
  });

  const workerMetrics: WorkerMetrics[] = Array.from({ length: NUM_WORKERS }, (_, i) => ({
    workerId: `${PROCESS_ID}-w${i}`,
    completed: 0,
    errors: 0,
  }));

  let done = false;
  const t0 = Date.now();
  const deadline = t0 + SCENARIO_TIMEOUT_S * 1000;
  const totalTarget = NUM_WORKERS * TARGET_PER_WORKER;

  // Create a single job worker with parallelism sized for all workers in this process
  const jobWorker = client.createJobWorker({
    jobType: 'test-job',
    maxParallelJobs: ACTIVATE_BATCH * NUM_WORKERS,
    jobTimeoutMs: 30_000,
    pollIntervalMs: 100,
    autoStart: true,
    validateSchemas: false,
    jobHandler: async (job) => {
      try {
        // Simulate work
        if (HANDLER_TYPE === 'cpu' && HANDLER_LATENCY_MS > 0) {
          cpuWork(HANDLER_LATENCY_MS);
        } else if (HANDLER_TYPE === 'http' && httpSimPort > 0) {
          await fetch(`http://127.0.0.1:${httpSimPort}/work`);
        }

        // Assign to worker with fewest completions (round-robin fairness)
        const minWorker = workerMetrics.reduce((a, b) =>
          a.completed < b.completed ? a : b
        );
        minWorker.completed++;

        const totalCompleted = workerMetrics.reduce((s, w) => s + w.completed, 0);
        if (totalCompleted >= totalTarget) done = true;

        return job.complete({ variables: { done: true } });
      } catch (err) {
        recordError(workerMetrics, err);
        throw err;
      }
    },
  });

  // Wait for completion, aggregator stop, or timeout
  const aggregator = createAggregatorChecker();
  while (!done && !aggregator.isStopped() && Date.now() < deadline) {
    const totalSoFar = workerMetrics.reduce((s, w) => s + w.completed, 0);
    aggregator.check(totalSoFar);
    await new Promise((r) => setTimeout(r, 50));
  }

  done = true;
  try { jobWorker.stop(); } catch { /* ignore */ }

  const wallClockS = (Date.now() - t0) / 1000;
  const finalCompleted = workerMetrics.reduce((s, w) => s + w.completed, 0);
  const stopReason: StopReason = finalCompleted >= totalTarget ? 'target' : aggregator.isStopped() ? 'pool-exhaustion' : 'timeout';
  return { metrics: workerMetrics, wallClockS, stopReason };
}

// ─── REST-threaded mode runner (CPU work on worker_threads) ──

async function runRestThreaded(httpSimPort: number): Promise<{ metrics: WorkerMetrics[]; wallClockS: number; stopReason: StopReason }> {
  const { createCamundaClient } = await import('@camunda8/orchestration-cluster-api');

  const client = createCamundaClient({
    config: {
      CAMUNDA_REST_ADDRESS: BROKER_REST_URL,
      CAMUNDA_SDK_LOG_LEVEL: 'error',
      CAMUNDA_SDK_BACKPRESSURE_PROFILE: 'BALANCED',
      CAMUNDA_OAUTH_DISABLED: true,
    } as any,
  });

  const workerMetrics: WorkerMetrics[] = Array.from({ length: NUM_WORKERS }, (_, i) => ({
    workerId: `${PROCESS_ID}-w${i}`,
    completed: 0,
    errors: 0,
  }));

  let done = false;
  const t0 = Date.now();
  const deadline = t0 + SCENARIO_TIMEOUT_S * 1000;
  const totalTarget = NUM_WORKERS * TARGET_PER_WORKER;

  const jobWorker = client.createJobWorker({
    jobType: 'test-job',
    maxParallelJobs: ACTIVATE_BATCH * NUM_WORKERS,
    jobTimeoutMs: 30_000,
    pollIntervalMs: 100,
    autoStart: true,
    validateSchemas: false,
    jobHandler: async (job) => {
      try {
        // Offload CPU work to a worker thread — keeps event loop free for polling
        if (HANDLER_TYPE === 'cpu' && HANDLER_LATENCY_MS > 0) {
          await cpuWorkThreaded(HANDLER_LATENCY_MS);
        } else if (HANDLER_TYPE === 'http' && httpSimPort > 0) {
          await fetch(`http://127.0.0.1:${httpSimPort}/work`);
        }

        const minWorker = workerMetrics.reduce((a, b) =>
          a.completed < b.completed ? a : b
        );
        minWorker.completed++;

        const totalCompleted = workerMetrics.reduce((s, w) => s + w.completed, 0);
        if (totalCompleted >= totalTarget) done = true;

        return job.complete({ variables: { done: true } });
      } catch (err) {
        recordError(workerMetrics, err);
        throw err;
      }
    },
  });

  const aggregator = createAggregatorChecker();
  while (!done && !aggregator.isStopped() && Date.now() < deadline) {
    const totalSoFar = workerMetrics.reduce((s, w) => s + w.completed, 0);
    aggregator.check(totalSoFar);
    await new Promise((r) => setTimeout(r, 50));
  }

  done = true;
  try { jobWorker.stop(); } catch { /* ignore */ }

  const wallClockS = (Date.now() - t0) / 1000;
  const finalCompleted = workerMetrics.reduce((s, w) => s + w.completed, 0);
  const stopReason: StopReason = finalCompleted >= totalTarget ? 'target' : aggregator.isStopped() ? 'pool-exhaustion' : 'timeout';
  return { metrics: workerMetrics, wallClockS, stopReason };
}

// ─── gRPC poll mode runner ───────────────────────────────

async function runGrpcPoll(httpSimPort: number): Promise<{ metrics: WorkerMetrics[]; wallClockS: number; stopReason: StopReason }> {
  const { Camunda8 } = await import('@camunda8/sdk');

  const c8 = new Camunda8({
    ZEEBE_GRPC_ADDRESS: BROKER_GRPC_URL,
    ZEEBE_REST_ADDRESS: BROKER_REST_URL,
    CAMUNDA_OAUTH_DISABLED: true,
    CAMUNDA_SECURE_CONNECTION: false,
  } as any);

  const zeebe = c8.getZeebeGrpcApiClient();

  const workerMetrics: WorkerMetrics[] = Array.from({ length: NUM_WORKERS }, (_, i) => ({
    workerId: `${PROCESS_ID}-w${i}`,
    completed: 0,
    errors: 0,
  }));

  let done = false;
  const t0 = Date.now();
  const deadline = t0 + SCENARIO_TIMEOUT_S * 1000;
  const totalTarget = NUM_WORKERS * TARGET_PER_WORKER;

  // Single gRPC polling worker sized for all workers in this process
  const worker = zeebe.createWorker({
    taskType: 'test-job',
    taskHandler: async (job) => {
      try {
        if (HANDLER_TYPE === 'cpu' && HANDLER_LATENCY_MS > 0) {
          cpuWork(HANDLER_LATENCY_MS);
        } else if (HANDLER_TYPE === 'http' && httpSimPort > 0) {
          await fetch(`http://127.0.0.1:${httpSimPort}/work`);
        }

        // Round-robin assignment
        const minWorker = workerMetrics.reduce((a, b) =>
          a.completed < b.completed ? a : b
        );
        minWorker.completed++;

        const totalCompleted = workerMetrics.reduce((s, w) => s + w.completed, 0);
        if (totalCompleted >= totalTarget) done = true;

        return job.complete({});
      } catch (err) {
        recordError(workerMetrics, err);
        throw err;
      }
    },
    maxJobsToActivate: ACTIVATE_BATCH * NUM_WORKERS,
    timeout: 30_000,
    pollInterval: 100,
  });

  const aggregator = createAggregatorChecker();
  while (!done && !aggregator.isStopped() && Date.now() < deadline) {
    const totalSoFar = workerMetrics.reduce((s, w) => s + w.completed, 0);
    aggregator.check(totalSoFar);
    await new Promise((r) => setTimeout(r, 50));
  }

  done = true;
  try { await zeebe.close(); } catch { /* ignore */ }

  const wallClockS = (Date.now() - t0) / 1000;
  const finalCompleted = workerMetrics.reduce((s, w) => s + w.completed, 0);
  const stopReason: StopReason = finalCompleted >= totalTarget ? 'target' : aggregator.isStopped() ? 'pool-exhaustion' : 'timeout';
  return { metrics: workerMetrics, wallClockS, stopReason };
}

// ─── gRPC stream mode runner ─────────────────────────────

async function runGrpcStream(httpSimPort: number): Promise<{ metrics: WorkerMetrics[]; wallClockS: number; stopReason: StopReason }> {
  const { Camunda8 } = await import('@camunda8/sdk');

  const c8 = new Camunda8({
    ZEEBE_GRPC_ADDRESS: BROKER_GRPC_URL,
    ZEEBE_REST_ADDRESS: BROKER_REST_URL,
    CAMUNDA_OAUTH_DISABLED: true,
    CAMUNDA_SECURE_CONNECTION: false,
  } as any);

  const zeebe = c8.getZeebeGrpcApiClient();

  const workerMetrics: WorkerMetrics[] = Array.from({ length: NUM_WORKERS }, (_, i) => ({
    workerId: `${PROCESS_ID}-w${i}`,
    completed: 0,
    errors: 0,
  }));

  let done = false;
  const t0 = Date.now();
  const deadline = t0 + SCENARIO_TIMEOUT_S * 1000;
  const totalTarget = NUM_WORKERS * TARGET_PER_WORKER;

  // Single gRPC streaming worker sized for all workers in this process
  const worker = await zeebe.streamJobs({
    type: 'test-job',
    taskHandler: async (job) => {
      try {
        if (HANDLER_TYPE === 'cpu' && HANDLER_LATENCY_MS > 0) {
          cpuWork(HANDLER_LATENCY_MS);
        } else if (HANDLER_TYPE === 'http' && httpSimPort > 0) {
          await fetch(`http://127.0.0.1:${httpSimPort}/work`);
        }

        // Round-robin assignment
        const minWorker = workerMetrics.reduce((a, b) =>
          a.completed < b.completed ? a : b
        );
        minWorker.completed++;

        const totalCompleted = workerMetrics.reduce((s, w) => s + w.completed, 0);
        if (totalCompleted >= totalTarget) done = true;

        return job.complete({});
      } catch (err) {
        recordError(workerMetrics, err);
        throw err;
      }
    },
    pollMaxJobsToActivate: ACTIVATE_BATCH * NUM_WORKERS,
    timeout: 30_000,
    tenantIds: ['<default>'],
    worker: `${PROCESS_ID}-stream`,
  });

  const aggregator = createAggregatorChecker();
  while (!done && !aggregator.isStopped() && Date.now() < deadline) {
    const totalSoFar = workerMetrics.reduce((s, w) => s + w.completed, 0);
    aggregator.check(totalSoFar);
    await new Promise((r) => setTimeout(r, 50));
  }

  done = true;
  try { await worker.close(); } catch { /* ignore */ }
  try { await zeebe.close(); } catch { /* ignore */ }

  const wallClockS = (Date.now() - t0) / 1000;
  const finalCompleted = workerMetrics.reduce((s, w) => s + w.completed, 0);
  const stopReason: StopReason = finalCompleted >= totalTarget ? 'target' : aggregator.isStopped() ? 'pool-exhaustion' : 'timeout';
  return { metrics: workerMetrics, wallClockS, stopReason };
}

// ─── Memory sampling ─────────────────────────────────────

const memorySamples: number[] = [];
let memorySamplerInterval: ReturnType<typeof setInterval> | undefined;

function startMemorySampler() {
  // Sample immediately, then every 5 seconds
  memorySamples.push(process.memoryUsage.rss());
  memorySamplerInterval = setInterval(() => {
    memorySamples.push(process.memoryUsage.rss());
  }, 5_000);
}

function stopMemorySampler(): { peakRssMb: number; avgRssMb: number; samples: number } {
  if (memorySamplerInterval) clearInterval(memorySamplerInterval);
  // Take a final sample
  memorySamples.push(process.memoryUsage.rss());
  const peakRssMb = Math.max(...memorySamples) / (1024 * 1024);
  const avgRssMb = memorySamples.reduce((a, b) => a + b, 0) / memorySamples.length / (1024 * 1024);
  return { peakRssMb: Math.round(peakRssMb * 10) / 10, avgRssMb: Math.round(avgRssMb * 10) / 10, samples: memorySamples.length };
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log(`[worker-process] id=${PROCESS_ID} mode=${SDK_MODE} handler=${HANDLER_TYPE} workers=${NUM_WORKERS}`);
  console.log(`[worker-process] target=${TARGET_PER_WORKER}/worker broker=${BROKER_REST_URL}`);

  let httpSimPort = 0;
  if (HANDLER_TYPE === 'http' && HANDLER_LATENCY_MS > 0) {
    httpSimPort = await startHttpSimServer(HANDLER_LATENCY_MS);
  }

  // Signal ready (barrier protocol)
  writeReady();
  await waitForGo();

  console.log(`[worker-process] GO received, starting benchmark...`);

  startMemorySampler();

  let result: { metrics: WorkerMetrics[]; wallClockS: number; stopReason: StopReason };

  if (SDK_MODE === 'grpc-streaming') {
    result = await runGrpcStream(httpSimPort);
  } else if (SDK_MODE === 'grpc-polling') {
    result = await runGrpcPoll(httpSimPort);
  } else if (SDK_MODE === 'rest-threaded') {
    result = await runRestThreaded(httpSimPort);
  } else {
    result = await runRestBalanced(httpSimPort);
  }

  if (httpSimServer) httpSimServer.close();

  const memoryUsage = stopMemorySampler();

  // Compute aggregates
  const totalCompleted = result.metrics.reduce((s, w) => s + w.completed, 0);
  const totalErrors = result.metrics.reduce((s, w) => s + w.errors, 0);
  const throughput = result.wallClockS > 0 ? totalCompleted / result.wallClockS : 0;

  // Sort errorTypes by count descending
  const sortedErrorTypes = Object.fromEntries(
    Object.entries(errorTypes).sort(([, a], [, b]) => b - a)
  );

  const output = {
    processId: PROCESS_ID,
    sdkMode: SDK_MODE,
    handlerType: HANDLER_TYPE,
    workersInProcess: NUM_WORKERS,
    totalCompleted,
    totalErrors,
    wallClockS: result.wallClockS,
    throughput,
    stopReason: result.stopReason,
    perWorkerCompleted: result.metrics.map((w) => w.completed),
    perWorkerErrors: result.metrics.map((w) => w.errors),
    perWorkerThroughputs: result.metrics.map((w) =>
      result.wallClockS > 0 ? w.completed / result.wallClockS : 0
    ),
    errorTypes: sortedErrorTypes,
    memoryUsage,
  };

  const errorTypeCount = Object.keys(sortedErrorTypes).length;
  console.log(`[worker-process] Done: ${totalCompleted} completed, ${totalErrors} errors (${errorTypeCount} types), ${throughput.toFixed(1)} ops/s`);
  if (errorTypeCount > 0) {
    const top = Object.entries(sortedErrorTypes).slice(0, 5);
    for (const [key, count] of top) {
      console.log(`[worker-process]   ${count}× ${key}`);
    }
  }

  // Write result
  fs.writeFileSync(RESULT_FILE, JSON.stringify(output, null, 2));
  console.log(`[worker-process] Result written to ${RESULT_FILE}`);

  process.exit(0);
}

// Only run main() on the main thread — worker threads exit after cpuWork above
if (isMainThread) {
  main().catch((err) => {
    console.error(`[worker-process] Fatal error:`, err);

    // Write error result so orchestrator doesn't hang
    fs.writeFileSync(
      RESULT_FILE,
      JSON.stringify({
        processId: PROCESS_ID,
        sdkMode: SDK_MODE,
        handlerType: HANDLER_TYPE,
        workersInProcess: NUM_WORKERS,
        totalCompleted: 0,
        totalErrors: 0,
        wallClockS: 0,
        throughput: 0,
        perWorkerCompleted: [],
        perWorkerErrors: [],
        perWorkerThroughputs: [],
        error: String(err),
      }, null, 2)
    );

    process.exit(1);
  });
}
